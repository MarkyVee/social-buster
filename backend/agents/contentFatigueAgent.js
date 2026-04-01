/**
 * agents/contentFatigueAgent.js
 *
 * Layer 3 Learning Agent — Content Fatigue Detection.
 *
 * WHAT THIS DOES:
 * Detects when a user is over-repeating a content pattern AND their audience's
 * engagement on that pattern is declining as a result.
 *
 * This is different from hookPerformanceAgent (which ranks formats by overall
 * average) and hookTrendAgent (which tracks momentum over two periods).
 * Fatigue is specifically the combination of TWO signals happening together:
 *
 *   1. HIGH FREQUENCY — the same format/type/tone appears in a disproportionate
 *      share of recent posts (threshold: >35% of posts in the last 30 days)
 *
 *   2. DECLINING ENGAGEMENT — that same format's engagement score has dropped
 *      meaningfully from the first half of the analysis window to the second
 *      (threshold: recent avg is <85% of early avg)
 *
 * Either signal alone is not fatigue:
 *   — Posting lots of one format that's still performing = audience preference, not fatigue
 *   — Declining engagement on a rarely-used format = weak format, not fatigue
 *
 * Both together = the audience has seen too much of this pattern and is tuning out.
 *
 * ANALYSIS WINDOW: 90 days (longer than other agents — we need enough history
 * to split into "early" and "recent" halves and see a real decline, not noise)
 *
 * WHAT IS CHECKED (three dimensions):
 *
 *   hook_format — the 6 format buckets from hookPerformanceAgent
 *                 (question/list/challenge/curiosity/story/statement)
 *   post_type   — from brief (educational/promotional/community_engagement/etc.)
 *   tone        — from brief (bold/friendly/professional/humorous/etc.)
 *
 * WHAT IT WRITES (signal_weights.content_fatigue):
 *   {
 *     "content_fatigue": {
 *       "by_hook_format": {
 *         "question": {
 *           "frequency":          0.62,  ← fraction of recent posts using this format
 *           "engagement_decline": 0.71,  ← recent_avg / early_avg (< 1 = declining)
 *           "fatigued":           true,
 *           "post_count":         18
 *         }
 *       },
 *       "by_post_type": {
 *         "educational": { "frequency": 0.55, "engagement_decline": 0.78, "fatigued": true, "post_count": 16 }
 *       },
 *       "by_tone": {
 *         "bold": { "frequency": 0.48, "engagement_decline": 0.95, "fatigued": false, "post_count": 14 }
 *       },
 *       "fatigue_warnings": ["question hooks", "educational posts"]
 *     }
 *   }
 *
 * WHAT THE LLM SEES (via contextBuilder):
 *   CONTENT FATIGUE WARNINGS:
 *   ⚠️ question hooks: used in 62% of recent posts, engagement down 29% — audience fatiguing
 *   ⚠️ educational posts: 55% of recent content, engagement down 22%
 *   → Diversify away from these patterns in this brief.
 *
 * MINIMUM DATA:
 *   — 15 posts total with metrics to run the analysis
 *   — 4 posts per format/type/tone to include it in the fatigue check
 *     (fewer than 4 = not enough repetition to cause fatigue anyway)
 *
 * THRESHOLDS:
 *   FREQUENCY_THRESHOLD  = 0.35  — format in >35% of recent posts = overuse risk
 *   DECLINE_THRESHOLD    = 0.85  — recent avg < 85% of early avg = meaningful decline
 *   Both must be true simultaneously to flag fatigue = true.
 *
 * Triggered by: signalWeightsWorker.js (weekly, after Layer 2 agents)
 */

const { supabaseAdmin }     = require('../services/supabaseService');
const { getAgentDirective } = require('../services/agentDirectiveService');
const { classifyHook }      = require('./hookPerformanceAgent');

const ANALYSIS_DAYS        = 90;
const MIN_POSTS_TOTAL      = 15;
const MIN_POSTS_PER_BUCKET = 4;
const FREQUENCY_THRESHOLD  = 0.35;  // >35% of recent posts = overuse
const DECLINE_THRESHOLD    = 0.85;  // Recent avg < 85% of early avg = fatigue

// ----------------------------------------------------------------
// calcEngagementScore — consistent formula across all agents.
// ----------------------------------------------------------------
function calcEngagementScore(likes, comments, shares, reach) {
  if (!reach || reach === 0) return 0;
  return ((likes + comments * 2 + shares * 3) / reach) * 100;
}

// ----------------------------------------------------------------
// analyseFatigue — given an array of { score, published_at } items
// for a single format/type/tone bucket:
//   1. Splits into early vs recent halves chronologically
//   2. Computes avg score per half
//   3. Returns { frequency, engagement_decline, fatigued, post_count }
//
// totalPosts = total posts across ALL buckets (for frequency calculation)
// recentPosts = posts from the last 30 days only (tighter frequency window)
// recentCount = how many of those recent posts used this bucket
// ----------------------------------------------------------------
function analyseBucket(scoredPosts, recentCount, totalRecentPosts) {
  const count = scoredPosts.length;
  if (count < MIN_POSTS_PER_BUCKET) return null;

  // Sort chronologically (oldest first)
  const sorted = [...scoredPosts].sort((a, b) =>
    new Date(a.published_at) - new Date(b.published_at)
  );

  // Split into two equal halves
  const midpoint  = Math.floor(sorted.length / 2);
  const earlyHalf = sorted.slice(0, midpoint);
  const recentHalf = sorted.slice(midpoint);

  const earlyAvg  = earlyHalf.reduce((s, p) => s + p.score, 0)  / earlyHalf.length;
  const recentAvg = recentHalf.reduce((s, p) => s + p.score, 0) / recentHalf.length;

  // Engagement decline ratio (recent / early). 0.71 means 29% drop.
  const engagementDecline = earlyAvg > 0
    ? Math.round((recentAvg / earlyAvg) * 100) / 100
    : 1.0;

  // Frequency = how often this format appeared in the LAST 30 DAYS
  // (tighter window catches current overuse, not historical pattern)
  const frequency = totalRecentPosts > 0
    ? Math.round((recentCount / totalRecentPosts) * 100) / 100
    : 0;

  // Fatigue requires both signals simultaneously
  const fatigued = frequency >= FREQUENCY_THRESHOLD && engagementDecline <= DECLINE_THRESHOLD;

  return {
    frequency,
    engagement_decline: engagementDecline,
    fatigued,
    post_count: count
  };
}

// ----------------------------------------------------------------
// runContentFatigueAnalysis — main export.
// ----------------------------------------------------------------
async function runContentFatigueAnalysis(userId) {
  console.log(`[ContentFatigueAgent] Analysing content fatigue for user ${userId}...`);

  const directive = await getAgentDirective('contentFatigueAgent', userId);

  const cutoff     = new Date(Date.now() - ANALYSIS_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const recentCutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // --- Step 1: Published posts in last 90 days ---
  const { data: posts, error: postsErr } = await supabaseAdmin
    .from('posts')
    .select('id, hook, brief_id, published_at')
    .eq('user_id', userId)
    .eq('status', 'published')
    .gte('published_at', cutoff)
    .order('published_at', { ascending: true });

  if (postsErr || !posts || posts.length < MIN_POSTS_TOTAL) {
    console.log(`[ContentFatigueAgent] Not enough posts for ${userId} (${posts?.length || 0}). Skipping.`);
    return;
  }

  // --- Step 2: Fetch brief metadata (post_type + tone) ---
  const briefIds = [...new Set(posts.map(p => p.brief_id).filter(Boolean))];
  const briefMap = {};

  if (briefIds.length > 0) {
    const { data: briefs } = await supabaseAdmin
      .from('briefs')
      .select('id, post_type, tone')
      .in('id', briefIds);

    (briefs || []).forEach(b => { briefMap[b.id] = { post_type: b.post_type, tone: b.tone }; });
  }

  // --- Step 3: Fetch and average metrics ---
  const postIds = posts.map(p => p.id);
  const { data: metrics, error: metricsErr } = await supabaseAdmin
    .from('post_metrics')
    .select('post_id, likes, comments, shares, reach')
    .in('post_id', postIds);

  if (metricsErr || !metrics || metrics.length === 0) {
    console.log(`[ContentFatigueAgent] No metrics for ${userId}. Skipping.`);
    return;
  }

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

  // --- Step 4: Score every post and attach dimension labels ---
  const scoredPosts = [];
  let totalRecent = 0;

  posts.forEach(post => {
    const m = metricsMap[post.id];
    if (!m || m.count === 0) return;

    const avgLikes    = m.likes    / m.count;
    const avgComments = m.comments / m.count;
    const avgShares   = m.shares   / m.count;
    const avgReach    = m.reach    / m.count;
    const score       = calcEngagementScore(avgLikes, avgComments, avgShares, avgReach);

    const brief      = post.brief_id ? briefMap[post.brief_id] : null;
    const hookFormat = post.hook ? classifyHook(post.hook) : null;
    const isRecent   = post.published_at >= recentCutoff;

    if (isRecent) totalRecent++;

    scoredPosts.push({
      id:           post.id,
      published_at: post.published_at,
      score,
      hook_format:  hookFormat !== 'unknown' ? hookFormat : null,
      post_type:    brief?.post_type || null,
      tone:         brief?.tone      || null,
      is_recent:    isRecent
    });
  });

  if (scoredPosts.length < MIN_POSTS_TOTAL) {
    console.log(`[ContentFatigueAgent] Only ${scoredPosts.length} posts with metrics for ${userId}. Skipping.`);
    return;
  }

  // --- Step 5: Build dimension buckets and run fatigue analysis ---
  // For each dimension (hook_format, post_type, tone), group posts and analyse.

  function buildBuckets(dimension) {
    const all    = {};  // key → [{ score, published_at }]
    const recent = {};  // key → count of recent posts

    scoredPosts.forEach(p => {
      const key = p[dimension];
      if (!key) return;

      if (!all[key]) all[key] = [];
      all[key].push({ score: p.score, published_at: p.published_at });

      if (p.is_recent) {
        recent[key] = (recent[key] || 0) + 1;
      }
    });

    const results = {};
    for (const [key, items] of Object.entries(all)) {
      const recentCount = recent[key] || 0;
      const result = analyseBucket(items, recentCount, totalRecent);
      if (result) results[key] = result;
    }
    return results;
  }

  const byHookFormat = buildBuckets('hook_format');
  const byPostType   = buildBuckets('post_type');
  const byTone       = buildBuckets('tone');

  // Collect human-readable fatigue warnings for contextBuilder
  const fatigueWarnings = [];

  Object.entries(byHookFormat).forEach(([format, data]) => {
    if (data.fatigued) fatigueWarnings.push(`${format} hooks`);
  });
  Object.entries(byPostType).forEach(([type, data]) => {
    if (data.fatigued) fatigueWarnings.push(`${type} posts`);
  });
  Object.entries(byTone).forEach(([tone, data]) => {
    if (data.fatigued) fatigueWarnings.push(`${tone} tone`);
  });

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
    content_fatigue: {
      by_hook_format:   byHookFormat,
      by_post_type:     byPostType,
      by_tone:          byTone,
      fatigue_warnings: fatigueWarnings
    },
    content_fatigue_updated_at: new Date().toISOString(),
    ...(directive ? { agent_directive_fatigue: directive } : {})
  };

  const { error: updateErr } = await supabaseAdmin
    .from('user_profiles')
    .update({ signal_weights: updated })
    .eq('user_id', userId);

  if (updateErr) {
    console.error(`[ContentFatigueAgent] Failed to save for ${userId}:`, updateErr.message);
    return;
  }

  const warnStr = fatigueWarnings.length > 0
    ? fatigueWarnings.join(', ')
    : 'none detected';

  console.log(`[ContentFatigueAgent] ${userId} — ${scoredPosts.length} posts analysed | Fatigue warnings: ${warnStr}`);
}

module.exports = { runContentFatigueAnalysis };
