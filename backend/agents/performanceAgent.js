/**
 * agents/performanceAgent.js
 *
 * Background agent that polls post performance metrics from platform APIs
 * and drives two intelligence layers:
 *
 *   Layer 1 — Per-user intelligence cache (intelligence:{userId} in Redis)
 *     Summarises this user's own post performance history.
 *     Read by the LLM at post-generation time to personalise copy.
 *
 *   Layer 2 — Collective cohort intelligence (cohort_performance table)
 *     Aggregates metrics ACROSS all users who share the same industry +
 *     geo_region + platform + post_type. No user PII — population-level only.
 *     Used by /intelligence/preflight to benchmark any one user against peers.
 *
 * Runs every 2 hours via BullMQ (workers/performanceWorker.js).
 *
 * Posts are polled for up to 30 days after publishing. Platform API calls
 * are grouped by user so each connection is only looked up once per cycle.
 */

const { supabaseAdmin }  = require('../services/supabaseService');
const { decryptToken }   = require('../services/tokenEncryption');
const { fetchMetrics }   = require('../services/platformAPIs');
const { cacheSet }       = require('../services/redisService');

// Minimum number of cohort posts before cohort data is considered useful.
// Enforced at query time (not in the DB) so we can accumulate early.
const MIN_COHORT_SAMPLE = 5;

// ----------------------------------------------------------------
// runPerformanceCycle — fetches metrics for all active published posts.
// Called by workers/performanceWorker.js on a 2-hour repeating job.
// ----------------------------------------------------------------
// Page size for fetching posts — prevents loading 50K+ rows into memory
const BATCH_SIZE = 500;

async function runPerformanceCycle() {
  console.log('[PerformanceAgent] Starting performance cycle...');

  try {
    // Only poll posts from the last 30 days
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Track which cohort keys were touched this cycle so we don't
    // re-aggregate the same cohort for every user who shares it
    const cohortKeysProcessed = new Set();

    let totalProcessed = 0;
    let offset = 0;

    // Paginate through published posts in batches to avoid loading
    // tens of thousands of rows into memory at once (ISSUE-011)
    while (true) {
      const { data: posts, error } = await supabaseAdmin
        .from('posts')
        .select('id, user_id, platform, platform_post_id, published_at')
        .eq('status', 'published')
        .gte('published_at', cutoff)
        .not('platform_post_id', 'is', null)
        .order('published_at', { ascending: true })
        .range(offset, offset + BATCH_SIZE - 1);

      if (error) {
        console.error('[PerformanceAgent] Failed to fetch published posts:', error.message);
        return;
      }

      if (!posts || posts.length === 0) break;

      console.log(`[PerformanceAgent] Processing batch of ${posts.length} post(s) (offset ${offset})...`);

      // Group by user — share connection lookups per user
      const byUser = {};
      posts.forEach(post => {
        if (!byUser[post.user_id]) byUser[post.user_id] = [];
        byUser[post.user_id].push(post);
      });

      for (const [userId, userPosts] of Object.entries(byUser)) {
        try {
          const processed = await processUserMetrics(userId, userPosts);
          totalProcessed += processed;

          // Aggregate cohort data for this user's cohort (once per unique key)
          if (processed > 0) {
            await aggregateCohortPerformance(userId, cohortKeysProcessed);
          }

        } catch (err) {
          console.error(`[PerformanceAgent] Error for user ${userId}:`, err.message);
        }
      }

      // If we got fewer than BATCH_SIZE, we've reached the end
      if (posts.length < BATCH_SIZE) break;
      offset += BATCH_SIZE;
    }

    console.log(`[PerformanceAgent] Performance cycle complete. ${totalProcessed} post(s) processed.`);

  } catch (err) {
    console.error('[PerformanceAgent] Unexpected error:', err.message);
    throw err;
  }
}

// ----------------------------------------------------------------
// processUserMetrics — fetches and stores metrics for one user's posts.
// Returns the number of posts successfully processed.
// ----------------------------------------------------------------
async function processUserMetrics(userId, posts) {
  const connectionCache = {};
  let postsProcessed = 0;

  for (const post of posts) {
    try {
      if (!connectionCache[post.platform]) {
        const { data: conn } = await supabaseAdmin
          .from('platform_connections')
          .select('access_token, token_expires_at')
          .eq('user_id', userId)
          .eq('platform', post.platform)
          .single();
        connectionCache[post.platform] = conn || null;
      }

      const connection = connectionCache[post.platform];
      if (!connection) continue;

      let accessToken;
      try {
        accessToken = decryptToken(connection.access_token);
      } catch {
        continue;
      }

      const metrics = await fetchMetrics(post.platform_post_id, post.platform, accessToken);

      await supabaseAdmin
        .from('post_metrics')
        .insert({
          user_id:     userId,
          post_id:     post.id,
          platform:    post.platform,
          likes:       metrics.likes       || 0,
          comments:    metrics.comments    || 0,
          shares:      metrics.shares      || 0,
          saves:       metrics.saves       || 0,
          reach:       metrics.reach       || 0,
          impressions: metrics.impressions || 0,
          clicks:      metrics.clicks      || 0,
          video_views: metrics.video_views || 0,
          recorded_at: new Date().toISOString()
        });

      postsProcessed++;

    } catch (err) {
      console.error(`[PerformanceAgent] Failed to process post ${post.id}:`, err.message);
    }
  }

  // Rebuild the individual intelligence cache if we processed any posts
  if (postsProcessed > 0) {
    await updateIntelligenceCache(userId);
  }

  return postsProcessed;
}

// ----------------------------------------------------------------
// updateIntelligenceCache — builds a per-user text intelligence
// summary and stores it in Redis for the LLM to read at generation time.
// ----------------------------------------------------------------
async function updateIntelligenceCache(userId) {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: metrics } = await supabaseAdmin
      .from('post_metrics')
      .select('*, posts(platform, hook, caption, hashtags, cta, published_at, briefs(post_type, tone))')
      .eq('user_id', userId)
      .gte('recorded_at', cutoff)
      .order('recorded_at', { ascending: false })
      .limit(50);

    if (!metrics || metrics.length === 0) return;

    const summary = buildIntelligenceSummary(metrics);
    await cacheSet(`intelligence:${userId}`, summary, 12 * 3600);

    console.log(`[PerformanceAgent] Intelligence cache updated for user ${userId}`);

  } catch (err) {
    console.error(`[PerformanceAgent] Failed to update intelligence cache:`, err.message);
  }
}

// ----------------------------------------------------------------
// buildIntelligenceSummary — formats per-user performance data as
// plain text for LLM prompt injection (see llmService.js).
// ----------------------------------------------------------------
function buildIntelligenceSummary(metrics) {
  const totalPosts     = metrics.length;
  const avgLikes       = avg(metrics, 'likes');
  const avgReach       = avg(metrics, 'reach');
  const avgImpressions = avg(metrics, 'impressions');

  // Best platform by average likes
  const platformStats = {};
  metrics.forEach(m => {
    if (!platformStats[m.platform]) platformStats[m.platform] = { count: 0, likes: 0, reach: 0 };
    platformStats[m.platform].count++;
    platformStats[m.platform].likes += (m.likes || 0);
    platformStats[m.platform].reach += (m.reach || 0);
  });

  const bestPlatform = Object.entries(platformStats)
    .sort((a, b) => (b[1].likes / b[1].count) - (a[1].likes / a[1].count))
    .map(([platform]) => platform)[0];

  // Top 5 hooks by total engagement
  const topPosts = [...metrics]
    .sort((a, b) => (b.likes + b.comments + b.shares) - (a.likes + a.comments + a.shares))
    .slice(0, 5)
    .filter(m => m.posts?.hook)
    .map(m =>
      `• "${m.posts.hook.slice(0, 70)}" — ${m.likes} likes, ${m.comments} comments on ${m.platform}`
    )
    .join('\n');

  // Best hour of day to post (from published_at, based on top-quartile reach posts)
  const topQuartileReach = [...metrics]
    .filter(m => m.reach > 0)
    .sort((a, b) => b.reach - a.reach)
    .slice(0, Math.max(1, Math.floor(metrics.length / 4)));

  const hourCounts = {};
  topQuartileReach.forEach(m => {
    if (m.posts?.published_at) {
      const hour = new Date(m.posts.published_at).getHours();
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    }
  });
  const bestHour = Object.entries(hourCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([h]) => parseInt(h))[0];

  const bestHourStr = bestHour !== undefined
    ? `${bestHour}:00–${bestHour + 1}:00 local time`
    : 'not enough data';

  return [
    `PERFORMANCE INTELLIGENCE (last 30 days, ${totalPosts} data points):`,
    `• Average likes per post:       ${avgLikes}`,
    `• Average reach per post:       ${avgReach}`,
    `• Average impressions per post: ${avgImpressions}`,
    `• Best performing platform:     ${bestPlatform || 'not enough data'}`,
    `• Best time to post (by reach): ${bestHourStr}`,
    '',
    'TOP PERFORMING HOOKS (replicate these styles and angles):',
    topPosts || '• No data yet — use best practices for now.',
    '',
    `INSIGHT: Aim for hooks that beat ${avgLikes} likes. ` +
    `The audience responds best to content on ${bestPlatform || 'their primary platform'}.`
  ].join('\n');
}

// ================================================================
// COHORT AGGREGATION
//
// Aggregates performance data ACROSS all users who share the same
// industry + geo_region combination, broken down by platform and
// post_type. Stores results in the cohort_performance table.
//
// This is the "collective intelligence" layer — a user's cohort
// benchmark is the average of their peers' results, not their own.
//
// Privacy safeguard: we only expose cohort data when sample_size
// >= MIN_COHORT_SAMPLE (enforced in the API, not here).
// ================================================================

// ----------------------------------------------------------------
// aggregateCohortPerformance — called after a user's metrics are
// processed. Looks up the user's profile, finds all cohort peers,
// runs the aggregation, and upserts into cohort_performance.
//
// cohortKeysProcessed: Set<string> — prevents re-aggregating the
// same cohort twice in one cycle when multiple users share it.
// ----------------------------------------------------------------
async function aggregateCohortPerformance(userId, cohortKeysProcessed = new Set()) {
  try {
    // ---- Step 1: Get this user's profile (cohort dimensions) ----
    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('industry, business_type, geo_region')
      .eq('user_id', userId)
      .single();

    if (!profile?.industry) return; // No profile data → can't determine cohort

    const { industry, business_type, geo_region } = profile;

    // ---- Step 2: Build the base cohort key for this user ----
    // We aggregate two levels:
    //   a) Specific: industry + business_type + geo_region + platform + post_type
    //   b) Broad: industry + geo_region + platform + post_type (ignores business_type)
    // For simplicity we run one aggregation at the industry+geo_region level and
    // store both a broad key and a specific key in the same table row structure.
    const broadKeyBase = `${industry}|any|${geo_region || 'any'}`;
    const specificKeyBase = `${industry}|${business_type || 'any'}|${geo_region || 'any'}`;

    // Skip if we already processed this cohort in this cycle
    if (cohortKeysProcessed.has(specificKeyBase)) return;
    cohortKeysProcessed.add(specificKeyBase);
    cohortKeysProcessed.add(broadKeyBase);

    // ---- Step 3: Find all user IDs in this cohort ----
    let peerQuery = supabaseAdmin
      .from('user_profiles')
      .select('user_id')
      .eq('industry', industry);

    if (geo_region) {
      peerQuery = peerQuery.eq('geo_region', geo_region);
    }

    const { data: peers } = await peerQuery;
    if (!peers || peers.length === 0) return;

    const peerIds = peers.map(p => p.user_id);

    // ---- Step 4: Fetch 30-day metrics for all peers (paginated) ----
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const selectFields = [
      'platform',
      'likes', 'comments', 'shares', 'saves',
      'reach', 'impressions', 'video_views',
      'recorded_at',
      'posts(hook, published_at, briefs(post_type, tone))'
    ].join(', ');

    // Paginate to avoid loading unbounded peer metrics into memory
    let metrics = [];
    let mOffset = 0;
    while (true) {
      const { data: batch } = await supabaseAdmin
        .from('post_metrics')
        .select(selectFields)
        .in('user_id', peerIds)
        .gte('recorded_at', cutoff)
        .range(mOffset, mOffset + BATCH_SIZE - 1);

      if (!batch || batch.length === 0) break;
      metrics = metrics.concat(batch);
      if (batch.length < BATCH_SIZE) break;
      mOffset += BATCH_SIZE;
    }

    if (metrics.length === 0) return;

    // ---- Step 5: Group by platform + post_type and aggregate ----
    // We build groups keyed by "platform|post_type"
    const groups = {};

    for (const m of metrics) {
      const postType = m.posts?.briefs?.post_type || 'any';
      const platform = m.platform;
      const key      = `${platform}|${postType}`;

      if (!groups[key]) {
        groups[key] = {
          platform, postType,
          likes: [], comments: [], shares: [], saves: [],
          reach: [], impressions: [], video_views: [],
          hooks: [],      // hooks from top-quartile-reach posts
          tones: [],      // tones from top-quartile-reach posts
          hours: []       // published_at hours from top-quartile-reach posts
        };
      }

      const g = groups[key];
      g.likes.push(m.likes       || 0);
      g.comments.push(m.comments || 0);
      g.shares.push(m.shares     || 0);
      g.saves.push(m.saves       || 0);
      g.reach.push(m.reach       || 0);
      g.impressions.push(m.impressions || 0);
      g.video_views.push(m.video_views || 0);

      // Collect hooks + tones for pattern analysis
      if (m.posts?.hook)                  g.hooks.push({ reach: m.reach || 0, hook: m.posts.hook });
      if (m.posts?.briefs?.tone)          g.tones.push({ reach: m.reach || 0, tone: m.posts.briefs.tone });
      if (m.posts?.published_at)          g.hours.push({ reach: m.reach || 0, hour: new Date(m.posts.published_at).getHours() });
    }

    // ---- Step 6: Build and upsert one row per group ----
    for (const [, g] of Object.entries(groups)) {
      const sampleSize = g.likes.length;
      if (sampleSize === 0) continue;

      // Numeric averages
      const row = {
        industry,
        business_type: business_type || null,
        geo_region:    geo_region    || null,
        platform:      g.platform,
        post_type:     g.postType === 'any' ? null : g.postType,
        sample_size:   sampleSize,
        avg_likes:        arrAvg(g.likes),
        avg_comments:     arrAvg(g.comments),
        avg_shares:       arrAvg(g.shares),
        avg_saves:        arrAvg(g.saves),
        avg_reach:        arrAvg(g.reach),
        avg_impressions:  arrAvg(g.impressions),
        avg_video_views:  arrAvg(g.video_views),
        updated_at:   new Date().toISOString()
      };

      // Behavioural patterns — only compute when sample is large enough
      if (sampleSize >= MIN_COHORT_SAMPLE) {
        const avgReach   = row.avg_reach;
        const threshold  = avgReach * 1.2; // posts that beat average by 20%+

        // Top hooks: take up to 5 hooks from posts with above-threshold reach
        row.top_hooks = g.hooks
          .filter(h => h.reach >= threshold)
          .sort((a, b) => b.reach - a.reach)
          .slice(0, 5)
          .map(h => h.hook.slice(0, 100));

        // Top tones: most frequent among above-threshold posts
        const toneCounts = {};
        g.tones.filter(t => t.reach >= threshold).forEach(t => {
          toneCounts[t.tone] = (toneCounts[t.tone] || 0) + 1;
        });
        row.top_tones = Object.entries(toneCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([tone]) => tone);

        // Best post hours: top 3 hours by average reach
        const hourReach = {};
        g.hours.forEach(h => {
          if (!hourReach[h.hour]) hourReach[h.hour] = [];
          hourReach[h.hour].push(h.reach);
        });
        row.best_post_hours = Object.entries(hourReach)
          .map(([hour, reaches]) => ({ hour: parseInt(hour), avg: arrAvg(reaches) }))
          .sort((a, b) => b.avg - a.avg)
          .slice(0, 3)
          .map(h => h.hour);
      }

      // Build the cohort_key for upsert targeting
      const cohortKey = [
        industry,
        business_type || 'any',
        geo_region    || 'any',
        g.platform,
        g.postType
      ].join('|');
      row.cohort_key = cohortKey;

      await supabaseAdmin
        .from('cohort_performance')
        .upsert(row, { onConflict: 'cohort_key' });
    }

    console.log(`[PerformanceAgent] Cohort aggregation complete for industry=${industry} geo=${geo_region || 'any'}`);

  } catch (err) {
    // Non-fatal — individual user intelligence still works without cohort data
    console.error(`[PerformanceAgent] Cohort aggregation failed for user ${userId}:`, err.message);
  }
}

// ----------------------------------------------------------------
// getCohortBenchmark — retrieves the best-matching cohort row for
// a user + platform + post_type combination.
// Used by /intelligence/preflight (intelligence.js).
//
// Falls back from specific (with business_type) → broad (any business_type)
// → platform-only (any post_type) until a match with sufficient sample is found.
// ----------------------------------------------------------------
async function getCohortBenchmark(userId, platform, postType) {
  try {
    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('industry, business_type, geo_region')
      .eq('user_id', userId)
      .single();

    if (!profile?.industry) return null;

    const { industry, business_type, geo_region } = profile;

    // Try increasingly broad cohort keys until we find one with enough data
    const candidates = [
      // Most specific first
      [industry, business_type || 'any', geo_region || 'any', platform, postType || 'any'],
      // Ignore business_type
      [industry, 'any', geo_region || 'any', platform, postType || 'any'],
      // Ignore geo_region
      [industry, business_type || 'any', 'any', platform, postType || 'any'],
      // Ignore both business_type and geo
      [industry, 'any', 'any', platform, postType || 'any'],
      // Ignore post_type too (platform-level only)
      [industry, 'any', 'any', platform, 'any']
    ];

    for (const parts of candidates) {
      const cohortKey = parts.join('|');

      const { data: row } = await supabaseAdmin
        .from('cohort_performance')
        .select('*')
        .eq('cohort_key', cohortKey)
        .gte('sample_size', MIN_COHORT_SAMPLE)
        .single();

      if (row) return row;
    }

    return null; // No usable cohort data yet

  } catch (err) {
    console.error(`[PerformanceAgent] getCohortBenchmark failed:`, err.message);
    return null;
  }
}

// ================================================================
// Helpers
// ================================================================

function avg(arr, field) {
  if (!arr.length) return 0;
  return Math.round(arr.reduce((sum, item) => sum + (item[field] || 0), 0) / arr.length);
}

function arrAvg(arr) {
  if (!arr.length) return 0;
  return Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 100) / 100;
}

module.exports = {
  runPerformanceCycle,
  updateIntelligenceCache,
  getCohortBenchmark
};
