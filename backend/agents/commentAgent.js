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
 *   4. Checks each comment against the user's active trigger phrases.
 *   5. Stores the comment in the DB.
 *   6. If a trigger phrase matched, fires a webhook to n8n to send the DM workflow.
 *
 * Trigger phrases are set by users in their settings.
 * When a comment contains "send me the link" (for example), n8n automatically DMs
 * the commenter with the user's configured message and form URL.
 *
 * .env required for DM automation: N8N_WEBHOOK_URL
 */

const { supabaseAdmin } = require('../services/supabaseService');
const { decryptToken }  = require('../services/tokenEncryption');
const { fetchComments } = require('../services/platformAPIs');
const { cacheGet, cacheSet } = require('../services/redisService');
const axios = require('axios');

// ----------------------------------------------------------------
// runCommentCycle — the main comment ingestion cycle.
// Called by workers/commentWorker.js on a 15-minute repeating job.
// ----------------------------------------------------------------
async function runCommentCycle() {
  console.log('[CommentAgent] Starting comment cycle...');

  try {
    // Scan published posts from the last 30 days only
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: publishedPosts, error } = await supabaseAdmin
      .from('posts')
      .select('id, user_id, platform, platform_post_id, published_at')
      .eq('status', 'published')
      .gte('published_at', cutoff)
      .not('platform_post_id', 'is', null);

    if (error) {
      console.error('[CommentAgent] Failed to fetch published posts:', error.message);
      return;
    }

    if (!publishedPosts || publishedPosts.length === 0) return;

    // Group posts by user
    const byUser = {};
    publishedPosts.forEach(post => {
      if (!byUser[post.user_id]) byUser[post.user_id] = [];
      byUser[post.user_id].push(post);
    });

    // Process each user (errors are isolated per user)
    for (const [userId, posts] of Object.entries(byUser)) {
      try {
        await processUserComments(userId, posts);
      } catch (err) {
        console.error(`[CommentAgent] Error for user ${userId}:`, err.message);
      }
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
  // Load all active trigger phrases for this user once (reuse across all posts)
  const { data: triggers } = await supabaseAdmin
    .from('trigger_phrases')
    .select('*')
    .eq('user_id', userId)
    .eq('active', true);

  const activeTriggers = triggers || [];

  for (const post of posts) {
    try {
      // Get the decrypted access token for this platform
      const { data: connection } = await supabaseAdmin
        .from('platform_connections')
        .select('access_token, token_expires_at')
        .eq('user_id', userId)
        .eq('platform', post.platform)
        .single();

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

      // Process and store each new comment
      for (const comment of newComments) {
        await processComment(userId, post, comment, activeTriggers);
      }

      // Advance the cursor to now for the next cycle
      await cacheSet(cursorKey, new Date().toISOString(), 7 * 24 * 3600);

    } catch (err) {
      console.error(`[CommentAgent] Error processing post ${post.id}:`, err.message);
    }
  }
}

// ----------------------------------------------------------------
// processComment — analyzes and stores one comment, fires n8n if triggered.
// ----------------------------------------------------------------
async function processComment(userId, post, comment, activeTriggers) {
  // Guard against duplicates — the UNIQUE constraint on platform_comment_id handles this
  // but we check first to avoid wasting a DB call
  const { data: existing } = await supabaseAdmin
    .from('comments')
    .select('id')
    .eq('platform_comment_id', comment.platformCommentId)
    .single();

  if (existing) return;

  const sentiment      = analyzeSentiment(comment.text);
  const matchedTrigger = matchTriggerPhrase(comment.text, activeTriggers, post.platform);

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
      sentiment,
      trigger_matched: !!matchedTrigger,
      dm_sent:         false
    });

  if (insertError) {
    // UNIQUE violation is a harmless race condition — log anything else
    if (!insertError.message?.includes('unique')) {
      console.error('[CommentAgent] Insert error:', insertError.message);
    }
    return;
  }

  // Fire the n8n DM workflow if a trigger phrase was matched
  if (matchedTrigger && matchedTrigger.dm_message) {
    await triggerN8nDM(userId, comment, matchedTrigger, post);
  }
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
  'want this', 'incredible', 'brilliant', 'superb', 'outstanding', 'brilliant'
];
const NEGATIVE_WORDS = [
  'hate', 'terrible', 'awful', 'horrible', 'worst', 'bad', 'useless', 'scam',
  'fake', 'ridiculous', 'disappointed', 'waste', 'poor', 'disgusting', 'awful',
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
// matchTriggerPhrase — fuzzy phrase matching.
// Normalizes both strings (lowercase, strip punctuation) before comparing.
// Returns the matched trigger object, or null if none matched.
// ----------------------------------------------------------------
function matchTriggerPhrase(commentText, triggers, platform) {
  if (!commentText || !triggers.length) return null;

  const normalizedComment = commentText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim();

  for (const trigger of triggers) {
    // Skip triggers scoped to a different platform
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
// triggerN8nDM — sends a webhook payload to n8n.
// n8n handles the actual DM delivery so we don't need platform DM SDKs here.
//
// Set N8N_WEBHOOK_URL in .env to the webhook URL of your n8n workflow.
// The workflow should:
//   1. Receive this payload.
//   2. Use the platform API to send a DM to comment.authorHandle.
//   3. Optionally log the conversion.
// ----------------------------------------------------------------
async function triggerN8nDM(userId, comment, trigger, post) {
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('[CommentAgent] N8N_WEBHOOK_URL not set — DM trigger skipped.');
    return;
  }

  try {
    await axios.post(webhookUrl, {
      event:          'trigger_phrase_matched',
      userId,
      platform:       post.platform,
      postId:         post.id,
      platformPostId: post.platform_post_id,
      comment: {
        id:     comment.platformCommentId,
        text:   comment.text,
        author: comment.authorHandle
      },
      dm: {
        message: trigger.dm_message,
        formUrl: trigger.form_url || null
      }
    }, { timeout: 10000 });

    // Mark the DB record as DM sent
    await supabaseAdmin
      .from('comments')
      .update({ dm_sent: true })
      .eq('platform_comment_id', comment.platformCommentId);

    console.log(`[CommentAgent] n8n DM triggered for @${comment.authorHandle} on ${post.platform}`);

  } catch (err) {
    console.error('[CommentAgent] Failed to trigger n8n webhook:', err.message);
    // Non-fatal — the comment is stored; DM can be retried manually if needed
  }
}

module.exports = { runCommentCycle, analyzeSentiment };
