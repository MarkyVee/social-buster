/**
 * services/performancePredictorService.js
 *
 * Predicts engagement performance for a post BEFORE it is published.
 * Uses two data sources:
 *
 *   1. Cohort benchmarks (cohort_performance table)
 *      — averages from peers with same industry + geo + platform + post_type
 *
 *   2. User's own history (post_metrics table)
 *      — how this specific user performs relative to their cohort
 *
 * The prediction is a weighted blend: if the user has enough data,
 * lean on their history. If not, lean on cohort averages. New users
 * with no data at all get a "not enough data" response.
 *
 * Returns:
 *   - engagement_range: { likes, comments, reach } with min/max
 *   - confidence: 0–100 (how much data backs the prediction)
 *   - factors: array of strings explaining why the score is what it is
 *   - tweaks: array of actionable suggestions (from LLM)
 *
 * No external API calls for the core prediction — it's pure math on
 * existing data. The LLM is only called for the optional tweaks step.
 */

const { supabaseAdmin } = require('./supabaseService');
const { getCohortBenchmark } = require('../agents/performanceAgent');
const { cacheGet } = require('./redisService');

// Minimum posts before we trust user-level predictions
const MIN_USER_POSTS = 3;

// ----------------------------------------------------------------
// predictEngagement — the main export.
//
// Input:
//   userId   — the user requesting the prediction
//   postDraft — { platform, post_type, tone, hook, caption }
//
// Returns: prediction object or null if not enough data
// ----------------------------------------------------------------
async function predictEngagement(userId, postDraft) {
  const { platform, post_type, tone, hook, caption } = postDraft;

  // Pull cohort benchmark and user's own metrics in parallel
  const [cohortRow, userMetrics, userProfile] = await Promise.all([
    getCohortBenchmark(userId, platform, post_type || null),
    getUserRecentMetrics(userId, platform),
    getUserProfile(userId)
  ]);

  // If we have no cohort data AND no user data, we can't predict anything
  if (!cohortRow && userMetrics.length === 0) {
    return {
      available: false,
      message: 'Not enough data yet. Publish a few posts and let the performance agent run to build your prediction model.'
    };
  }

  // Calculate base metrics from whatever data we have
  const cohortAvgs = cohortRow ? {
    likes:    cohortRow.avg_likes    || 0,
    comments: cohortRow.avg_comments || 0,
    reach:    cohortRow.avg_reach    || 0,
    shares:   cohortRow.avg_shares   || 0
  } : null;

  const userAvgs = userMetrics.length >= MIN_USER_POSTS
    ? calculateAverages(userMetrics)
    : null;

  // Blend user + cohort data (user data weighted more if they have enough)
  const blended = blendPrediction(cohortAvgs, userAvgs);

  // Calculate confidence score (0-100)
  const confidence = calculateConfidence(
    cohortRow?.sample_size || 0,
    userMetrics.length
  );

  // Analyze factors that affect the prediction
  const factors = analyzeFactors(postDraft, cohortRow, userAvgs);

  // Build the engagement range (±30% at high confidence, ±60% at low)
  const spreadFactor = confidence >= 70 ? 0.3 : confidence >= 40 ? 0.45 : 0.6;
  const engagementRange = {
    likes: {
      min: Math.round(blended.likes * (1 - spreadFactor)),
      max: Math.round(blended.likes * (1 + spreadFactor))
    },
    comments: {
      min: Math.round(blended.comments * (1 - spreadFactor)),
      max: Math.round(blended.comments * (1 + spreadFactor))
    },
    reach: {
      min: Math.round(blended.reach * (1 - spreadFactor)),
      max: Math.round(blended.reach * (1 + spreadFactor))
    }
  };

  return {
    available:        true,
    engagement_range: engagementRange,
    confidence,
    factors,
    cohort_benchmark: cohortAvgs,
    user_average:     userAvgs,
    data_points: {
      cohort_sample_size: cohortRow?.sample_size || 0,
      user_post_count:    userMetrics.length
    }
  };
}

// ----------------------------------------------------------------
// getUserRecentMetrics — pulls the user's own post metrics for a platform.
// Returns the most recent snapshot per post (last 30 days).
// ----------------------------------------------------------------
async function getUserRecentMetrics(userId, platform) {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabaseAdmin
      .from('post_metrics')
      .select('post_id, likes, comments, shares, saves, reach, impressions')
      .eq('user_id', userId)
      .eq('platform', platform)
      .gte('recorded_at', cutoff)
      .order('recorded_at', { ascending: false });

    if (error || !data) return [];

    // Deduplicate — keep only the latest snapshot per post_id
    const seen = new Set();
    return data.filter(row => {
      if (seen.has(row.post_id)) return false;
      seen.add(row.post_id);
      return true;
    });

  } catch (err) {
    console.error('[Predictor] Failed to fetch user metrics:', err.message);
    return [];
  }
}

// ----------------------------------------------------------------
// getUserProfile — fetches the user's profile for cohort matching
// ----------------------------------------------------------------
async function getUserProfile(userId) {
  try {
    const { data } = await supabaseAdmin
      .from('user_profiles')
      .select('industry, business_type, geo_region')
      .eq('user_id', userId)
      .single();
    return data || {};
  } catch {
    return {};
  }
}

// ----------------------------------------------------------------
// calculateAverages — computes average metrics from a set of post snapshots
// ----------------------------------------------------------------
function calculateAverages(metrics) {
  if (!metrics.length) return null;

  const sum = { likes: 0, comments: 0, reach: 0, shares: 0 };
  metrics.forEach(m => {
    sum.likes    += m.likes    || 0;
    sum.comments += m.comments || 0;
    sum.reach    += m.reach    || 0;
    sum.shares   += m.shares   || 0;
  });

  return {
    likes:    Math.round(sum.likes    / metrics.length),
    comments: Math.round(sum.comments / metrics.length),
    reach:    Math.round(sum.reach    / metrics.length),
    shares:   Math.round(sum.shares   / metrics.length)
  };
}

// ----------------------------------------------------------------
// blendPrediction — combines cohort and user data with appropriate weighting.
//
// If we have both: 60% user, 40% cohort (user's own data is more relevant).
// If only cohort: 100% cohort.
// If only user: 100% user.
// ----------------------------------------------------------------
function blendPrediction(cohortAvgs, userAvgs) {
  if (userAvgs && cohortAvgs) {
    return {
      likes:    Math.round(userAvgs.likes    * 0.6 + cohortAvgs.likes    * 0.4),
      comments: Math.round(userAvgs.comments * 0.6 + cohortAvgs.comments * 0.4),
      reach:    Math.round(userAvgs.reach    * 0.6 + cohortAvgs.reach    * 0.4),
      shares:   Math.round(userAvgs.shares   * 0.6 + cohortAvgs.shares   * 0.4)
    };
  }

  if (cohortAvgs) return { ...cohortAvgs };
  if (userAvgs)   return { ...userAvgs };

  // Should never hit this — caller checks for at least one data source
  return { likes: 0, comments: 0, reach: 0, shares: 0 };
}

// ----------------------------------------------------------------
// calculateConfidence — how much we trust the prediction (0-100).
//
// Based on two signals:
//   - Cohort sample size (more peers = more reliable baseline)
//   - User's own post count (more history = more personalized)
//
// 50+ cohort posts + 10+ user posts = 100% confidence.
// ----------------------------------------------------------------
function calculateConfidence(cohortSampleSize, userPostCount) {
  // Cohort contribution: 0-50 points (maxes out at 50 samples)
  const cohortScore = Math.min(cohortSampleSize / 50, 1) * 50;

  // User contribution: 0-50 points (maxes out at 10 posts)
  const userScore = Math.min(userPostCount / 10, 1) * 50;

  return Math.round(cohortScore + userScore);
}

// ----------------------------------------------------------------
// analyzeFactors — identifies what's boosting or hurting the prediction.
// Returns an array of human-readable factor strings.
// ----------------------------------------------------------------
function analyzeFactors(postDraft, cohortRow, userAvgs) {
  const factors = [];

  // Hook length analysis
  const hookWords = (postDraft.hook || '').split(/\s+/).length;
  if (hookWords <= 8) {
    factors.push({ type: 'positive', text: 'Short, punchy hook — tends to stop the scroll' });
  } else if (hookWords > 20) {
    factors.push({ type: 'warning', text: 'Long hook — shorter hooks typically get more engagement' });
  }

  // Hook starts with a question
  if (postDraft.hook && postDraft.hook.trim().endsWith('?')) {
    factors.push({ type: 'positive', text: 'Question hook — drives comments and curiosity' });
  }

  // Tone match with cohort top tones
  if (cohortRow?.top_tones?.length && postDraft.tone) {
    if (cohortRow.top_tones.includes(postDraft.tone)) {
      factors.push({ type: 'positive', text: `"${postDraft.tone}" tone matches what performs best in your niche` });
    } else {
      factors.push({ type: 'neutral', text: `Top tones in your niche: ${cohortRow.top_tones.join(', ')}` });
    }
  }

  // User performance vs cohort
  if (userAvgs && cohortRow) {
    const ratio = userAvgs.likes / (cohortRow.avg_likes || 1);
    if (ratio > 1.3) {
      factors.push({ type: 'positive', text: `You outperform your peers by ${Math.round((ratio - 1) * 100)}% on avg likes` });
    } else if (ratio < 0.7) {
      factors.push({ type: 'warning', text: `Your avg likes are ${Math.round((1 - ratio) * 100)}% below peers — the predictions and tweaks can help close the gap` });
    }
  }

  // Caption length
  const captionLen = (postDraft.caption || '').length;
  if (postDraft.platform === 'x' && captionLen > 200) {
    factors.push({ type: 'warning', text: 'Caption is long for X — shorter posts tend to get more engagement' });
  }
  if (postDraft.platform === 'linkedin' && captionLen > 1000) {
    factors.push({ type: 'neutral', text: 'Long LinkedIn post — good for thought leadership, may reduce casual engagement' });
  }

  // Best posting hours
  if (cohortRow?.best_post_hours?.length) {
    const hours = cohortRow.best_post_hours.map(h => {
      const ampm = h >= 12 ? 'PM' : 'AM';
      const hr = h > 12 ? h - 12 : (h === 0 ? 12 : h);
      return `${hr}${ampm}`;
    });
    factors.push({ type: 'tip', text: `Best times to post: ${hours.join(', ')}` });
  }

  // Hook similarity to top cohort hooks
  if (cohortRow?.top_hooks?.length && postDraft.hook) {
    const hookLower = postDraft.hook.toLowerCase();
    const matchesPattern = cohortRow.top_hooks.some(topHook => {
      // Check if hook uses similar structure (starts with same word, similar length)
      const topWords = topHook.toLowerCase().split(/\s+/);
      return topWords.some(w => w.length > 3 && hookLower.includes(w));
    });
    if (matchesPattern) {
      factors.push({ type: 'positive', text: 'Hook style matches patterns from top-performing posts in your niche' });
    }
  }

  return factors;
}

module.exports = { predictEngagement };
