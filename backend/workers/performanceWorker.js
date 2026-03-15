/**
 * workers/performanceWorker.js
 *
 * BullMQ worker for the 'performance' queue.
 *
 * Processes one job type:
 *   'performance-cycle' — runs every 2 hours, polls post performance metrics
 *                         from platform APIs for all active published posts,
 *                         then updates the intelligence cache in Redis.
 *
 * Concurrency: 3 — performance polling is network I/O (platform API calls),
 * not CPU, so 3 concurrent cycles is safe. Each cycle isolates errors per user
 * internally, so a failed user does not block others.
 */

const { Worker } = require('bullmq');
const { connection } = require('../queues');
const { runPerformanceCycle } = require('../agents/performanceAgent');

const performanceWorker = new Worker(
  'performance',

  async (job) => {
    if (job.name === 'performance-cycle') {
      await runPerformanceCycle();
    }
  },

  {
    connection,
    concurrency: 3
  }
);

performanceWorker.on('completed', (job) => {
  console.log(`[PerformanceWorker] Job ${job.id} (${job.name}) completed`);
});

performanceWorker.on('failed', (job, err) => {
  console.error(`[PerformanceWorker] Job ${job?.id} (${job?.name}) failed: ${err.message}`);
});

performanceWorker.on('error', (err) => {
  console.error('[PerformanceWorker] Worker error:', err.message);
});

module.exports = performanceWorker;
