/**
 * workers/mediaProcessWorker.js
 *
 * BullMQ worker for the 'media-process' queue.
 *
 * Job type: 'process-media-item'
 *   data: { mediaItemId: UUID }
 *
 * Triggered automatically when a user attaches media to a post
 * (PUT /posts/:id with media_id). Downloads the file from its cloud
 * source (e.g. Google Drive) and copies it to Supabase Storage so
 * the publish worker can use a simple, auth-free public URL.
 *
 * Concurrency: 2 — two Drive downloads can run in parallel safely.
 * FFmpeg is NOT used here (trimming is platform-specific, happens at publish).
 */

const { Worker } = require('bullmq');
const { connection }        = require('../queues');
const { processMediaItem }  = require('../agents/mediaProcessAgent');

// Surface any promise rejections that escape job error handling.
// Without this, silent crashes look like successful job completions.
process.on('unhandledRejection', (err) => {
  console.error('[MediaProcessWorker] UNHANDLED REJECTION:', err);
});

const mediaProcessWorker = new Worker(
  'media-process',

  async (job) => {
    if (job.name === 'process-media-item') {
      const { mediaItemId } = job.data;
      if (!mediaItemId) throw new Error('process-media-item job is missing mediaItemId');
      await processMediaItem(mediaItemId);
    }
  },

  {
    connection,
    concurrency: 2
  }
);

mediaProcessWorker.on('completed', (job) => {
  console.log(`[MediaProcessWorker] Job ${job.id} (${job.name}) completed`);
});

mediaProcessWorker.on('failed', (job, err) => {
  console.error(`[MediaProcessWorker] Job ${job?.id} (${job?.name}) failed: ${err.message}`);
});

mediaProcessWorker.on('error', (err) => {
  console.error('[MediaProcessWorker] Worker error:', err.message);
});

module.exports = mediaProcessWorker;
