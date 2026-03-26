/**
 * routes/webhooks.js
 *
 * Receives incoming webhooks from Meta (Facebook + Instagram).
 *
 * Handles TWO types of real-time events:
 *   1. Feed events (comments) — triggers instant DM automation
 *   2. Message events (DM replies) — advances multi-step DM conversations
 *
 * This is the INSTANT path for DM automation. When someone comments on
 * a Page post, Meta pushes the comment here within seconds. We match it
 * against trigger keywords and send the DM immediately — no 15-minute
 * polling delay. The polling worker is kept as a safety net.
 *
 * Endpoints:
 *   GET  /webhooks/meta — verification challenge (one-time setup)
 *   POST /webhooks/meta — incoming message/event payloads
 *
 * Setup steps (one-time, in Meta Developer Portal):
 *   1. Go to your app → Webhooks (under the relevant use case)
 *   2. Callback URL: https://social-buster.com/webhooks/meta
 *   3. Verify Token: set META_WEBHOOK_VERIFY_TOKEN in .env
 *   4. Subscribe to: messages (for DM replies) AND feed (for comments)
 *
 * IMPORTANT: This route must be mounted BEFORE express.json() middleware
 * because Meta webhook signature verification needs the raw request body.
 * However, we handle our own body parsing here so it works either way.
 *
 * Security:
 *   - Verify X-Hub-Signature-256 header using FACEBOOK_APP_SECRET
 *   - Reject any payload that doesn't match the signature
 */

const express  = require('express');
const crypto   = require('crypto');
const router   = express.Router();
const { processIncomingReply } = require('../agents/dmAgent');
const { processRealtimeComment } = require('../agents/commentAgent');
const { supabaseAdmin } = require('../services/supabaseService');

// ----------------------------------------------------------------
// Decode Meta's signed_request parameter.
// Used by deauthorization and data deletion callbacks.
// Returns { user_id, algorithm, issued_at } or null on failure.
// ----------------------------------------------------------------
function decodeSignedRequest(signedRequest, appSecret) {
  try {
    if (!signedRequest || !appSecret) return null;

    const [encodedSig, payload] = signedRequest.split('.');
    if (!encodedSig || !payload) return null;

    // Base64url decode
    const b64Decode = (str) => Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

    const sig  = b64Decode(encodedSig);
    const data = JSON.parse(b64Decode(payload).toString('utf8'));

    // Verify HMAC-SHA256 signature
    const expectedSig = crypto
      .createHmac('sha256', appSecret)
      .update(payload)
      .digest();

    if (!crypto.timingSafeEqual(sig, expectedSig)) {
      console.error('[Webhooks] signed_request signature mismatch');
      return null;
    }

    return data;
  } catch (err) {
    console.error('[Webhooks] Failed to decode signed_request:', err.message);
    return null;
  }
}

// ----------------------------------------------------------------
// GET /webhooks/meta — Meta verification challenge.
//
// When you first register the webhook in the Meta Developer Portal,
// Meta sends a GET request with hub.mode, hub.verify_token, and hub.challenge.
// We verify the token matches our .env value and echo back the challenge.
// ----------------------------------------------------------------
router.get('/', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN;

  if (!verifyToken) {
    console.error('[Webhooks] META_WEBHOOK_VERIFY_TOKEN not set — cannot verify');
    return res.sendStatus(403);
  }

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[Webhooks] Meta webhook verified successfully');
    return res.status(200).send(challenge);
  }

  console.warn('[Webhooks] Meta webhook verification failed — token mismatch');
  return res.sendStatus(403);
});

// ----------------------------------------------------------------
// POST /webhooks/meta — incoming webhook events.
//
// Meta sends events for messages, message_reads, message_deliveries, etc.
// We only care about 'messages' events (user replied to our DM).
//
// Payload structure (simplified):
//   {
//     object: 'page' | 'instagram',
//     entry: [{
//       id: '<page_id>',
//       messaging: [{
//         sender: { id: '<user_psid>' },
//         recipient: { id: '<page_id>' },
//         message: { text: '...' }
//       }]
//     }]
//   }
// ----------------------------------------------------------------
router.post('/', express.raw({ type: 'application/json' }), async (req, res) => {
  // Always respond 200 quickly — Meta will retry if we don't respond within 5 seconds
  // Process the payload asynchronously after responding.
  res.sendStatus(200);

  try {
    // MANDATORY signature verification — reject ALL webhooks if app secret is not configured.
    // Without this, anyone could POST fake webhook events and trigger DM automation.
    const appSecret = process.env.FACEBOOK_APP_SECRET || process.env.META_APP_SECRET;
    if (!appSecret) {
      console.error('[Webhooks] FACEBOOK_APP_SECRET / META_APP_SECRET not set — rejecting webhook (security)');
      return;
    }

    const signature = req.headers['x-hub-signature-256'];
    if (!signature) {
      console.warn('[Webhooks] Missing X-Hub-Signature-256 header — rejecting');
      return;
    }

    const rawBody = typeof req.body === 'string' ? req.body : req.body.toString('utf8');
    const expected = 'sha256=' + crypto
      .createHmac('sha256', appSecret)
      .update(rawBody)
      .digest('hex');

    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      console.warn('[Webhooks] Invalid signature — payload rejected');
      return;
    }

    // Parse the body (may already be parsed by express.json or still raw)
    let body;
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      body = req.body;
    } else {
      body = JSON.parse(typeof req.body === 'string' ? req.body : req.body.toString('utf8'));
    }

    // Determine platform from the object field
    const platform = body.object === 'instagram' ? 'instagram' : 'facebook';

    // Process each entry
    for (const entry of (body.entry || [])) {
      const pageId = entry.id;

      // ---- REAL-TIME COMMENTS (feed + comments webhooks) ----
      // Facebook sends comment events via entry.changes with field === 'feed'.
      // Instagram sends comment events via entry.changes with field === 'comments'.
      // Both are handled here for instant DM automation — no polling delay.
      for (const change of (entry.changes || [])) {
        // Facebook: field === 'feed', Instagram: field === 'comments'
        if (change.field !== 'feed' && change.field !== 'comments') continue;

        const val = change.value || {};

        // ---- Facebook feed events ----
        // Structure: val.item === 'comment', val.verb === 'add'
        // Fields: val.message, val.comment_id, val.from.id, val.from.name, val.post_id
        if (change.field === 'feed') {
          if (val.item !== 'comment' || val.verb !== 'add') continue;

          const commentText  = val.message;
          const commentId    = val.comment_id;
          const authorId     = val.from?.id;
          const authorName   = val.from?.name;
          const parentPostId = val.post_id;

          if (!commentText || !commentId || !parentPostId) continue;
          if (authorId === pageId) continue;

          console.log(`[Webhooks] Realtime facebook comment from ${authorName || authorId}: "${commentText.substring(0, 50)}..."`);

          try {
            await processRealtimeComment(
              pageId, parentPostId, commentId,
              commentText, authorId, authorName, 'facebook'
            );
          } catch (err) {
            console.error(`[Webhooks] Error processing realtime comment ${commentId}:`, err.message);
          }
          continue;
        }

        // ---- Instagram comment events ----
        // Structure: val.id (comment ID), val.text, val.from.id, val.from.username
        // val.media.id (the IG media ID that was commented on)
        if (change.field === 'comments') {
          const commentText  = val.text;
          const commentId    = val.id;
          const authorId     = val.from?.id;
          const authorName   = val.from?.username;
          const mediaId      = val.media?.id;  // Instagram media ID

          if (!commentText || !commentId || !mediaId) continue;
          if (authorId === pageId) continue;

          console.log(`[Webhooks] Realtime instagram comment from ${authorName || authorId}: "${commentText.substring(0, 50)}..."`);

          try {
            await processRealtimeComment(
              pageId, mediaId, commentId,
              commentText, authorId, authorName, 'instagram'
            );
          } catch (err) {
            console.error(`[Webhooks] Error processing realtime IG comment ${commentId}:`, err.message);
          }
          continue;
        }
      }

      // ---- DM REPLIES (messaging webhook) ----
      // Meta sends message events via entry.messaging.
      // This handles multi-step DM conversation replies.
      for (const event of (entry.messaging || [])) {
        // Only process actual messages (not reads, deliveries, etc.)
        if (!event.message || !event.message.text) continue;

        const senderPlatformId = event.sender?.id;
        const messageText      = event.message.text;

        if (!senderPlatformId || !messageText) continue;

        // Don't process echo messages (messages WE sent)
        if (event.message.is_echo) continue;

        console.log(`[Webhooks] Incoming ${platform} DM from ${senderPlatformId}: "${messageText.substring(0, 50)}..."`);

        try {
          await processIncomingReply(senderPlatformId, messageText, platform);
        } catch (err) {
          console.error(`[Webhooks] Error processing reply from ${senderPlatformId}:`, err.message);
        }
      }
    }

  } catch (err) {
    console.error('[Webhooks] Error processing Meta webhook:', err.message);
  }
});

// ----------------------------------------------------------------
// POST /webhooks/meta/deauthorize
//
// Meta calls this when a user removes your app from their Facebook or
// Instagram account. Required field in Meta App Settings.
// URL to register: https://social-buster.com/webhooks/meta/deauthorize
//
// Meta sends a signed_request in the body. In production you'd decode
// the signed_request to find the user_id and revoke their connection.
// ----------------------------------------------------------------
router.post('/deauthorize', (req, res) => {
  // Acknowledge immediately — Meta expects a fast 200
  res.sendStatus(200);

  // Process asynchronously so we don't block the response
  (async () => {
    try {
      const appSecret = process.env.FACEBOOK_APP_SECRET || process.env.META_APP_SECRET;
      const decoded = decodeSignedRequest(req.body?.signed_request, appSecret);

      if (!decoded?.user_id) {
        console.error('[Webhooks] Deauthorize: could not decode signed_request or missing user_id');
        return;
      }

      const platformUserId = String(decoded.user_id);
      console.log(`[Webhooks] Deauthorize: removing connections for platform user ${platformUserId}`);

      // Delete all platform connections matching this Meta user ID.
      // This covers both Facebook Pages and Instagram accounts connected via this user.
      const { error } = await supabaseAdmin
        .from('platform_connections')
        .delete()
        .eq('platform_user_id', platformUserId);

      if (error) {
        console.error(`[Webhooks] Deauthorize DB error: ${error.message}`);
      } else {
        console.log(`[Webhooks] Deauthorize: deleted connection(s) for platform user ${platformUserId}`);
      }
    } catch (err) {
      console.error('[Webhooks] Deauthorize processing error:', err.message);
    }
  })();
});

// ----------------------------------------------------------------
// GET  /webhooks/meta/data-deletion  (Meta redirects users here)
// POST /webhooks/meta/data-deletion  (Meta calls this as a webhook)
//
// Required by Meta for GDPR / data deletion requests.
// When a user asks Facebook to delete their data, Meta calls this endpoint.
// Must return JSON with a confirmation_code and a url where the user
// can check the status of their deletion request.
// URL to register: https://social-buster.com/webhooks/meta/data-deletion
// ----------------------------------------------------------------
router.all('/data-deletion', async (req, res) => {
  try {
    const appSecret = process.env.FACEBOOK_APP_SECRET || process.env.META_APP_SECRET;
    const signedRequest = req.body?.signed_request || req.query?.signed_request;
    const decoded = decodeSignedRequest(signedRequest, appSecret);

    const confirmationCode = `sb-del-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const platformUserId = decoded?.user_id ? String(decoded.user_id) : null;

    console.log(`[Webhooks] Data deletion request. Code: ${confirmationCode}, platform_user_id: ${platformUserId || 'unknown'}`);

    // Store the deletion request so the status page can look it up
    const { error: insertError } = await supabaseAdmin
      .from('data_deletion_requests')
      .insert({
        confirmation_code: confirmationCode,
        platform_user_id:  platformUserId,
        status:            'pending',
        requested_at:      new Date().toISOString()
      });

    if (insertError) {
      // Table may not exist yet — log but don't fail the response to Meta
      console.error(`[Webhooks] Failed to store deletion request: ${insertError.message}`);
    }

    // Process deletion asynchronously
    if (platformUserId) {
      (async () => {
        try {
          // Find the internal user_id from platform_connections
          const { data: connections } = await supabaseAdmin
            .from('platform_connections')
            .select('user_id')
            .eq('platform_user_id', platformUserId);

          const userIds = [...new Set((connections || []).map(c => c.user_id))];

          for (const userId of userIds) {
            console.log(`[Webhooks] Data deletion: purging META-SOURCED data for user ${userId}`);

            // ONLY delete data that came from Meta's APIs.
            // Keep: posts, briefs, media, user_profiles, post_metrics (aggregated),
            //        billing — these are OUR data, not Meta's.

            // 1. DM conversations + collected leads (Meta messaging data)
            await supabaseAdmin.from('dm_collected_data').delete().eq('user_id', userId);
            await supabaseAdmin.from('dm_conversations').delete().eq('user_id', userId);

            // 2. DM automation steps + automations (tied to Meta pages/posts)
            const { data: automations } = await supabaseAdmin
              .from('dm_automations')
              .select('id')
              .eq('user_id', userId);
            const autoIds = (automations || []).map(a => a.id);
            if (autoIds.length > 0) {
              await supabaseAdmin.from('dm_automation_steps').delete().in('automation_id', autoIds);
            }
            await supabaseAdmin.from('dm_automations').delete().eq('user_id', userId);

            // 3. Comments — ANONYMIZE, not delete.
            // Comments are public data authored by third-party users (commenters),
            // not the Page owner requesting deletion. They feed our intelligence
            // engine (sentiment analysis, research, cohort benchmarks). Deleting
            // them would break agents and lose irreplaceable research data.
            // Instead: strip author_handle and unlink from post_id so they can't
            // be traced back to the disconnected Page. The comment text, sentiment,
            // and platform remain as anonymous research data points.
            const { data: userPosts } = await supabaseAdmin
              .from('posts')
              .select('id')
              .eq('user_id', userId);
            const postIds = (userPosts || []).map(p => p.id);
            if (postIds.length > 0) {
              await supabaseAdmin
                .from('comments')
                .update({
                  author_handle: null,
                  platform_comment_id: null,
                  post_id: null
                })
                .in('post_id', postIds);
              console.log(`[Webhooks] Anonymized comments for ${postIds.length} posts (user ${userId})`);
            }

            // 4. Platform connections (OAuth tokens — Meta's tokens must be revoked)
            await supabaseAdmin.from('platform_connections').delete().eq('user_id', userId);

            // PRESERVED (not Meta's data):
            // - posts: AI-generated by us, user approved them
            // - briefs: user created these
            // - media_items: from Google Drive, not Meta
            // - post_metrics: aggregated performance data, feeds intelligence
            // - user_profiles: signed up with email, not Facebook Login
            // - billing/subscription: Stripe data, not Meta

            console.log(`[Webhooks] Meta data deletion complete for user ${userId}`);
          }

          // Mark deletion as completed
          await supabaseAdmin
            .from('data_deletion_requests')
            .update({ status: 'completed', completed_at: new Date().toISOString() })
            .eq('confirmation_code', confirmationCode);

          console.log(`[Webhooks] Data deletion request ${confirmationCode} completed`);
        } catch (err) {
          console.error(`[Webhooks] Data deletion processing error: ${err.message}`);
          // Mark as failed
          await supabaseAdmin
            .from('data_deletion_requests')
            .update({ status: 'failed', error_message: err.message })
            .eq('confirmation_code', confirmationCode)
            .catch(() => {});
        }
      })();
    }

    const baseUrl = process.env.FRONTEND_URL || 'https://social-buster.com';
    return res.json({
      url:               `${baseUrl}/data-deleted.html?code=${confirmationCode}`,
      confirmation_code: confirmationCode
    });

  } catch (err) {
    console.error('[Webhooks] Data deletion handler error:', err.message);
    // Still return a valid response so Meta doesn't retry
    const fallbackCode = `sb-del-error-${Date.now()}`;
    return res.json({
      url:               `${process.env.FRONTEND_URL || 'https://social-buster.com'}/data-deleted.html`,
      confirmation_code: fallbackCode
    });
  }
});

// ----------------------------------------------------------------
// GET /webhooks/meta/data-deletion-status
// Status check endpoint for the data-deleted.html page.
// ----------------------------------------------------------------
router.get('/data-deletion-status', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.json({ status: 'not_found', message: 'No confirmation code provided.' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('data_deletion_requests')
      .select('status, requested_at, completed_at')
      .eq('confirmation_code', code)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      return res.json({ status: 'not_found', message: 'Confirmation code not found.' });
    }

    return res.json({
      status:       data.status,
      requested_at: data.requested_at,
      completed_at: data.completed_at
    });
  } catch (err) {
    console.error('[Webhooks] Deletion status check error:', err.message);
    return res.json({ status: 'error', message: 'Unable to check status.' });
  }
});

module.exports = router;
