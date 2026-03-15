/**
 * workers/commentWorker.js
 *
 * BullMQ worker for the 'comment' queue.
 *
 * Processes one job type:
 *   'comment-cycle' — runs every 15 minutes, ingests new comments for all
 *                     published posts and fires n8n DM triggers on phrase matches.
 *
 * Concurrency: 1 — one comment cycle runs at a time. This prevents
 * overlapping cycles from double-processing the same comments.
 *
 * DM rate limiting: Instagram allows ~50-100 automated DMs per day per
 * business account. The commentAgent enforces this limit internally.
 * If a user's account hits the limit, the n8n webhook call is skipped
 * and the missed trigger is logged (not retried — DMs are time-sensitive
 * and retrying stale triggers creates a poor user experience).
 */

const { Worker } = require('bullmq');
const { connection } = require('../queues');
const { runCommentCycle } = require('../agents/commentAgent');

const commentWorker = new Worker(
  'comment',

  async (job) => {
    if (job.name === 'comment-cycle') {
      await runCommentCycle();
    }
  },

  {
    connection,
    concurrency: 1  // Strictly one cycle at a time to prevent duplicate DMs
  }
);

commentWorker.on('completed', (job) => {
  console.log(`[CommentWorker] Job ${job.id} (${job.name}) completed`);
});

commentWorker.on('failed', (job, err) => {
  console.error(`[CommentWorker] Job ${job?.id} (${job?.name}) failed: ${err.message}`);
});

commentWorker.on('error', (err) => {
  console.error('[CommentWorker] Worker error:', err.message);
});

module.exports = commentWorker;
