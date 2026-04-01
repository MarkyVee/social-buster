/**
 * agents/hookPerformanceAgent.js
 *
 * Layer 1 Learning Agent — Hook Format Performance Analysis.
 *
 * WHAT THIS DOES:
 * Looks at every published post from the last 60 days, classifies each
 * post's hook into one of 6 format categories, then calculates which
 * formats consistently outperform the user's own average engagement rate.
 *
 * The result is stored as multipliers in user_profiles.signal_weights:
 *   { "hook_formats": { "question": 2.1, "curiosity": 1.6, "statement": 0.9 } }
 *
 * A value of 2.1 means "question hooks get 2.1x this user's average engagement."
 * A value of 0.7 means "story hooks underperform this user's average by 30%."
 *
 * contextBuilder reads these weights and injects them into every LLM brief
 * generation prompt — so the AI naturally leans toward what works for THIS
 * user's audience without the user ever having to explain it.
 *
 * HOOK FORMAT CATEGORIES (6 types):
 *   question   — ends with "?" (e.g. "Are you making this mistake?")
 *   list       — starts with a number (e.g. "5 ways to grow faster")
 *   story      — starts with I/We/My, first-person past-tense narrative
 *   challenge  — starts with Stop/Don't/Never (pattern interrupt)
 *   curiosity  — open-loop, secret/truth/nobody framing
 *   statement  — everything else (declarative, bold assertion)
 *
 * MINIMUM DATA REQUIREMENTS:
 *   — At least 5 posts with metrics before we run analysis (avoids noise)
 *   — At least 3 posts per format before we weight that format
 *   — Both requirements prevent spurious weights from tiny samples
 *
 * ENGAGEMENT SCORE FORMULA:
 *   score = (likes + comments×2 + shares×3) / max(reach, 1) × 100
 *   Comments and shares are weighted higher because they signal stronger
 *   audience response than a passive like. Divided by reach so large
 *   accounts don't dominate the average.
 *
 * Triggered by: signalWeightsWorker.js (weekly, same cadence as researchAgent)
 */

const { supabaseAdmin } = require('../services/supabaseService');

// Minimum posts with metrics before we run analysis (avoids noisy weights)
const MIN_POSTS_FOR_ANALYSIS = 5;

// Minimum posts per hook format before we include that format in weights
// (e.g. 1 question hook that went viral shouldn't make every post a question)
const MIN_POSTS_PER_FORMAT = 3;

// ----------------------------------------------------------------
// classifyHook — maps a hook string to one of 6 format categories.
// Order matters: more specific patterns are tested first.
// ----------------------------------------------------------------
function classifyHook(hookText) {
  if (!hookText || !hookText.trim()) return 'unknown';
  const text = hookText.trim();

  // List: starts with a digit followed by common count nouns
  if (/^\d+\s+(ways?|tips?|reasons?|steps?|things?|secrets?|mistakes?|hacks?|signs?|rules?)/i.test(text)) {
    return 'list';
  }

  // Challenge: starts with a pattern-interrupt command
  if (/^(Stop|Don't|Never|Quit|Avoid|Forget|Drop|Ditch|Kill)\b/i.test(text)) {
    return 'challenge';
  }

  // Question: ends with "?" (handles multi-sentence hooks ending in ?)
  if (text.endsWith('?')) {
    return 'question';
  }

  // Curiosity / open-loop: signals that withhold information to force a read
  if (/\.\.\.|secret|the truth|nobody (tells?|talks?|knows?)|most people|real reason|what (they|no one|nobody)|unpopular opinion|this changed|you won't believe/i.test(text)) {
    return 'curiosity';
  }

  // Story: starts with first-person pronoun or past-tense narrative opener
  if (/^(I |We |My |Our |Last (year|month|week|night)|[0-9]+ (years?|months?) ago|When I|The day I)/i.test(text)) {
    return 'story';
  }

  // Default: bold statement / declarative assertion
  return 'statement';
}

// ----------------------------------------------------------------
// calcEngagementScore — weighted engagement rate for a single post.
// Returns a percentage (0–100+). Normalised by reach so virality
// on a small account is treated the same as virality on a big one.
// ----------------------------------------------------------------
function calcEngagementScore(likes, comments, shares, reach) {
  if (!reach || reach === 0) return 0;
  return ((likes + comments * 2 + shares * 3) / reach) * 100;
}

// ----------------------------------------------------------------
// runHookPerformanceAnalysis — main export.
// Analyses one user's hook performance and writes to signal_weights.
// ----------------------------------------------------------------
async function runHookPerformanceAnalysis(userId) {
  console.log(`[HookPerformanceAgent] Analysing hooks for user ${userId}...`);

  // Look back 60 days — long enough for enough data, short enough to
  // reflect current audience behaviour (not 6-month-old trends)
  const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

  // --- Step 1: Get published posts with hooks ---
  const { data: posts, error: postsErr } = await supabaseAdmin
    .from('posts')
    .select('id, hook')
    .eq('user_id', userId)
    .eq('status', 'published')
    .gte('published_at', cutoff)
    .not('hook', 'is', null);

  if (postsErr || !posts || posts.length < MIN_POSTS_FOR_ANALYSIS) {
    console.log(`[HookPerformanceAgent] Not enough data for ${userId} (${posts?.length || 0} posts). Skipping.`);
    return;
  }

  // --- Step 2: Fetch metrics for these posts ---
  const postIds = posts.map(p => p.id);
  const { data: metrics, error: metricsErr } = await supabaseAdmin
    .from('post_metrics')
    .select('post_id, likes, comments, shares, reach')
    .in('post_id', postIds);

  if (metricsErr || !metrics || metrics.length === 0) {
    console.log(`[HookPerformanceAgent] No metrics yet for ${userId}. Skipping.`);
    return;
  }

  // --- Step 3: Build averaged metrics map (multiple polls per post → average them) ---
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

  // --- Step 4: Score each post and group by hook format ---
  const formatBuckets = {}; // { format: { total: number, count: number } }
  let grandTotal = 0;
  let postsScored = 0;

  posts.forEach(post => {
    const m = metricsMap[post.id];
    if (!m || m.count === 0) return;

    // Average the metric rows
    const avgLikes    = m.likes    / m.count;
    const avgComments = m.comments / m.count;
    const avgShares   = m.shares   / m.count;
    const avgReach    = m.reach    / m.count;

    const score  = calcEngagementScore(avgLikes, avgComments, avgShares, avgReach);
    const format = classifyHook(post.hook);

    if (format === 'unknown') return; // Skip posts with empty hooks

    if (!formatBuckets[format]) formatBuckets[format] = { total: 0, count: 0 };
    formatBuckets[format].total += score;
    formatBuckets[format].count++;

    grandTotal += score;
    postsScored++;
  });

  if (postsScored < MIN_POSTS_FOR_ANALYSIS) {
    console.log(`[HookPerformanceAgent] Only ${postsScored} posts had metrics for ${userId}. Skipping.`);
    return;
  }

  const overallAvg = grandTotal / postsScored;
  if (overallAvg === 0) return; // All engagement is zero — platform API likely hasn't returned data yet

  // --- Step 5: Calculate relative multiplier per format ---
  // 1.0 = exactly this user's average
  // 2.1 = 2.1x better than their average
  // 0.7 = 30% worse than their average
  const hookWeights = {};

  for (const [format, bucket] of Object.entries(formatBuckets)) {
    if (bucket.count >= MIN_POSTS_PER_FORMAT) {
      const formatAvg    = bucket.total / bucket.count;
      const multiplier   = parseFloat((formatAvg / overallAvg).toFixed(2));
      hookWeights[format] = multiplier;
    }
  }

  if (Object.keys(hookWeights).length === 0) {
    console.log(`[HookPerformanceAgent] No formats had enough posts (need ${MIN_POSTS_PER_FORMAT}) for ${userId}. Skipping.`);
    return;
  }

  // --- Step 6: Merge into user_profiles.signal_weights ---
  // Read current value first so we don't wipe other agents' data
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
    hook_formats:             hookWeights,
    hook_formats_updated_at:  new Date().toISOString(),
    hook_post_count:          postsScored
  };

  const { error: updateErr } = await supabaseAdmin
    .from('user_profiles')
    .update({ signal_weights: updated })
    .eq('user_id', userId);

  if (updateErr) {
    console.error(`[HookPerformanceAgent] Failed to save weights for ${userId}:`, updateErr.message);
    return;
  }

  // Log the top formats so ops can monitor the learning engine
  const top = Object.entries(hookWeights)
    .sort((a, b) => b[1] - a[1])
    .map(([f, w]) => `${f}=${w}x`)
    .join(', ');

  console.log(`[HookPerformanceAgent] ${userId} — ${postsScored} posts scored. Top formats: ${top}`);
}

module.exports = { runHookPerformanceAnalysis, classifyHook };
