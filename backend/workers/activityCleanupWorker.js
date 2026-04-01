/**
 * workers/activityCleanupWorker.js
 *
 * Deletes activity_log rows older than 90 days.
 * Runs nightly at 04:00 UTC via a BullMQ repeatable cron job.
 * Registered in workers/index.js.
 *
 * Re-throws errors so BullMQ marks the job as failed and retries
 * (per the project error-handling convention for workers).
 */

const { Worker } = require('bullmq');
const { connection } = require('../queues');
const { supabaseAdmin } = require('../services/supabaseService');

const activityCleanupWorker = new Worker(
  'activity-cleanup',
  async (job) => {
    if (job.name !== 'cleanup-old-activity') return;

    // Anything older than 90 days gets deleted
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    const { error } = await supabaseAdmin
      .from('activity_log')
      .delete()
      .lt('created_at', cutoff);

    if (error) throw new Error('Activity log cleanup failed: ' + error.message);

    console.log(`[ActivityCleanupWorker] Deleted rows older than ${cutoff}`);
  },
  { connection, concurrency: 1 }
);

activityCleanupWorker.on('failed', (job, err) => {
  console.error('[ActivityCleanupWorker] Job failed:', err.message);
});

module.exports = activityCleanupWorker;
