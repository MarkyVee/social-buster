/**
 * agents/postTypeCalendarAgent.js
 *
 * Layer 1 Learning Agent — Post Type Calendar Analysis.
 *
 * WHAT THIS DOES:
 * Figures out WHEN this user's audience is most engaged — broken down by
 * the type of content being posted. A promotional post and an educational
 * post may peak at completely different hours, and this agent learns that
 * distinction from the user's own publish history.
 *
 * Example output stored in signal_weights:
 *   {
 *     "best_hours": {
 *       "overall":       [9, 12, 18],         ← top 3 hours regardless of post type
 *       "best_days":     [2, 3, 4],            ← Tue/Wed/Thu (0=Sun...6=Sat)
 *       "by_post_type": {
 *         "educational":       [9, 10, 11],
 *         "promotional":       [17, 18, 19],
 *         "community_engagement": [7, 8, 19]
 *       }
 *     },
 *     "best_hours_updated_at": "2026-04-01T..."
 *   }
 *
 * WHAT THE LLM SEES (via contextBuilder):
 *   BEST TIMES TO POST:
 *   • Overall best hours: 9am, 12pm, 6pm | Best days: Tue, Wed, Thu
 *   • educational posts:  9am–11am window
 *   • promotional posts:  5pm–7pm window
 *
 * WHY THIS MATTERS:
 * The existing performanceAgent tracks "best_hour" in cohort_performance — but
 * that's a COHORT average, not this user's audience. Some audiences (B2B) peak
 * at 9am Tuesday. Some (consumer/lifestyle) peak at 8pm Sunday. Only this user's
 * own data can reveal that. This agent reads it.
 *
 * HOUR CALCULATION:
 * published_at is stored in UTC. We use UTC hours throughout and flag in the
 * prompt that times are UTC — the frontend can convert to local if needed later.
 * (Most users schedule posts consciously, so UTC publish times approximate
 * their intended local posting window well enough for this analysis.)
 *
 * ENGAGEMENT SCORE:
 * Same formula as hookPerformanceAgent — weighted rate normalised by reach.
 * Consistent scoring across all Layer 1 agents enables fair comparisons.
 *
 * MINIMUM DATA:
 *   — 10 posts with metrics overall before running (enough for hourly buckets)
 *   — 5 posts per post_type to include that type in by_post_type breakdown
 *
 * TOP N SELECTION:
 *   — Overall: top 3 hours by avg engagement score
 *   — Per post_type: top 3 hours (or fewer if data is sparse)
 *   — Best days: top 3 days of week by avg engagement score
 *
 * Triggered by: signalWeightsWorker.js (weekly, after hookPerformanceAgent
 * and toneObjectiveFitAgent have run for this user)
 */

const { supabaseAdmin }       = require('../services/supabaseService');
const { getAgentDirective }   = require('../services/agentDirectiveService');

const MIN_POSTS_OVERALL   = 10;
const MIN_POSTS_PER_TYPE  = 5;
const TOP_N_HOURS         = 3;

// Day names for logging readability
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ----------------------------------------------------------------
// calcEngagementScore — consistent formula across all Layer 1 agents.
// (likes + comments×2 + shares×3) / reach × 100
// ----------------------------------------------------------------
function calcEngagementScore(likes, comments, shares, reach) {
  if (!reach || reach === 0) return 0;
  return ((likes + comments * 2 + shares * 3) / reach) * 100;
}

// ----------------------------------------------------------------
// topNKeys — returns the top N keys of an object sorted by value desc.
// Used to pick the best hours/days from a frequency/score bucket.
// ----------------------------------------------------------------
function topNKeys(obj, n) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => parseInt(k, 10));
}

// ----------------------------------------------------------------
// runPostTypeCalendarAnalysis — main export.
// ----------------------------------------------------------------
async function runPostTypeCalendarAnalysis(userId) {
  console.log(`[PostTypeCalendarAgent] Analysing posting calendar for user ${userId}...`);

  const directive = await getAgentDirective('postTypeCalendarAgent', userId);

  const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

  // --- Step 1: Published posts in last 60 days (with their brief for post_type) ---
  const { data: posts, error: postsErr } = await supabaseAdmin
    .from('posts')
    .select('id, brief_id, published_at')
    .eq('user_id', userId)
    .eq('status', 'published')
    .gte('published_at', cutoff)
    .not('published_at', 'is', null);

  if (postsErr || !posts || posts.length < MIN_POSTS_OVERALL) {
    console.log(`[PostTypeCalendarAgent] Not enough posts for ${userId} (${posts?.length || 0}). Skipping.`);
    return;
  }

  // --- Step 2: Fetch post_type from briefs for posts that have one ---
  const briefIds = [...new Set(posts.map(p => p.brief_id).filter(Boolean))];
  const briefMap = {};

  if (briefIds.length > 0) {
    const { data: briefs } = await supabaseAdmin
      .from('briefs')
      .select('id, post_type')
      .in('id', briefIds);

    (briefs || []).forEach(b => { briefMap[b.id] = b.post_type; });
  }

  // --- Step 3: Fetch metrics for these posts ---
  const postIds = posts.map(p => p.id);
  const { data: metrics, error: metricsErr } = await supabaseAdmin
    .from('post_metrics')
    .select('post_id, likes, comments, shares, reach')
    .in('post_id', postIds);

  if (metricsErr || !metrics || metrics.length === 0) {
    console.log(`[PostTypeCalendarAgent] No metrics yet for ${userId}. Skipping.`);
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

  // --- Step 4: Build hourly and daily score buckets ---
  // hourBuckets[hour]      = { total: score sum, count: post count }
  // dayBuckets[dayOfWeek]  = same
  // typeBuckets[post_type][hour] = same
  const hourBuckets = {};   // 0-23
  const dayBuckets  = {};   // 0-6 (Sun=0)
  const typeBuckets = {};   // { post_type: { hour: { total, count } } }

  let postsScored = 0;

  posts.forEach(post => {
    const m = metricsMap[post.id];
    if (!m || m.count === 0) return;

    const avgLikes    = m.likes    / m.count;
    const avgComments = m.comments / m.count;
    const avgShares   = m.shares   / m.count;
    const avgReach    = m.reach    / m.count;

    const score     = calcEngagementScore(avgLikes, avgComments, avgShares, avgReach);
    const publishedAt = new Date(post.published_at);
    const hour      = publishedAt.getUTCHours();
    const day       = publishedAt.getUTCDay();   // 0=Sun, 6=Sat
    const postType  = post.brief_id ? briefMap[post.brief_id] : null;

    // Overall hour bucket
    if (!hourBuckets[hour]) hourBuckets[hour] = { total: 0, count: 0 };
    hourBuckets[hour].total += score;
    hourBuckets[hour].count++;

    // Day-of-week bucket
    if (!dayBuckets[day]) dayBuckets[day] = { total: 0, count: 0 };
    dayBuckets[day].total += score;
    dayBuckets[day].count++;

    // Per-post-type hour bucket
    if (postType) {
      if (!typeBuckets[postType]) typeBuckets[postType] = {};
      if (!typeBuckets[postType][hour]) typeBuckets[postType][hour] = { total: 0, count: 0 };
      typeBuckets[postType][hour].total += score;
      typeBuckets[postType][hour].count++;
    }

    postsScored++;
  });

  if (postsScored < MIN_POSTS_OVERALL) {
    console.log(`[PostTypeCalendarAgent] Only ${postsScored} posts had metrics for ${userId}. Skipping.`);
    return;
  }

  // --- Step 5: Convert buckets to avg-score maps, then pick top N ---

  // Overall best hours (top 3 by avg engagement score)
  const hourAvgs = {};
  Object.entries(hourBuckets).forEach(([h, b]) => {
    hourAvgs[h] = b.total / b.count;
  });
  const bestHoursOverall = topNKeys(hourAvgs, TOP_N_HOURS);

  // Best days of week (top 3)
  const dayAvgs = {};
  Object.entries(dayBuckets).forEach(([d, b]) => {
    dayAvgs[d] = b.total / b.count;
  });
  const bestDays = topNKeys(dayAvgs, TOP_N_HOURS);

  // Per-post-type: only include types with enough posts across all hours
  const bestHoursByPostType = {};
  for (const [postType, hourMap] of Object.entries(typeBuckets)) {
    // Count total posts across all hours for this type
    const totalPosts = Object.values(hourMap).reduce((sum, b) => sum + b.count, 0);
    if (totalPosts < MIN_POSTS_PER_TYPE) continue;

    const typeHourAvgs = {};
    Object.entries(hourMap).forEach(([h, b]) => {
      typeHourAvgs[h] = b.total / b.count;
    });
    bestHoursByPostType[postType] = topNKeys(typeHourAvgs, TOP_N_HOURS);
  }

  // --- Step 6: Merge into signal_weights ---
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
    best_hours: {
      overall:       bestHoursOverall,
      best_days:     bestDays,
      by_post_type:  bestHoursByPostType
    },
    best_hours_updated_at: new Date().toISOString(),
    best_hours_post_count: postsScored,
    ...(directive ? { agent_directive_calendar: directive } : {})
  };

  const { error: updateErr } = await supabaseAdmin
    .from('user_profiles')
    .update({ signal_weights: updated })
    .eq('user_id', userId);

  if (updateErr) {
    console.error(`[PostTypeCalendarAgent] Failed to save for ${userId}:`, updateErr.message);
    return;
  }

  const hourLabel  = h => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
  const overallStr = bestHoursOverall.map(hourLabel).join(', ');
  const daysStr    = bestDays.map(d => DAY_NAMES[d]).join('/');
  const typesStr   = Object.keys(bestHoursByPostType).join(', ') || 'none (not enough data per type yet)';

  console.log(`[PostTypeCalendarAgent] ${userId} — Best hours: ${overallStr} | Days: ${daysStr} | Post types with data: ${typesStr}`);
}

module.exports = { runPostTypeCalendarAnalysis };
