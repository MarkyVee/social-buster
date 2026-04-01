/**
 * agents/platformAlgorithmAgent.js
 *
 * Layer 3 Learning Agent — Platform Algorithm Shift Detection.
 *
 * WHAT THIS DOES:
 * Detects when a social platform's algorithm has changed in a way that
 * affects an entire cohort of users — not just one person's content.
 *
 * This is the key distinction: if YOUR reach drops, it might be your content.
 * If 70% of everyone in your industry niche on Instagram sees declining reach
 * simultaneously, that's the algorithm. No individual user can see that signal
 * on their own. Only a platform with collective data can.
 *
 * This is the centerpiece of the Enterprise tier value proposition.
 *
 * TWO SIGNALS DETECTED:
 *
 * ─────────────────────────────────────────────────────────────────
 * Signal 1: REACH SUPPRESSION (time-series, cross-user)
 * ─────────────────────────────────────────────────────────────────
 * Queries post_metrics for ALL users in the same cohort (same industry
 * + platform) across two 30-day windows.
 *
 * For each cohort member:
 *   reach_trend = recent_30day_avg_reach / prior_30day_avg_reach
 *
 * If > SUPPRESS_QUORUM (60%) of cohort members have a reach_trend
 * below SUPPRESS_THRESHOLD (0.80 = 20%+ decline), emit a suppression alert.
 *
 * Severity:
 *   high    → > 80% affected AND avg decline > 30%
 *   medium  → > 60% affected OR avg decline > 20%
 *   low     → detected but below medium thresholds
 *
 * WHY THIS WORKS: Individual content quality problems are random — they
 * don't cluster. Algorithm changes affect everyone in a cohort simultaneously.
 * A 60% quorum requirement filters out random variance.
 *
 * ─────────────────────────────────────────────────────────────────
 * Signal 2: FORMAT BOOST / PENALTY (cross-sectional)
 * ─────────────────────────────────────────────────────────────────
 * Reads cohort_performance for all post_types in this cohort. Computes
 * each type's engagement rate relative to the cohort's ALL-post baseline.
 *
 * If a post_type's avg engagement is >= FORMAT_BOOST_RATIO (2.0x) the
 * baseline → algorithm is actively boosting that format.
 * If <= FORMAT_PENALTY_RATIO (0.5x) → algorithm is penalising it.
 *
 * Example: Instagram starts boosting Reels → video posts for the
 * fitness cohort suddenly have 2.4x the engagement of text posts.
 * The agent flags this so the LLM recommends Reels for this brief.
 *
 * No historical data needed — the ratio at a point in time is signal enough.
 * As cohort_performance snapshots accumulate, this can gain time-series too.
 *
 * ─────────────────────────────────────────────────────────────────
 * REDIS CACHING (critical for scale):
 * ─────────────────────────────────────────────────────────────────
 * The reach suppression query touches post_metrics for every user in a
 * cohort. That's expensive if run for every user individually. Solution:
 *
 *   Key: `algorithm_alerts:{platform}:{industry}`
 *   TTL: 24 hours
 *
 * The first user in a cohort to run their weekly signal_weights job
 * computes the full cohort analysis and caches it. Every subsequent
 * user in the same cohort reads from cache — zero additional DB queries.
 *
 * WHAT IT WRITES (signal_weights.algorithm_alerts):
 *   {
 *     "algorithm_alerts": {
 *       "platform":    "instagram",
 *       "cohort_key":  "fitness|instagram",
 *       "detected_at": "2026-04-01T...",
 *       "reach_suppression": {
 *         "detected":              true,
 *         "severity":              "high",
 *         "pct_cohort_affected":   0.73,
 *         "avg_reach_change":      -0.34,
 *         "cohort_size":           42
 *       },
 *       "format_signals": {
 *         "video":       { "type": "boost",   "ratio": 2.3 },
 *         "educational": { "type": "boost",   "ratio": 1.8 },
 *         "text":        { "type": "penalty", "ratio": 0.4 }
 *       }
 *     }
 *   }
 *
 * WHAT THE LLM SEES (via contextBuilder):
 *   ⚠️ PLATFORM ALGORITHM ALERT — Instagram (your industry cohort):
 *   • Reach is down 34% across your cohort — this is an algorithm shift, not your content
 *   • Video posts are getting 2.3x the engagement of text posts right now → use video
 *   • Text-only posts are suppressed (0.4x normal) → avoid for this brief
 *
 * MINIMUM DATA:
 *   — 5 cohort members with post_metrics in both windows for reach suppression
 *   — 3 post_types in cohort_performance for format signal
 *
 * THRESHOLDS:
 *   SUPPRESS_QUORUM    = 0.60  — 60%+ of cohort must show decline
 *   SUPPRESS_THRESHOLD = 0.80  — reach must be < 80% of prior (>20% drop)
 *   FORMAT_BOOST_RATIO = 2.0   — post_type engagement >= 2x baseline = boosted
 *   FORMAT_PENALTY_RATIO = 0.5 — post_type engagement <= 0.5x baseline = penalised
 *
 * Triggered by: signalWeightsWorker.js (weekly, after contentFatigueAgent)
 */

const { supabaseAdmin }     = require('../services/supabaseService');
const { getAgentDirective } = require('../services/agentDirectiveService');
const { cacheGet, cacheSet } = require('../services/redisService');

const SUPPRESS_QUORUM      = 0.60;
const SUPPRESS_THRESHOLD   = 0.80;
const FORMAT_BOOST_RATIO   = 2.0;
const FORMAT_PENALTY_RATIO = 0.5;
const MIN_COHORT_SIZE      = 5;
const MIN_FORMAT_TYPES     = 3;
const CACHE_TTL            = 86400; // 24 hours — one cohort analysis per day

// ----------------------------------------------------------------
// getCohortAlgorithmSignals — computes or reads from cache.
//
// Returns the full algorithm signal object for a given platform + industry.
// Cached in Redis so the expensive cohort query runs once per cohort per day,
// not once per user.
// ----------------------------------------------------------------
async function getCohortAlgorithmSignals(platform, industry) {
  const cacheKey = `algorithm_alerts:${platform}:${industry}`;

  // --- Try cache first ---
  const cached = await cacheGet(cacheKey);
  if (cached && typeof cached === 'object') {
    return cached;
  }

  const now          = Date.now();
  const recentStart  = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const priorStart   = new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString();

  const result = {
    platform,
    cohort_key:       `${industry}|${platform}`,
    detected_at:      new Date().toISOString(),
    reach_suppression: null,
    format_signals:   {}
  };

  // ---------------------------------------------------------------
  // Signal 1: Reach suppression
  // Find all users in this cohort, compute their reach trend.
  // ---------------------------------------------------------------

  // Step 1a: Get user_ids in this cohort (same industry + platform connection)
  const { data: cohortProfiles } = await supabaseAdmin
    .from('user_profiles')
    .select('user_id, industry')
    .eq('industry', industry);

  const cohortUserIds = (cohortProfiles || []).map(p => p.user_id);

  if (cohortUserIds.length >= MIN_COHORT_SIZE) {
    // Step 1b: Get all posts from these users on this platform in last 60 days
    const { data: cohortPosts } = await supabaseAdmin
      .from('posts')
      .select('id, user_id, published_at')
      .in('user_id', cohortUserIds)
      .eq('status', 'published')
      .eq('platform', platform)
      .gte('published_at', priorStart);

    if (cohortPosts && cohortPosts.length > 0) {
      const cohortPostIds = cohortPosts.map(p => p.id);

      // Step 1c: Fetch reach for all these posts
      const { data: cohortMetrics } = await supabaseAdmin
        .from('post_metrics')
        .select('post_id, reach')
        .in('post_id', cohortPostIds);

      // Build post_id → reach map (average if multiple rows)
      const reachMap = {};
      (cohortMetrics || []).forEach(m => {
        if (!reachMap[m.post_id]) reachMap[m.post_id] = { total: 0, count: 0 };
        reachMap[m.post_id].total += (m.reach || 0);
        reachMap[m.post_id].count++;
      });

      // Build post lookup with published_at + user_id
      const postLookup = {};
      cohortPosts.forEach(p => { postLookup[p.id] = p; });

      // Step 1d: Per-user, compute recent vs prior avg reach
      const userReachTrends = {};
      Object.entries(reachMap).forEach(([postId, r]) => {
        const post = postLookup[postId];
        if (!post) return;
        const avgReach = r.total / r.count;
        const period   = post.published_at >= recentStart ? 'recent' : 'prior';
        const uid      = post.user_id;

        if (!userReachTrends[uid]) userReachTrends[uid] = { recent: [], prior: [] };
        userReachTrends[uid][period].push(avgReach);
      });

      // Step 1e: For each user with data in both periods, compute trend ratio
      const trendRatios = [];
      Object.values(userReachTrends).forEach(({ recent, prior }) => {
        if (recent.length === 0 || prior.length === 0) return;
        const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
        const priorAvg  = prior.reduce((s, v) => s + v, 0)  / prior.length;
        if (priorAvg === 0) return;
        trendRatios.push(recentAvg / priorAvg);
      });

      if (trendRatios.length >= MIN_COHORT_SIZE) {
        const suppressed     = trendRatios.filter(r => r < SUPPRESS_THRESHOLD);
        const pctAffected    = suppressed.length / trendRatios.length;
        const avgChangeRatio = trendRatios.reduce((s, v) => s + v, 0) / trendRatios.length;
        const avgReachChange = Math.round((avgChangeRatio - 1) * 100) / 100; // e.g. -0.34

        const detected = pctAffected >= SUPPRESS_QUORUM;

        let severity = 'low';
        if (pctAffected > 0.80 && avgReachChange < -0.30) severity = 'high';
        else if (pctAffected > 0.60 || avgReachChange < -0.20) severity = 'medium';

        result.reach_suppression = {
          detected,
          severity,
          pct_cohort_affected: Math.round(pctAffected * 100) / 100,
          avg_reach_change:    avgReachChange,
          cohort_size:         trendRatios.length
        };
      }
    }
  }

  // ---------------------------------------------------------------
  // Signal 2: Format boost / penalty (cross-sectional)
  // Read cohort_performance for all post_types in this cohort.
  // ---------------------------------------------------------------

  // Fetch all cohort_performance rows for this platform + industry
  const { data: cohortPerf } = await supabaseAdmin
    .from('cohort_performance')
    .select('post_type, avg_likes, avg_comments, avg_shares, avg_reach, sample_size')
    .eq('platform', platform)
    .eq('industry', industry)
    .not('post_type', 'is', null);

  if (cohortPerf && cohortPerf.length >= MIN_FORMAT_TYPES) {
    // Compute engagement rate per post_type (same formula as all other agents)
    const typeRates = cohortPerf
      .filter(r => r.sample_size >= 3 && (r.avg_reach || 0) > 0)
      .map(r => ({
        post_type: r.post_type,
        rate: ((r.avg_likes + r.avg_comments * 2 + r.avg_shares * 3) / r.avg_reach) * 100
      }));

    if (typeRates.length >= MIN_FORMAT_TYPES) {
      // Baseline = mean engagement rate across all tracked post_types
      const baseline = typeRates.reduce((s, t) => s + t.rate, 0) / typeRates.length;

      if (baseline > 0) {
        typeRates.forEach(({ post_type, rate }) => {
          const ratio = Math.round((rate / baseline) * 10) / 10;

          if (ratio >= FORMAT_BOOST_RATIO) {
            result.format_signals[post_type] = { type: 'boost', ratio };
          } else if (ratio <= FORMAT_PENALTY_RATIO) {
            result.format_signals[post_type] = { type: 'penalty', ratio };
          }
        });
      }
    }
  }

  // Cache the result so every other user in this cohort gets it for free
  await cacheSet(cacheKey, result, CACHE_TTL);

  return result;
}

// ----------------------------------------------------------------
// runPlatformAlgorithmAnalysis — main export.
//
// Gets the user's cohort (industry + connected platforms), fetches
// or reads the cached cohort algorithm signals, and writes the
// relevant alerts to their signal_weights.
// ----------------------------------------------------------------
async function runPlatformAlgorithmAnalysis(userId) {
  console.log(`[PlatformAlgorithmAgent] Checking algorithm signals for user ${userId}...`);

  const directive = await getAgentDirective('platformAlgorithmAgent', userId);

  // --- Step 1: Get this user's industry + connected platforms ---
  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('industry, signal_weights')
    .eq('user_id', userId)
    .single();

  if (!profile?.industry) {
    console.log(`[PlatformAlgorithmAgent] No industry set for ${userId}. Skipping.`);
    return;
  }

  const { data: connections } = await supabaseAdmin
    .from('platform_connections')
    .select('platform')
    .eq('user_id', userId);

  if (!connections || connections.length === 0) {
    console.log(`[PlatformAlgorithmAgent] No platform connections for ${userId}. Skipping.`);
    return;
  }

  // --- Step 2: Run cohort analysis for each connected platform ---
  // Collect all alerts across all platforms — a user might be on both
  // Facebook and Instagram and each could have different algorithm signals.
  const allAlerts = [];

  for (const { platform } of connections) {
    try {
      const signals = await getCohortAlgorithmSignals(platform, profile.industry);

      // Only include if at least one signal was detected
      const hasSuppressionAlert = signals.reach_suppression?.detected === true;
      const hasFormatSignals    = Object.keys(signals.format_signals || {}).length > 0;

      if (hasSuppressionAlert || hasFormatSignals) {
        allAlerts.push(signals);
      }
    } catch (err) {
      // Never let one platform's failure block the rest
      console.error(`[PlatformAlgorithmAgent] Error for ${userId} on ${platform}:`, err.message);
    }
  }

  // --- Step 3: Merge into signal_weights ---
  const current = (profile?.signal_weights && typeof profile.signal_weights === 'object')
    ? profile.signal_weights
    : {};

  const updated = {
    ...current,
    algorithm_alerts:            allAlerts,
    algorithm_alerts_updated_at: new Date().toISOString(),
    ...(directive ? { agent_directive_algorithm: directive } : {})
  };

  const { error: updateErr } = await supabaseAdmin
    .from('user_profiles')
    .update({ signal_weights: updated })
    .eq('user_id', userId);

  if (updateErr) {
    console.error(`[PlatformAlgorithmAgent] Failed to save for ${userId}:`, updateErr.message);
    return;
  }

  const alertSummary = allAlerts.map(a => {
    const parts = [];
    if (a.reach_suppression?.detected) parts.push(`reach:${a.reach_suppression.severity}`);
    const boosts   = Object.entries(a.format_signals || {}).filter(([, v]) => v.type === 'boost').map(([k]) => k);
    const penalties = Object.entries(a.format_signals || {}).filter(([, v]) => v.type === 'penalty').map(([k]) => k);
    if (boosts.length)    parts.push(`boost:${boosts.join(',')}`);
    if (penalties.length) parts.push(`penalty:${penalties.join(',')}`);
    return `${a.platform}(${parts.join('|') || 'no alerts'})`;
  }).join(' / ') || 'no alerts detected';

  console.log(`[PlatformAlgorithmAgent] ${userId} — ${alertSummary}`);
}

module.exports = { runPlatformAlgorithmAnalysis };
