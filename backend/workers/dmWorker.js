/**
 * workers/dmWorker.js
 *
 * BullMQ worker for the 'dm' queue.
 *
 * Processes two job types:
 *   1. 'send-dm'                   — sends a single DM via Meta Graph API
 *   2. 'expire-stale-conversations' — marks expired 24hr-window conversations
 *
 * Rate limiting:
 *   - Per-user daily limits are enforced in messagingService.js
 *   - Queue-level burst protection: concurrency 2 + limiter (max 10 per minute)
 *     This prevents hammering the Meta API if many triggers fire simultaneously.
 *
 * The worker starts when this module is required (by workers/index.js).
 */

const { Worker } = require('bullmq');
const { connection } = require('../queues');
const { sendDM }     = require('../services/messagingService');
const { decryptToken } = require('../services/tokenEncryption');
const { supabaseAdmin } = require('../services/supabaseService');
const { expireStaleConversations } = require('../agents/dmAgent');

const worker = new Worker('dm', async (job) => {
  if (job.name === 'send-dm') {
    return await processSendDM(job);
  }

  if (job.name === 'expire-stale-conversations') {
    return await expireStaleConversations();
  }

  console.warn(`[DMWorker] Unknown job name: ${job.name}`);
}, {
  connection,
  concurrency: 2,      // Max 2 DMs sending at once
  limiter: {
    max:      10,       // Max 10 DM jobs per minute across all users
    duration: 60_000
  }
});

// ----------------------------------------------------------------
// processSendDM — sends a single DM and updates conversation state.
//
// Job data:
//   conversationId — UUID of the dm_conversations row
//   userId         — our user's ID (for rate limiting + token lookup)
//   platform       — 'facebook' | 'instagram'
//   recipientId    — commenter's PSID/IGSID
//   messageText    — the DM body text
//   stepOrder      — which step this DM corresponds to
//   isFinalStep    — if true, mark conversation as 'completed' after sending
// ----------------------------------------------------------------
async function processSendDM(job) {
  const { conversationId, userId, platform, recipientId, messageText, stepOrder, isFinalStep } = job.data;

  // Get the access token for this platform
  const { data: conn, error: connError } = await supabaseAdmin
    .from('platform_connections')
    .select('access_token')
    .eq('user_id', userId)
    .eq('platform', platform)
    .single();

  if (connError || !conn) {
    throw new Error(`No ${platform} connection found for user ${userId}`);
  }

  let accessToken;
  try {
    accessToken = decryptToken(conn.access_token);
  } catch (err) {
    throw new Error(`Failed to decrypt ${platform} token for user ${userId}: ${err.message}`);
  }

  // Send the DM
  const result = await sendDM(platform, accessToken, recipientId, messageText, userId);

  // Update the conversation
  const now = new Date().toISOString();
  const updateData = { last_message_at: now };

  if (isFinalStep) {
    updateData.status = 'completed';
  }

  await supabaseAdmin
    .from('dm_conversations')
    .update(updateData)
    .eq('id', conversationId);

  // If this is for a single-message flow, also mark dm_sent on the original comment
  if (isFinalStep && stepOrder === 1) {
    // The comment that triggered this conversation — find it via the conversation record
    const { data: conv } = await supabaseAdmin
      .from('dm_conversations')
      .select('platform_user_id')
      .eq('id', conversationId)
      .single();

    if (conv) {
      await supabaseAdmin
        .from('comments')
        .update({ dm_sent: true })
        .eq('author_platform_id', conv.platform_user_id)
        .eq('trigger_matched', true)
        .eq('dm_sent', false);
    }
  }

  console.log(`[DMWorker] DM sent: conversation=${conversationId} step=${stepOrder} platform=${platform}`);
  return result;
}

// Worker event logging
worker.on('completed', (job) => {
  if (job.name === 'send-dm') {
    console.log(`[DMWorker] Job ${job.id} completed — DM delivered`);
  }
});

worker.on('failed', (job, err) => {
  console.error(`[DMWorker] Job ${job?.id} failed: ${err.message}`);
});

module.exports = worker;
