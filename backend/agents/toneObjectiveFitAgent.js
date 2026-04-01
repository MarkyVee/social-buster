/**
 * agents/toneObjectiveFitAgent.js
 *
 * Layer 1 Learning Agent — Tone × Objective Fit Analysis.
 *
 * WHAT THIS DOES:
 * Every brief a user submits has a tone (e.g. "humorous") and an objective
 * (e.g. "conversions"). This agent asks: when a user COMBINED those two
 * choices, did the post actually achieve strong engagement — or did that
 * pairing underperform?
 *
 * For example, it might discover:
 *   bold + conversions     = 1.8x this user's average → great combo, use it
 *   friendly + engagement  = 1.4x average             → solid
 *   humorous + conversions = 0.4x average             → avoid for conversion goals
 *
 * The result is stored as multipliers in user_profiles.signal_weights:
 *   { "tone_objective_fit": { "bold_conversions": 1.8, "humorous_conversions": 0.4 } }
 *
 * contextBuilder reads these and injects them into the LLM brief prompt as
 * a "WHAT WORKS FOR YOU" section — so the AI naturally steers toward proven
 * combos and warns about underperforming ones.
 *
 * WHY THIS MATTERS FOR PACKAGING:
 * This data can also power the Brief Preflight Panel — showing the user before
 * they generate: "Warning: humorous + conversions gets 0.4x for your audience.
 * Try bold + conversions instead." This is a Starter+ feature gate opportunity.
 *
 * DATA PIPELINE:
 *   posts (published, last 60 days)
 *     → look up brief_id on each post
 *     → fetch briefs.tone + briefs.objective for those IDs
 *     → fetch post_metrics for engagement data
 *     → group by tone+objective key
 *     → calculate avg engagement vs user's overall average
 *     → write multipliers to signal_weights.tone_objective_fit
 *
 * MINIMUM DATA REQUIREMENTS:
 *   — At least 5 posts with both brief and metric data to run
 *   — At least 2 posts per tone+objective combination to include it
 *     (prevents a single viral post from skewing a combo's score)
 *
 * Triggered by: signalWeightsWorker.js (weekly)
 */

const { supabaseAdmin }       = require('../services/supabaseService');
const { getAgentDirective }   = require('../services/agentDirectiveService');

const MIN_POSTS_FOR_ANALYSIS = 5;
const MIN_POSTS_PER_COMBO    = 2;

// ----------------------------------------------------------------
// calcEngagementScore — same formula as hookPerformanceAgent.
// Kept local so agents are self-contained and independently testable.
// ----------------------------------------------------------------
function calcEngagementScore(likes, comments, shares, reach) {
  if (!reach || reach === 0) return 0;
  return ((likes + comments * 2 + shares * 3) / reach) * 100;
}

// ----------------------------------------------------------------
// runToneObjectiveFitAnalysis — main export.
// Analyses one user's tone×objective combinations and writes weights.
// ----------------------------------------------------------------
async function runToneObjectiveFitAnalysis(userId) {
  console.log(`[ToneObjectiveFitAgent] Analysing tone/objective fit for user ${userId}...`);

  const directive = await getAgentDirective('toneObjectiveFitAgent', userId);

  const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

  // --- Step 1: Get published posts that came from a brief ---
  const { data: posts, error: postsErr } = await supabaseAdmin
    .from('posts')
    .select('id, brief_id')
    .eq('user_id', userId)
    .eq('status', 'published')
    .gte('published_at', cutoff)
    .not('brief_id', 'is', null);

  if (postsErr || !posts || posts.length < MIN_POSTS_FOR_ANALYSIS) {
    console.log(`[ToneObjectiveFitAgent] Not enough data for ${userId}. Skipping.`);
    return;
  }

  // --- Step 2: Fetch the briefs for those posts ---
  // Separate query (safer than PostgREST join — no FK relationship dependency)
  const briefIds = [...new Set(posts.map(p => p.brief_id).filter(Boolean))];

  const { data: briefs, error: briefsErr } = await supabaseAdmin
    .from('briefs')
    .select('id, tone, objective, post_type')
    .in('id', briefIds);

  if (briefsErr || !briefs || briefs.length === 0) {
    console.log(`[ToneObjectiveFitAgent] Could not load briefs for ${userId}. Skipping.`);
    return;
  }

  // Build a quick lookup map: brief_id → { tone, objective, post_type }
  const briefMap = {};
  briefs.forEach(b => { briefMap[b.id] = b; });

  // --- Step 3: Fetch post metrics ---
  const postIds = posts.map(p => p.id);
  const { data: metrics, error: metricsErr } = await supabaseAdmin
    .from('post_metrics')
    .select('post_id, likes, comments, shares, reach')
    .in('post_id', postIds);

  if (metricsErr || !metrics || metrics.length === 0) {
    console.log(`[ToneObjectiveFitAgent] No metrics yet for ${userId}. Skipping.`);
    return;
  }

  // Average multiple metric rows per post (performanceAgent polls repeatedly)
  const metricsMap = {};
  metrics.forEach(m => {
    if (!metricsMap[m.post_id]) {
      metricsMap[m.post_id] = { likes: 0, comments: 0, shares: 0, reach: 0, count: 0 };
    }
    metricsMap[m.post_id].likes    += (m.likes    || 0);
    metricsMap[m.post_id].comments += (m.comments || 0);
    metricsMap[m.post_id].shares   += (m.shares   || 0);
    metricsMap[m.post_id].reach    += (m.reach    || 0);
    metricsMap[m.post_id].count++;
  });

  // --- Step 4: Score each post and group by tone+objective ---
  const comboBuckets = {}; // { "bold_conversions": { total, count } }
  let grandTotal  = 0;
  let postsScored = 0;

  posts.forEach(post => {
    const brief = briefMap[post.brief_id];
    const m     = metricsMap[post.id];

    if (!brief || !m || m.count === 0) return;
    if (!brief.tone || !brief.objective) return;

    const avgLikes    = m.likes    / m.count;
    const avgComments = m.comments / m.count;
    const avgShares   = m.shares   / m.count;
    const avgReach    = m.reach    / m.count;

    const score = calcEngagementScore(avgLikes, avgComments, avgShares, avgReach);
    const key   = `${brief.tone}_${brief.objective}`;

    if (!comboBuckets[key]) {
      comboBuckets[key] = { total: 0, count: 0, tone: brief.tone, objective: brief.objective };
    }
    comboBuckets[key].total += score;
    comboBuckets[key].count++;

    grandTotal += score;
    postsScored++;
  });

  if (postsScored < MIN_POSTS_FOR_ANALYSIS) {
    console.log(`[ToneObjectiveFitAgent] Only ${postsScored} posts had both brief and metric data for ${userId}. Skipping.`);
    return;
  }

  const overallAvg = grandTotal / postsScored;
  if (overallAvg === 0) return;

  // --- Step 5: Calculate multipliers per combination ---
  const toneObjectiveWeights = {};

  for (const [key, bucket] of Object.entries(comboBuckets)) {
    if (bucket.count >= MIN_POSTS_PER_COMBO) {
      const comboAvg   = bucket.total / bucket.count;
      const multiplier = parseFloat((comboAvg / overallAvg).toFixed(2));
      toneObjectiveWeights[key] = multiplier;
    }
  }

  if (Object.keys(toneObjectiveWeights).length === 0) {
    console.log(`[ToneObjectiveFitAgent] No combos had enough posts (need ${MIN_POSTS_PER_COMBO}) for ${userId}. Skipping.`);
    return;
  }

  // --- Step 6: Merge into signal_weights (preserve other agents' data) ---
  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('signal_weights')
    .eq('user_id', userId)
    .single();

  const current = (profile?.signal_weights && typeof profile.signal_weights === 'object')
    ? profile.signal_weights
    : {};

  const updated = {
    ...current,
    tone_objective_fit:           toneObjectiveWeights,
    tone_objective_updated_at:    new Date().toISOString(),
    ...(directive ? { agent_directive_tone: directive } : {})
  };

  const { error: updateErr } = await supabaseAdmin
    .from('user_profiles')
    .update({ signal_weights: updated })
    .eq('user_id', userId);

  if (updateErr) {
    console.error(`[ToneObjectiveFitAgent] Failed to save weights for ${userId}:`, updateErr.message);
    return;
  }

  // Log top and bottom combos for ops visibility
  const sorted = Object.entries(toneObjectiveWeights).sort((a, b) => b[1] - a[1]);
  const top    = sorted.slice(0, 3).map(([k, v]) => `${k}=${v}x`).join(', ');
  const bottom = sorted.slice(-2).map(([k, v]) => `${k}=${v}x`).join(', ');

  console.log(`[ToneObjectiveFitAgent] ${userId} — ${postsScored} posts. Top: ${top} | Weak: ${bottom}`);
}

module.exports = { runToneObjectiveFitAnalysis };
