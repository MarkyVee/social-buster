/**
 * workers/mediaWorker.js
 *
 * BullMQ worker for the 'media-scan' queue.
 *
 * Processes two job types:
 *   'scan-all-users'  — runs every 30 minutes, scans cloud storage for ALL
 *                       users who have connected cloud accounts. Queues individual
 *                       'scan-user' jobs for each user found.
 *
 *   'scan-user'       — scans one specific user's connected cloud storage.
 *                       Also triggered on-demand when a user clicks "Scan Now"
 *                       in the Media Library (POST /media/scan route).
 *
 * Concurrency: 3 — three user scans can run in parallel. Cloud storage scans
 * are network I/O bound (not CPU), so 3 concurrent is safe without FFmpeg risk.
 *
 * Note: Video analysis (FFmpeg frame extraction + LLM tagging) is a separate
 * job type that will be added here in the video_segments phase.
 */

const { Worker } = require('bullmq');
const { connection, mediaScanQueue } = require('../queues');
const { scanUserMediaLibrary }       = require('../agents/mediaAgent');
const { supabaseAdmin }              = require('../services/supabaseService');

const mediaWorker = new Worker(
  'media-scan',

  async (job) => {

    if (job.name === 'scan-all-users') {
      // Find all users with connected cloud accounts and queue individual scans
      const { data: connections, error } = await supabaseAdmin
        .from('cloud_connections')
        .select('user_id')
        .not('access_token', 'is', null);

      if (error) {
        throw new Error(`Failed to fetch cloud connections: ${error.message}`);
      }

      if (!connections || connections.length === 0) return;

      // Deduplicate user IDs (a user may have multiple providers connected)
      const uniqueUserIds = [...new Set(connections.map(c => c.user_id))];

      console.log(`[MediaWorker] Queueing scans for ${uniqueUserIds.length} user(s)...`);

      // Add one 'scan-user' job per user — these run concurrently up to the worker's
      // concurrency limit (3), spreading the load instead of one giant serial loop.
      for (const userId of uniqueUserIds) {
        // Remove any stuck existing job before re-adding.
        // BullMQ deduplicates by jobId in ALL states — a completed job that wasn't
        // auto-removed (e.g. from before removeOnComplete was set) will silently
        // block every future add() with the same ID.
        const jobId = `scan-user-${userId}`;
        try {
          const existingJob = await mediaScanQueue.getJob(jobId);
          if (existingJob) await existingJob.remove();
        } catch (e) { /* non-fatal */ }

        await mediaScanQueue.add('scan-user', { userId }, {
          jobId,
          removeOnComplete: true,
          removeOnFail:     true
        });
      }
    }

    if (job.name === 'scan-user') {
      const { userId } = job.data;
      if (!userId) throw new Error('scan-user job is missing userId');

      console.log(`[MediaWorker] Scanning media for user ${userId}...`);
      const count = await scanUserMediaLibrary(userId);
      console.log(`[MediaWorker] Scan complete for user ${userId}: ${count} new items`);
    }

  },

  {
    connection,
    concurrency: 3
  }
);

mediaWorker.on('completed', (job) => {
  console.log(`[MediaWorker] Job ${job.id} (${job.name}) completed`);
});

mediaWorker.on('failed', (job, err) => {
  console.error(`[MediaWorker] Job ${job?.id} (${job?.name}) failed: ${err.message}`);
});

mediaWorker.on('error', (err) => {
  console.error('[MediaWorker] Worker error:', err.message);
});

module.exports = mediaWorker;
