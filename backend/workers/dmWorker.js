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

const { Worker, UnrecoverableError } = require('bullmq');
const { connection } = require('../queues');
const { sendDM, sendPrivateReply } = require('../services/messagingService');
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
  const { conversationId, userId, platform, pageId, recipientId, commentId, messageText, stepOrder, isFinalStep } = job.data;

  // Get the access token + page ID for this platform.
  // If pageId is provided (from the comment's Page), look up that specific connection.
  // Fallback: if no pageId but we have a commentId in Facebook format ({page_id}_{post_id}_{comment_id}),
  // we can't reliably parse it here — the upstream (commentAgent/dmAgent) should have resolved it.
  // Last resort: most recent connection for that platform.
  let connQuery = supabaseAdmin
    .from('platform_connections')
    .select('access_token, platform_user_id')
    .eq('user_id', userId)
    .eq('platform', platform);

  if (pageId) {
    connQuery = connQuery.eq('platform_user_id', pageId);
  } else {
    console.warn(`[DMWorker] No pageId for conversation ${conversationId} — falling back to most recent ${platform} connection`);
    connQuery = connQuery.order('connected_at', { ascending: false }).limit(1);
  }

  const { data: connRows, error: connError } = await connQuery;
  const conn = connRows?.[0] || null;

  if (connError || !conn) {
    throw new Error(`No ${platform} connection found for user ${userId} (pageId: ${pageId || 'any'})`);
  }

  let accessToken;
  try {
    accessToken = decryptToken(conn.access_token);
  } catch (err) {
    throw new Error(`Failed to decrypt ${platform} token for user ${userId}: ${err.message}`);
  }

  // Step 1 for Facebook AND Instagram: use the Private Reply pattern
  // (POST /{page_or_ig_id}/messages with recipient.comment_id).
  // This sends a DM to the commenter without needing their PSID/IGSID.
  // Follow-up steps (2+) use the regular Send API with the PSID/IGSID
  // obtained from the user's reply via the messaging webhook.
  //
  // Both platforms use the same API pattern — the only difference is the
  // ID in the URL: Facebook Page ID vs Instagram Business Account ID.
  // Both are stored in platform_connections.platform_user_id.
  let result;
  try {
    if (stepOrder === 1 && commentId) {
      result = await sendPrivateReply(accessToken, commentId, messageText, conn.platform_user_id, platform);
    } else {
      result = await sendDM(platform, accessToken, recipientId, messageText, userId);
    }
  } catch (sendErr) {
    // If the error is non-retryable (e.g. duplicate private reply on same comment),
    // throw UnrecoverableError so BullMQ skips retries immediately.
    if (sendErr.nonRetryable) {
      console.warn(`[DMWorker] Non-retryable error for conversation ${conversationId}: ${sendErr.message}`);
      throw new UnrecoverableError(sendErr.message);
    }
    throw sendErr;
  }

  // Update the conversation
  const now = new Date().toISOString();
  const updateData = { last_message_at: now };

  // When step 1 sends a Private Reply, the API returns the recipient's PSID.
  // Store it so processIncomingReply() can match the user's reply to this conversation.
  // The feed webhook gives us the commenter's user ID, but Messenger replies come
  // from their PSID (Page-Scoped ID) — these are different IDs.
  if (result.recipientId) {
    updateData.platform_user_id = result.recipientId;
    console.log(`[DMWorker] Storing PSID ${result.recipientId} on conversation ${conversationId}`);
  } else {
    console.warn(`[DMWorker] No recipientId in send result for conversation ${conversationId} — full result: ${JSON.stringify(result)}`);
  }

  if (isFinalStep) {
    updateData.status = 'completed';
  }

  const { error: convUpdateError } = await supabaseAdmin
    .from('dm_conversations')
    .update(updateData)
    .eq('id', conversationId);

  if (convUpdateError) {
    console.error(`[DMWorker] Failed to update conversation ${conversationId}: ${convUpdateError.message}`);
  }

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

worker.on('failed', async (job, err) => {
  console.error(`[DMWorker] Job ${job?.id} failed: ${err.message}`);

  // Mark the conversation as 'failed' so the dedup guard in dmAgent.js
  // allows a retry on the next comment from this person.
  // Without this, a failed DM permanently blocks future attempts.
  if (job?.name === 'send-dm' && job?.data?.conversationId) {
    try {
      await supabaseAdmin
        .from('dm_conversations')
        .update({ status: 'failed' })
        .eq('id', job.data.conversationId);
      console.log(`[DMWorker] Marked conversation ${job.data.conversationId} as failed`);
    } catch (updateErr) {
      console.error(`[DMWorker] Could not update conversation status: ${updateErr.message}`);
    }
  }
});

module.exports = worker;
