/**
 * services/messagingService.js
 *
 * Adapter layer for sending direct messages via platform APIs.
 * Currently supports: Facebook Messenger, Instagram DMs.
 * Both use the Meta Graph API under the same Page Access Token.
 *
 * This replaces n8n for DM delivery — no external workflow engine needed.
 * The adapter pattern means adding a new platform = adding one function here.
 *
 * .env required:
 *   FACEBOOK_APP_SECRET — used for webhook signature verification (in webhooks.js)
 *   No additional keys needed — DMs use the same Page Access Token from platform_connections.
 *
 * Rate limits (conservative — well below Meta's hard limits):
 *   Facebook Messenger: 100 DMs/day per Page
 *   Instagram DMs:       80 DMs/day per business account
 */

const axios = require('axios');
const { cacheGet, cacheSet } = require('./redisService');

const API_BASE = 'https://graph.facebook.com/v21.0';
const TIMEOUT  = 30_000;

// Daily DM limits per platform (conservative — avoids spam flags)
const DAILY_LIMITS = {
  facebook:  100,
  instagram:  80
};

// ----------------------------------------------------------------
// sendDM — main entry point. Routes to the correct platform handler.
//
// Parameters:
//   platform     — 'facebook' | 'instagram'
//   accessToken  — decrypted Page Access Token
//   recipientId  — commenter's PSID (Facebook) or IGSID (Instagram)
//   messageText  — the DM body text
//   userId       — our user's ID (for rate limiting)
//
// Returns: { success: true, messageId } or throws on failure.
// ----------------------------------------------------------------
async function sendDM(platform, accessToken, recipientId, messageText, userId) {
  // Check rate limit before sending
  const allowed = await checkDailyLimit(userId, platform);
  if (!allowed) {
    throw new Error(`Daily DM limit reached for ${platform} (${DAILY_LIMITS[platform]}/day). Will resume tomorrow.`);
  }

  let result;

  if (platform === 'facebook') {
    result = await sendFacebookDM(accessToken, recipientId, messageText);
  } else if (platform === 'instagram') {
    result = await sendInstagramDM(accessToken, recipientId, messageText);
  } else {
    throw new Error(`DM sending not supported for platform: ${platform}`);
  }

  // Increment the daily counter after successful send
  await incrementDailyCount(userId, platform);

  return result;
}

// ----------------------------------------------------------------
// sendFacebookDM — sends a DM via Facebook Messenger Platform.
//
// Uses the Page Access Token to send a message from the Page to a user.
// The recipient must have interacted with the Page within the last 24 hours
// (commented on a post, sent a message, etc.) — Meta's messaging policy.
//
// API: POST /{page-id}/messages
// Docs: https://developers.facebook.com/docs/messenger-platform/send-messages
// ----------------------------------------------------------------
async function sendFacebookDM(accessToken, recipientPSID, messageText) {
  try {
    const res = await axios.post(
      `${API_BASE}/me/messages`,
      {
        recipient: { id: recipientPSID },
        message:   { text: messageText },
        messaging_type: 'RESPONSE'    // Required — indicates this is a reply to user interaction
      },
      {
        params:  { access_token: accessToken },
        timeout: TIMEOUT
      }
    );

    console.log(`[MessagingService] Facebook DM sent to PSID ${recipientPSID}`);
    return { success: true, messageId: res.data.message_id };

  } catch (err) {
    const fbErr = err.response?.data?.error;
    if (fbErr) {
      const sub = fbErr.error_subcode ? ` subcode=${fbErr.error_subcode}` : '';
      const msg = fbErr.error_user_msg || fbErr.message;
      throw new Error(`Facebook Messenger error ${fbErr.code}${sub}: ${msg}`);
    }
    throw err;
  }
}

// ----------------------------------------------------------------
// sendPrivateReply — sends a DM to a Facebook commenter via the
// Messenger Send API with recipient.comment_id.
//
// The old /{comment-id}/private_replies endpoint was deprecated after
// Graph API v3.2. The modern approach uses /{page-id}/messages with
// the comment_id in the recipient object. This is how ManyChat, Chatfuel,
// and other major platforms handle comment-to-DM automation.
//
// API: POST /{page-id}/messages
// Docs: https://developers.facebook.com/docs/messenger-platform/send-messages
//
// Limitations:
//   - Only ONE private reply per comment (subsequent calls fail)
//   - Must be within 7 days of the comment
//   - Requires pages_messaging permission
//   - In dev mode, recipient must be an app Tester
// ----------------------------------------------------------------
async function sendPrivateReply(accessToken, commentId, messageText, pageOrIgId) {
  // Diagnostic: try to read the comment first to distinguish
  // "can't see it" (permissions) vs "can see it but can't reply" (unsupported).
  // Works for both Facebook and Instagram comments — Graph API uses the same
  // GET /{comment_id} pattern. Field names differ: Facebook uses 'message',
  // Instagram uses 'text'. We request both to handle either platform.
  try {
    const checkRes = await axios.get(
      `${API_BASE}/${commentId}`,
      { params: { access_token: accessToken, fields: 'id,text,message,from,username' }, timeout: TIMEOUT }
    );
    const authorName = checkRes.data.from?.name || checkRes.data.from?.username || checkRes.data.username || 'unknown';
    const commentBody = checkRes.data.message || checkRes.data.text || '';
    console.log(`[MessagingService] Comment ${commentId} readable — from: ${authorName}, text: "${commentBody.substring(0, 50)}"`);
  } catch (checkErr) {
    const fb = checkErr.response?.data?.error;
    console.error(`[MessagingService] Cannot read comment ${commentId} — error ${fb?.code} subcode=${fb?.error_subcode}: ${fb?.message || checkErr.message}`);
    console.error(`[MessagingService] Token may lack permission to see this comment. Check pages_read_user_content / instagram_manage_comments access.`);
  }

  try {
    // Use the Send API with comment_id as recipient.
    // Works for both Facebook Pages and Instagram Business Accounts:
    //   Facebook:  POST /{page_id}/messages
    //   Instagram: POST /{ig_user_id}/messages
    // Both use: { recipient: { comment_id }, message: { text } }
    const res = await axios.post(
      `${API_BASE}/${pageOrIgId}/messages`,
      {
        recipient: { comment_id: commentId },
        message:   { text: messageText }
      },
      {
        params:  { access_token: accessToken },
        timeout: TIMEOUT
      }
    );

    console.log(`[MessagingService] Private reply FULL RESPONSE: ${JSON.stringify(res.data)}`);
    console.log(`[MessagingService] Private reply sent to comment ${commentId} via ${pageOrIgId} — recipientId=${res.data.recipient_id}`);
    return { success: true, messageId: res.data.message_id || res.data.id || 'sent', recipientId: res.data.recipient_id };

  } catch (err) {
    const fbErr = err.response?.data?.error;
    if (fbErr) {
      const sub = fbErr.error_subcode ? ` subcode=${fbErr.error_subcode}` : '';
      const msg = fbErr.error_user_msg || fbErr.message;

      // Detect "one private reply per comment" — Facebook only allows a single
      // private reply per comment, ever. Retrying is pointless.
      // Known error patterns: code 1 "reduce the amount of data", code 10,
      // or any message mentioning "already been replied" / "private reply".
      const isDuplicateReply = (fbErr.code === 1 && /reduce the amount/i.test(fbErr.message))
        || /already.*(replied|sent|private.?reply)/i.test(fbErr.message || '');

      if (isDuplicateReply) {
        const error = new Error(`[Non-retryable] Comment ${commentId} already received a private reply — skipping. Original: ${msg}`);
        error.nonRetryable = true;
        throw error;
      }

      throw new Error(`Private Reply error ${fbErr.code}${sub}: ${msg}`);
    }
    throw err;
  }
}

// ----------------------------------------------------------------
// sendInstagramDM — sends a DM via Instagram Messaging API.
//
// Uses the same Page Access Token (IG is managed through Facebook Pages).
// The recipient must have interacted with the business account within 24 hours.
//
// API: POST /me/messages (with Instagram-scoped user ID)
// Docs: https://developers.facebook.com/docs/instagram-messaging
// ----------------------------------------------------------------
async function sendInstagramDM(accessToken, recipientIGSID, messageText) {
  try {
    const res = await axios.post(
      `${API_BASE}/me/messages`,
      {
        recipient: { id: recipientIGSID },
        message:   { text: messageText },
        messaging_type: 'RESPONSE'
      },
      {
        params:  { access_token: accessToken },
        timeout: TIMEOUT
      }
    );

    console.log(`[MessagingService] Instagram DM sent to IGSID ${recipientIGSID}`);
    return { success: true, messageId: res.data.message_id };

  } catch (err) {
    const fbErr = err.response?.data?.error;
    if (fbErr) {
      const sub = fbErr.error_subcode ? ` subcode=${fbErr.error_subcode}` : '';
      const msg = fbErr.error_user_msg || fbErr.message;
      throw new Error(`Instagram DM error ${fbErr.code}${sub}: ${msg}`);
    }
    throw err;
  }
}

// ----------------------------------------------------------------
// Rate limiting — Redis counters per user per platform per day.
//
// Key format: dm_daily:{userId}:{platform}:{YYYY-MM-DD}
// TTL: 86400 seconds (auto-expires at end of day)
// ----------------------------------------------------------------

function dailyKey(userId, platform) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `dm_daily:${userId}:${platform}:${today}`;
}

async function checkDailyLimit(userId, platform) {
  const key   = dailyKey(userId, platform);
  const count = parseInt(await cacheGet(key) || '0', 10);
  const limit = DAILY_LIMITS[platform] || 80;
  return count < limit;
}

async function incrementDailyCount(userId, platform) {
  const key   = dailyKey(userId, platform);
  const count = parseInt(await cacheGet(key) || '0', 10);
  // Set with 24-hour TTL so the counter auto-resets at midnight
  await cacheSet(key, String(count + 1), 86400);
}

// ----------------------------------------------------------------
// getDailyUsage — returns the current DM count for display in the UI.
// ----------------------------------------------------------------
async function getDailyUsage(userId, platform) {
  const key   = dailyKey(userId, platform);
  const count = parseInt(await cacheGet(key) || '0', 10);
  const limit = DAILY_LIMITS[platform] || 80;
  return { count, limit, remaining: limit - count };
}

module.exports = {
  sendDM,
  sendPrivateReply,
  getDailyUsage,
  DAILY_LIMITS
};
