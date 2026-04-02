/**
 * agents/commentAgent.js
 *
 * Background agent that ingests and analyzes comments on published posts.
 * Runs every 15 minutes for all users who have published posts in the last 30 days.
 *
 * What it does per cycle:
 *   1. Fetches all published posts from the last 30 days.
 *   2. For each post, fetches new comments since the last check.
 *   3. Runs sentiment analysis on each comment (keyword-based — no external API).
 *   4. Checks each comment against:
 *      a) Per-post DM automations (dm_automations table — primary)
 *      b) Legacy global trigger phrases (trigger_phrases table — fallback)
 *   5. Stores the comment in the DB.
 *   6. If a trigger matched, starts a DM conversation via dmAgent (direct Meta API).
 *
 * DM delivery uses the Meta Graph API directly (messagingService.js).
 * No external workflow engine (n8n) required.
 */

const { supabaseAdmin } = require('../services/supabaseService');
const { decryptToken }  = require('../services/tokenEncryption');
const { fetchComments } = require('../services/platformAPIs');
const { cacheGet, cacheSet } = require('../services/redisService');
const { startConversation }  = require('./dmAgent');

// Platforms that support DM automation (Meta Graph API)
const DM_SUPPORTED_PLATFORMS = ['facebook', 'instagram'];

// ----------------------------------------------------------------
// runCommentCycle — the main comment ingestion cycle.
// Called by workers/commentWorker.js on a 15-minute repeating job.
// ----------------------------------------------------------------
async function runCommentCycle() {
  console.log('[CommentAgent] Starting comment cycle...');

  try {
    // Scan published posts from the last 30 days only, paginated in batches of 500
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const PAGE_SIZE = 500;
    let offset = 0;

    while (true) {
      const { data: batch, error } = await supabaseAdmin
        .from('posts')
        .select('id, user_id, platform, platform_post_id, platform_page_id, published_at')
        .eq('status', 'published')
        .gte('published_at', cutoff)
        .not('platform_post_id', 'is', null)
        .order('published_at', { ascending: true })
        .range(offset, offset + PAGE_SIZE - 1);

      if (error) {
        console.error('[CommentAgent] Failed to fetch published posts:', error.message);
        return;
      }

      if (!batch || batch.length === 0) break;

      // Group this batch by user
      const byUser = {};
      batch.forEach(post => {
        if (!byUser[post.user_id]) byUser[post.user_id] = [];
        byUser[post.user_id].push(post);
      });

      // Process up to 5 users concurrently within this batch.
      // Each user's errors are isolated — one failure doesn't block others.
      // We cap at 5 to avoid hammering the Meta API and Supabase simultaneously.
      const userEntries = Object.entries(byUser);
      const CONCURRENT_USERS = 5;
      for (let i = 0; i < userEntries.length; i += CONCURRENT_USERS) {
        const chunk = userEntries.slice(i, i + CONCURRENT_USERS);
        await Promise.all(chunk.map(([userId, posts]) =>
          processUserComments(userId, posts).catch(err =>
            console.error(`[CommentAgent] Error for user ${userId}:`, err.message)
          )
        ));
      }

      if (batch.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

  } catch (err) {
    // Re-throw so BullMQ marks the job as failed and triggers retry
    console.error('[CommentAgent] Unexpected error in comment cycle:', err.message);
    throw err;
  }

  console.log('[CommentAgent] Comment cycle complete.');
}

// ----------------------------------------------------------------
// processUserComments — fetches and processes comments for one user's posts.
// ----------------------------------------------------------------
async function processUserComments(userId, posts) {
  // Early exit: skip users with no platform connections.
  // Saves one platform_connections query per post for disconnected users.
  const { count: connCount } = await supabaseAdmin
    .from('platform_connections')
    .select('user_id', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (!connCount || connCount === 0) return;

  // Load per-post DM automations for this user (active only)
  const { data: automations } = await supabaseAdmin
    .from('dm_automations')
    .select('id, post_id, name, flow_type, trigger_keywords, active')
    .eq('user_id', userId)
    .eq('active', true);

  // Also load legacy trigger_phrases for backward compatibility
  const { data: legacyTriggers } = await supabaseAdmin
    .from('trigger_phrases')
    .select('*')
    .eq('user_id', userId)
    .eq('active', true);

  const activeAutomations = automations || [];
  const activeLegacyTriggers = legacyTriggers || [];

  for (const post of posts) {
    try {
      // Get the decrypted access token for the Page this post was published to.
      // If post has platform_page_id, look up that specific connection.
      // Fallback: parse page ID from platform_post_id (Facebook format: {page_id}_{post_id}).
      // Last resort: most recent connection for that platform.
      const effectivePageId = post.platform_page_id
        || (post.platform_post_id && post.platform_post_id.includes('_')
            ? post.platform_post_id.split('_')[0] : null);

      let connQuery = supabaseAdmin
        .from('platform_connections')
        .select('access_token, platform_user_id, token_expires_at')
        .eq('user_id', userId)
        .eq('platform', post.platform);

      if (effectivePageId) {
        connQuery = connQuery.eq('platform_user_id', effectivePageId);
      } else {
        connQuery = connQuery.order('connected_at', { ascending: false }).limit(1);
      }

      const { data: connRows } = await connQuery;
      const connection = connRows?.[0];

      if (!connection) continue;

      let accessToken;
      try {
        accessToken = decryptToken(connection.access_token);
      } catch {
        continue; // Skip — can't decrypt token
      }

      // Use a Redis cursor so we only fetch NEW comments each cycle
      const cursorKey = `comment_cursor:${post.id}`;
      const since     = await cacheGet(cursorKey);

      const newComments = await fetchComments(
        post.platform_post_id, post.platform, accessToken, since
      );

      if (!newComments || newComments.length === 0) continue;

      // Find automations that apply to this post
      // Per-post automations match on post_id. Global automations have post_id = null.
      const postAutomations = activeAutomations.filter(
        a => a.post_id === post.id || a.post_id === null
      );

      // Process and store each new comment
      for (const comment of newComments) {
        await processComment(
          userId, post, comment,
          postAutomations, activeLegacyTriggers,
          accessToken, connection.platform_user_id
        );
      }

      // Advance the cursor to now for the next cycle
      await cacheSet(cursorKey, new Date().toISOString(), 7 * 24 * 3600);

    } catch (err) {
      console.error(`[CommentAgent] Error processing post ${post.id}:`, err.message);
    }
  }
}

// ----------------------------------------------------------------
// processComment — analyzes and stores one comment, starts DM if triggered.
// ----------------------------------------------------------------
async function processComment(userId, post, comment, automations, legacyTriggers, accessToken, pageId) {
  // Guard against duplicates — the UNIQUE constraint on platform_comment_id handles this
  // but we check first to avoid wasting a DB call
  const { data: existing } = await supabaseAdmin
    .from('comments')
    .select('id')
    .eq('platform_comment_id', comment.platformCommentId)
    .single();

  if (existing) return;

  const sentiment = analyzeSentiment(comment.text);

  // Try to match against DM automations first (per-post, then global)
  const matchedAutomation = matchAutomationKeyword(comment.text, automations);

  // Fall back to legacy trigger_phrases if no automation matched
  const matchedLegacy = !matchedAutomation
    ? matchTriggerPhrase(comment.text, legacyTriggers, post.platform)
    : null;

  const triggerMatched = !!(matchedAutomation || matchedLegacy);

  // Store the comment in the database
  const { error: insertError } = await supabaseAdmin
    .from('comments')
    .insert({
      user_id:             userId,
      post_id:             post.id,
      platform:            post.platform,
      platform_comment_id: comment.platformCommentId,
      comment_text:        comment.text,
      author_handle:       comment.authorHandle,
      author_platform_id:  comment.authorPlatformId || null,
      sentiment,
      trigger_matched: triggerMatched,
      dm_sent:         false
    });

  if (insertError) {
    // UNIQUE violation is a harmless race condition — log anything else
    if (!insertError.message?.includes('unique')) {
      console.error('[CommentAgent] Insert error:', insertError.message);
    }
    return;
  }

  // Start a DM conversation if a trigger matched AND the platform supports DMs
  if (matchedAutomation && DM_SUPPORTED_PLATFORMS.includes(post.platform)) {
    if (!comment.authorPlatformId) {
      console.warn(`[CommentAgent] Trigger matched for @${comment.authorHandle} but no authorPlatformId — cannot DM`);
      return;
    }

    try {
      await startConversation(
        userId,
        matchedAutomation,
        {
          platformCommentId: comment.platformCommentId,
          text:              comment.text,
          authorHandle:      comment.authorHandle,
          authorPlatformId:  comment.authorPlatformId
        },
        post.platform,
        accessToken,
        pageId  // so DM worker uses the right Page's token
      );
    } catch (err) {
      console.error(`[CommentAgent] Failed to start DM conversation for @${comment.authorHandle}:`, err.message);
    }
  }
}

// ----------------------------------------------------------------
// matchAutomationKeyword — checks comment text against dm_automations keywords.
// Uses the same normalization as the legacy matcher.
// Returns the matched automation, or null.
// ----------------------------------------------------------------
function matchAutomationKeyword(commentText, automations) {
  if (!commentText || !automations.length) return null;

  const normalizedComment = commentText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim();

  for (const automation of automations) {
    if (!automation.trigger_keywords || !automation.trigger_keywords.length) continue;

    for (const keyword of automation.trigger_keywords) {
      const normalizedKeyword = keyword
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .trim();

      if (normalizedComment.includes(normalizedKeyword)) {
        return automation;
      }
    }
  }

  return null;
}

// ----------------------------------------------------------------
// analyzeSentiment — keyword-based sentiment classification.
// Returns 'positive' | 'neutral' | 'negative'.
//
// No external API needed — fast and free. For higher accuracy in
// production consider AWS Comprehend or a small fine-tuned model.
// ----------------------------------------------------------------
const POSITIVE_WORDS = [
  'love', 'great', 'amazing', 'awesome', 'fantastic', 'excellent', 'perfect',
  'wonderful', 'best', 'beautiful', 'helpful', 'thank you', 'thanks', 'need this',
  'want this', 'incredible', 'brilliant', 'superb', 'outstanding'
];
const NEGATIVE_WORDS = [
  'hate', 'terrible', 'awful', 'horrible', 'worst', 'bad', 'useless', 'scam',
  'fake', 'ridiculous', 'disappointed', 'waste', 'poor', 'disgusting',
  'broken', 'doesn\'t work', 'rip off'
];

function analyzeSentiment(text) {
  if (!text) return 'neutral';

  const lower = text.toLowerCase();
  const pos = POSITIVE_WORDS.filter(w => lower.includes(w)).length;
  const neg = NEGATIVE_WORDS.filter(w => lower.includes(w)).length;

  if (pos > neg) return 'positive';
  if (neg > pos) return 'negative';
  return 'neutral';
}

// ----------------------------------------------------------------
// matchTriggerPhrase — legacy global trigger phrase matching.
// Kept for backward compatibility with existing trigger_phrases table.
// New automations should use dm_automations instead.
// ----------------------------------------------------------------
function matchTriggerPhrase(commentText, triggers, platform) {
  if (!commentText || !triggers.length) return null;

  const normalizedComment = commentText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim();

  for (const trigger of triggers) {
    if (trigger.platform && trigger.platform !== platform) continue;

    const normalizedPhrase = trigger.phrase
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .trim();

    if (normalizedComment.includes(normalizedPhrase)) {
      return trigger;
    }
  }

  return null;
}

// ----------------------------------------------------------------
// processRealtimeComment — handles a single comment from a Meta webhook.
//
// Called by webhooks.js when Meta sends a real-time feed event.
// This is the INSTANT path — no polling delay. The 15-minute polling
// cycle is the safety net that catches anything webhooks miss.
//
// Webhook payload gives us: pageId, postId (platform_post_id), comment
// text, commenter ID, and commenter name. We look up the internal post,
// load automations + access token, and delegate to processComment().
//
// Deduplication is handled by processComment() via platform_comment_id
// UNIQUE constraint — if the polling cycle also picks up this comment,
// the duplicate insert is silently ignored.
// ----------------------------------------------------------------
async function processRealtimeComment(pageId, platformPostId, commentId, commentText, authorId, authorName, platform) {
  try {
    // Find the internal post by platform_post_id.
    //
    // Facebook webhook sends val.post_id as "{page_id}_{post_id}" (e.g. "270008739520883_122273...").
    // But we may have stored just the object ID portion when publishing (e.g. video returns only its
    // video object ID, text posts return the full "{page_id}_{post_id}" from the /feed endpoint).
    //
    // Strategy: try exact match first. If not found, try the portion after the FIRST underscore
    // (strips the page_id prefix). Also try just the page_id lookup as a last resort
    // so we catch any post on that page if both ID formats fail.
    let post = null;

    // Build candidate IDs to try in order:
    //   1. Exact webhook ID (e.g. "270008739520883_122273...")
    //   2. Part after first underscore (e.g. "122273...") — matches video object IDs stored without prefix
    //   3. Fallback: most recent published post on this page (catches edge cases)
    const candidateIds = [platformPostId];
    if (platformPostId && platformPostId.includes('_')) {
      candidateIds.push(platformPostId.split('_').slice(1).join('_'));
    }

    for (const candidateId of candidateIds) {
      const { data, error } = await supabaseAdmin
        .from('posts')
        .select('id, user_id, platform, platform_post_id, platform_page_id, published_at')
        .eq('platform_post_id', candidateId)
        .eq('status', 'published')
        .maybeSingle();

      if (!error && data) {
        post = data;
        if (candidateId !== platformPostId) {
          console.log(`[CommentAgent] Realtime: matched post via alternate ID "${candidateId}" (webhook sent "${platformPostId}")`);
        }
        break;
      }
    }

    // Final fallback: look up by page ID — finds the most recently published post on this page.
    // This handles cases where the post ID format is completely different from what we stored.
    if (!post && pageId) {
      const { data, error } = await supabaseAdmin
        .from('posts')
        .select('id, user_id, platform, platform_post_id, platform_page_id, published_at')
        .eq('platform_page_id', pageId)
        .eq('platform', platform)
        .eq('status', 'published')
        .order('published_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!error && data) {
        post = data;
        console.log(`[CommentAgent] Realtime: matched post via page_id fallback (pageId=${pageId}, post_id=${data.platform_post_id})`);
      }
    }

    if (!post) {
      console.warn(`[CommentAgent] Realtime: post not found for platformPostId="${platformPostId}" platform=${platform} pageId=${pageId} — all lookup strategies exhausted`);
      return;
    }

    const userId = post.user_id;

    // Load active DM automations for this user (filtered to this post + globals)
    const { data: automations } = await supabaseAdmin
      .from('dm_automations')
      .select('id, post_id, name, flow_type, trigger_keywords, active')
      .eq('user_id', userId)
      .eq('active', true);

    const postAutomations = (automations || []).filter(
      a => a.post_id === post.id || a.post_id === null
    );

    // Load legacy trigger phrases (backward compatibility)
    const { data: legacyTriggers } = await supabaseAdmin
      .from('trigger_phrases')
      .select('*')
      .eq('user_id', userId)
      .eq('active', true);

    // Get the decrypted access token for the specific Page this comment came from.
    // The webhook gives us pageId — use it to find the exact connection.
    let connQuery = supabaseAdmin
      .from('platform_connections')
      .select('access_token, platform_user_id')
      .eq('user_id', userId)
      .eq('platform', post.platform);

    // Resolve the correct Page ID: webhook pageId > post.platform_page_id > parse from platform_post_id
    const effectivePageId = pageId
      || post.platform_page_id
      || (post.platform_post_id && post.platform_post_id.includes('_')
          ? post.platform_post_id.split('_')[0] : null);

    if (effectivePageId) {
      connQuery = connQuery.eq('platform_user_id', effectivePageId);
    } else {
      connQuery = connQuery.order('connected_at', { ascending: false }).limit(1);
    }

    const { data: connRows } = await connQuery;
    const connection = connRows?.[0];

    if (!connection) {
      console.warn(`[CommentAgent] Realtime: No ${post.platform} connection for user ${userId} (pageId: ${pageId})`);
      return;
    }

    let accessToken;
    try {
      accessToken = decryptToken(connection.access_token);
    } catch {
      console.error(`[CommentAgent] Realtime: Failed to decrypt token for user ${userId}`);
      return;
    }

    // Delegate to the same processComment() used by the polling cycle.
    // Deduplication is built in — duplicate platform_comment_id is silently ignored.
    await processComment(
      userId,
      post,
      {
        platformCommentId: commentId,
        text:              commentText,
        authorHandle:      authorName || '(unknown)',
        authorPlatformId:  authorId
      },
      postAutomations,
      legacyTriggers || [],
      accessToken,
      connection.platform_user_id  // pageId from the webhook's matching connection
    );

    console.log(`[CommentAgent] Realtime: Processed comment "${commentText.substring(0, 30)}..." on post ${post.id} (platformPostId matched: "${platformPostId}")`);

  } catch (err) {
    console.error('[CommentAgent] Realtime comment processing error:', err.message);
  }
}

module.exports = { runCommentCycle, analyzeSentiment, processRealtimeComment };
