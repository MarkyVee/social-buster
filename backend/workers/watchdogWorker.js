/**
 * workers/watchdogWorker.js
 *
 * BullMQ worker for the system watchdog.
 * Runs every 5 minutes to check system health, detect anomalies,
 * and auto-pause if confidence drops too low.
 *
 * Job names:
 *   'watchdog-cycle' — runs the full watchdog check
 */

const { Worker } = require('bullmq');
const { connection } = require('../queues');
const { runWatchdogCycle, incrementErrorCount, trackJobDuration } = require('../agents/watchdogAgent');

const watchdogWorker = new Worker(
  'watchdog',

  async (job) => {
    if (job.name === 'watchdog-cycle') {
      return await runWatchdogCycle();
    }
  },

  {
    connection,
    concurrency: 1  // Only one watchdog check at a time
  }
);

watchdogWorker.on('completed', (job, result) => {
  if (result) {
    console.log(`[WatchdogWorker] Cycle complete — confidence: ${result.confidence}/100, anomalies: ${result.anomalies}`);
  }
});

watchdogWorker.on('failed', (job, err) => {
  console.error(`[WatchdogWorker] Job ${job?.id} failed: ${err.message}`);
});

watchdogWorker.on('error', (err) => {
  console.error(`[WatchdogWorker] Worker error: ${err.message}`);
});

module.exports = watchdogWorker;
