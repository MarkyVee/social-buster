/**
 * routes/webhooks.js
 *
 * Receives incoming webhooks from Meta (Facebook + Instagram).
 * Used for DM automation — when a user replies to our automated DM,
 * Meta sends the reply here so we can advance the conversation.
 *
 * Two endpoints:
 *   GET  /webhooks/meta — verification challenge (one-time setup)
 *   POST /webhooks/meta — incoming message/event payloads
 *
 * Setup steps (one-time, in Meta Developer Portal):
 *   1. Go to your app → Webhooks → Add Subscription
 *   2. Callback URL: https://yourdomain.com/webhooks/meta
 *   3. Verify Token: set META_WEBHOOK_VERIFY_TOKEN in .env (any random string)
 *   4. Subscribe to: messages (for both Page and Instagram)
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
    // Verify signature if FACEBOOK_APP_SECRET is set
    const appSecret = process.env.FACEBOOK_APP_SECRET;
    if (appSecret) {
      const signature = req.headers['x-hub-signature-256'];
      if (!signature) {
        console.warn('[Webhooks] Missing X-Hub-Signature-256 header — ignoring');
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

module.exports = router;
