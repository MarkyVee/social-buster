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
  const signedRequest = req.body?.signed_request || '(unknown)';
  console.log('[Webhooks] Meta deauthorize webhook received. signed_request:', signedRequest);

  // TODO (production): decode signed_request using FACEBOOK_APP_SECRET,
  // find user by platform_user_id, delete their row in platform_connections.

  return res.sendStatus(200);
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
  const signedRequest = req.body?.signed_request || req.query?.signed_request || '(unknown)';
  const confirmationCode = `sb-deletion-${Date.now()}`;
  console.log('[Webhooks] Meta data deletion request received. Code:', confirmationCode, 'signed_request:', signedRequest);

  // TODO (production): decode signed_request, find user, queue data cleanup,
  // store confirmation_code so the status_url page can show progress.

  return res.json({
    url:               `${process.env.FRONTEND_URL || 'https://social-buster.com'}/data-deleted`,
    confirmation_code: confirmationCode
  });
});

module.exports = router;
