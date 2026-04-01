/**
 * agents/hookTrendAgent.js
 *
 * Layer 2 Learning Agent — Hook Format Trend Detection.
 *
 * WHAT THIS DOES:
 * hookPerformanceAgent tells you which hook formats have performed best
 * OVERALL in the last 60 days. This agent asks the next question: is
 * performance on a given format going UP or DOWN over time?
 *
 * An audience that loved question hooks six months ago might be fatigued
 * by them now. Or a format the user has never tried much (curiosity hooks)
 * might be quietly gaining traction. Neither signal shows up in an overall
 * average — you need the trend.
 *
 * HOW IT WORKS:
 * Splits the 60-day window into two equal halves:
 *   — "prior"  period: days 31–60 ago (the baseline)
 *   — "recent" period: days 0–30 ago  (the current state)
 *
 * For each hook format that has enough posts in BOTH periods, it calculates
 * the average engagement score per period and computes a trend ratio:
 *   trend_ratio = recent_avg / prior_avg
 *
 * Interpretation:
 *   ratio > 1.15  → trending UP   (recent 15%+ better than prior)
 *   ratio < 0.85  → trending DOWN (recent 15%+ worse than prior)
 *   0.85–1.15     → stable        (within noise margin)
 *
 * WHAT IT WRITES (signal_weights.hook_trends):
 *   {
 *     "hook_trends": {
 *       "question":  { "direction": "up",     "ratio": 1.32, "recent_avg": 4.1, "prior_avg": 3.1 },
 *       "list":      { "direction": "down",   "ratio": 0.71, "recent_avg": 2.2, "prior_avg": 3.1 },
 *       "curiosity": { "direction": "stable", "ratio": 1.04, "recent_avg": 3.6, "prior_avg": 3.5 }
 *     }
 *   }
 *
 * WHAT THE LLM SEES (via contextBuilder):
 *   HOOK FORMAT TRENDS (momentum over last 60 days):
 *   ↑ question hooks: gaining traction (1.32x recent vs prior)  ← momentum building
 *   ↓ list hooks: losing traction (0.71x recent vs prior)  ← avoid for now
 *   → curiosity hooks: stable
 *
 * WHY THE 15% THRESHOLD:
 * Small datasets (10–30 posts per format) have high variance. Flagging
 * anything outside 15% prevents treating normal fluctuation as a trend.
 * Once users have larger post histories this could be tightened.
 *
 * MINIMUM DATA:
 *   — 3 posts per format per period to compute that period's average
 *     (both periods must qualify — a format with data only in "recent"
 *      has no baseline to trend against and is skipped)
 *
 * REUSES: classifyHook from hookPerformanceAgent (same classification logic)
 *         calcEngagementScore from hookPerformanceAgent (same formula)
 *
 * Triggered by: signalWeightsWorker.js (weekly, after hookPerformanceAgent)
 */

const { supabaseAdmin }       = require('../services/supabaseService');
const { getAgentDirective }   = require('../services/agentDirectiveService');
const { classifyHook }        = require('./hookPerformanceAgent');

const MIN_POSTS_PER_PERIOD = 3;   // Per format per period
const TREND_UP_THRESHOLD   = 1.15;
const TREND_DOWN_THRESHOLD = 0.85;

// ----------------------------------------------------------------
// calcEngagementScore — same formula as all other Layer 1/2 agents.
// Inlined here so this agent has no circular dependency issues.
// ----------------------------------------------------------------
function calcEngagementScore(likes, comments, shares, reach) {
  if (!reach || reach === 0) return 0;
  return ((likes + comments * 2 + shares * 3) / reach) * 100;
}

// ----------------------------------------------------------------
// runHookTrendAnalysis — main export.
// ----------------------------------------------------------------
async function runHookTrendAnalysis(userId) {
  console.log(`[HookTrendAgent] Analysing hook trends for user ${userId}...`);

  const directive = await getAgentDirective('hookTrendAgent', userId);

  const now         = Date.now();
  const recentStart = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
  const priorStart  = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString(); // 60 days ago
  // prior period  = priorStart  → recentStart
  // recent period = recentStart → now

  // --- Step 1: Published posts with hooks in last 60 days ---
  const { data: posts, error: postsErr } = await supabaseAdmin
    .from('posts')
    .select('id, hook, published_at')
    .eq('user_id', userId)
    .eq('status', 'published')
    .gte('published_at', priorStart)
    .not('hook', 'is', null);

  if (postsErr || !posts || posts.length === 0) {
    console.log(`[HookTrendAgent] No posts for ${userId}. Skipping.`);
    return;
  }

  // --- Step 2: Fetch metrics ---
  const postIds = posts.map(p => p.id);
  const { data: metrics, error: metricsErr } = await supabaseAdmin
    .from('post_metrics')
    .select('post_id, likes, comments, shares, reach')
    .in('post_id', postIds);

  if (metricsErr || !metrics || metrics.length === 0) {
    console.log(`[HookTrendAgent] No metrics for ${userId}. Skipping.`);
    return;
  }

  // Average multiple metric rows per post
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

  // --- Step 3: Score and bucket each post into prior vs recent period ---
  // periodBuckets[period][format] = { total: score sum, count: post count }
  const periodBuckets = { prior: {}, recent: {} };

  posts.forEach(post => {
    const m = metricsMap[post.id];
    if (!m || m.count === 0) return;

    const avgLikes    = m.likes    / m.count;
    const avgComments = m.comments / m.count;
    const avgShares   = m.shares   / m.count;
    const avgReach    = m.reach    / m.count;

    const score  = calcEngagementScore(avgLikes, avgComments, avgShares, avgReach);
    const format = classifyHook(post.hook);
    if (format === 'unknown') return;

    // Assign to period based on published_at
    const period = post.published_at >= recentStart ? 'recent' : 'prior';

    if (!periodBuckets[period][format]) {
      periodBuckets[period][format] = { total: 0, count: 0 };
    }
    periodBuckets[period][format].total += score;
    periodBuckets[period][format].count++;
  });

  // --- Step 4: Compute trend ratios for formats with data in both periods ---
  const hookTrends = {};

  const allFormats = new Set([
    ...Object.keys(periodBuckets.prior),
    ...Object.keys(periodBuckets.recent)
  ]);

  for (const format of allFormats) {
    const priorBucket  = periodBuckets.prior[format];
    const recentBucket = periodBuckets.recent[format];

    // Both periods must have enough posts to call a trend
    if (!priorBucket  || priorBucket.count  < MIN_POSTS_PER_PERIOD) continue;
    if (!recentBucket || recentBucket.count < MIN_POSTS_PER_PERIOD) continue;

    const priorAvg  = priorBucket.total  / priorBucket.count;
    const recentAvg = recentBucket.total / recentBucket.count;

    if (priorAvg === 0) continue; // Can't compute ratio against zero baseline

    const ratio = Math.round((recentAvg / priorAvg) * 100) / 100; // 2 decimal places

    const direction = ratio >= TREND_UP_THRESHOLD
      ? 'up'
      : ratio <= TREND_DOWN_THRESHOLD
        ? 'down'
        : 'stable';

    hookTrends[format] = {
      direction,
      ratio,
      recent_avg: Math.round(recentAvg * 100) / 100,
      prior_avg:  Math.round(priorAvg  * 100) / 100
    };
  }

  if (Object.keys(hookTrends).length === 0) {
    console.log(`[HookTrendAgent] Not enough per-format per-period data for ${userId}. Skipping.`);
    return;
  }

  // --- Step 5: Merge into signal_weights ---
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
    hook_trends:             hookTrends,
    hook_trends_updated_at:  new Date().toISOString(),
    ...(directive ? { agent_directive_hook_trend: directive } : {})
  };

  const { error: updateErr } = await supabaseAdmin
    .from('user_profiles')
    .update({ signal_weights: updated })
    .eq('user_id', userId);

  if (updateErr) {
    console.error(`[HookTrendAgent] Failed to save for ${userId}:`, updateErr.message);
    return;
  }

  const trending = Object.entries(hookTrends)
    .filter(([, v]) => v.direction !== 'stable')
    .map(([f, v]) => `${f}:${v.direction}(${v.ratio}x)`)
    .join(', ') || 'all stable';

  console.log(`[HookTrendAgent] ${userId} — ${Object.keys(hookTrends).length} formats tracked | Trends: ${trending}`);
}

module.exports = { runHookTrendAnalysis };
