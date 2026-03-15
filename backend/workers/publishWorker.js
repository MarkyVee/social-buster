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
 * Concurrency: 2 (two scan-and-publish cycles can overlap if one runs long,
 * but processQueue has DB-level locking via the 'publishing' status update
 * that prevents the same post from being picked up twice).
 *
 * Retry: 5 attempts with exponential backoff (set in queues/index.js).
 * Failed jobs land in the BullMQ failed list where the admin can review them.
 */

const { Worker } = require('bullmq');
const { connection } = require('../queues');
const { processQueue } = require('../agents/publishingAgent');

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
    concurrency: 2  // Allow 2 overlapping scan cycles (DB locking prevents double-publish)
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
