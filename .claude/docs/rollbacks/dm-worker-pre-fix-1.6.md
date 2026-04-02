# Rollback Snapshot — dmWorker.js
**Captured:** 2026-04-02
**Reason:** Pre-fix snapshot before implementing Red Team fix 1.6 (DM idempotency — check-before-send pattern)
**Branch at capture:** main @ commit 6a55ca1

If fix 1.6 causes problems, paste the code block below back into backend/workers/dmWorker.js.
You will also need to drop the `dm_log` table from Supabase if the SQL migration ran:
```sql
DROP TABLE IF EXISTS dm_log;
```

---

## backend/workers/dmWorker.js

```javascript
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
  concurrency: 2,
  limiter: {
    max:      30,
    duration: 60_000
  }
});

async function processSendDM(job) {
  const { conversationId, userId, platform, pageId, recipientId, commentId, messageText, stepOrder, isFinalStep } = job.data;

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

  let result;
  try {
    if (stepOrder === 1 && commentId) {
      result = await sendPrivateReply(accessToken, commentId, messageText, conn.platform_user_id, platform);
    } else {
      result = await sendDM(platform, accessToken, recipientId, messageText, userId);
    }
  } catch (sendErr) {
    if (sendErr.nonRetryable) {
      console.warn(`[DMWorker] Non-retryable error for conversation ${conversationId}: ${sendErr.message}`);
      throw new UnrecoverableError(sendErr.message);
    }
    throw sendErr;
  }

  const now = new Date().toISOString();
  const updateData = { last_message_at: now };

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

  if (isFinalStep && stepOrder === 1) {
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

worker.on('completed', (job) => {
  if (job.name === 'send-dm') {
    console.log(`[DMWorker] Job ${job.id} completed — DM delivered`);
  }
});

worker.on('failed', async (job, err) => {
  console.error(`[DMWorker] Job ${job?.id} failed: ${err.message}`);

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
```
