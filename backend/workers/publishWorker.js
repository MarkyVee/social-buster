/**
 * workers/publishWorker.js
 *
 * BullMQ worker for the 'publish' queue.
 *
 * Processes two job types:
 *   'scan-and-publish' — runs every 60 seconds, finds all scheduled posts
 *                        that are due and publishes them. This is the main
 *                        recurring job that replaces the old setInterval loop.
 *
 * Concurrency: 1 — only one scan cycle runs at a time. Inside that scan,
 * posts from different users still publish in parallel (Promise.allSettled).
 * Concurrency 2 caused a race condition where two overlapping scans could
 * both pick up the same post, resulting in posts stuck in 'publishing'
 * with zero publish logs (2026-03-29).
 *
 * Retry: 5 attempts with exponential backoff (set in queues/index.js).
 * Failed jobs land in the BullMQ failed list where the admin can review them.
 */

const { Worker } = require('bullmq');
const { connection } = require('../queues');
const { processQueue } = require('../agents/publishingAgent');

// Surface any promise rejections that escape job error handling.
// Without this, a crash inside publishPost() can look like a silent success —
// the job completes with no error logged and no post marked failed.
process.on('unhandledRejection', (err) => {
  console.error('[PublishWorker] UNHANDLED REJECTION:', err);
});

// ----------------------------------------------------------------
// Create the worker
// ----------------------------------------------------------------
const publishWorker = new Worker(
  'publish',

  async (job) => {
    if (job.name === 'scan-and-publish') {
      await processQueue();
    }
    // Future: handle 'publish-single-post' job type here for on-demand publishing
  },

  {
    connection,
    concurrency: 1  // One scan at a time — posts within a scan still publish in parallel
  }
);

// ----------------------------------------------------------------
// Worker event handlers — surface errors and completions to the logs
// ----------------------------------------------------------------
publishWorker.on('completed', (job) => {
  console.log(`[PublishWorker] Job ${job.id} (${job.name}) completed`);
});

publishWorker.on('failed', (job, err) => {
  console.error(`[PublishWorker] Job ${job?.id} (${job?.name}) failed: ${err.message}`);
});

publishWorker.on('error', (err) => {
  console.error('[PublishWorker] Worker error:', err.message);
});

module.exports = publishWorker;
