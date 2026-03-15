/**
 * workers/mediaAnalysisWorker.js
 *
 * BullMQ worker for the 'media-analysis' queue.
 *
 * Processes one job type:
 *   'analyze-video' — runs FFmpeg scene detection + audio energy analysis on
 *                     a single video, saves segments to video_segments table,
 *                     and updates analysis_status on the media_items record.
 *
 * Concurrency: 2 — FFmpeg is CPU-intensive. Running more than 2 simultaneous
 * analysis jobs on a typical VPS would saturate the CPU and slow publishing.
 *
 * Triggered by: mediaAgent.js — one job per new video added to the library.
 * Jobs are deduplicated by jobId so the same video is never analysed twice.
 *
 * Retry: 1 attempt (no retry — set in queues/index.js). A video that is too large
 * or corrupt will fail on every attempt; retrying wastes CPU and blocks the queue.
 * Hard job timeout: 8 minutes (JOB_TIMEOUT_MS). If analyzeVideo hangs past that,
 * the item is marked 'failed' and BullMQ gets an UnrecoverableError (no retry).
 */

const { Worker, UnrecoverableError } = require('bullmq');
const { connection } = require('../queues');
const { analyzeVideo, setAnalysisStatusPublic } = require('../services/videoAnalysisService');

// Hard cap per job: if analyzeVideo doesn't complete within 8 minutes, kill it.
// This covers worst cases: slow Drive streams, hung FFprobe, enormous scene graphs.
// 8 minutes >> any expected analysis time (a 5-min video at most takes 2-3 minutes).
const JOB_TIMEOUT_MS = 8 * 60 * 1000;

const mediaAnalysisWorker = new Worker(
  'media-analysis',

  async (job) => {
    if (job.name === 'analyze-video') {
      const { mediaItemId } = job.data;

      if (!mediaItemId) {
        throw new Error('analyze-video job is missing mediaItemId');
      }

      // Race the analysis against the hard timeout.
      // If the timeout fires first: mark the item failed (so the user sees the
      // badge, not a spinner) then throw UnrecoverableError so BullMQ does NOT
      // retry — a timed-out job would just hang again on retry.
      let timeoutId;
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`analyzeVideo timed out after ${JOB_TIMEOUT_MS / 60000} minutes`));
        }, JOB_TIMEOUT_MS);
      });

      try {
        await Promise.race([analyzeVideo(mediaItemId), timeoutPromise]);
      } catch (err) {
        clearTimeout(timeoutId);
        // If this was a timeout (not a normal analysis error), mark the item
        // as failed in the DB and prevent BullMQ from retrying.
        if (err.message.includes('timed out')) {
          console.error(`[MediaAnalysisWorker] ${err.message} — marking ${mediaItemId} as failed`);
          await setAnalysisStatusPublic(mediaItemId, 'failed');
          throw new UnrecoverableError(err.message);
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    }
  },

  {
    connection,
    concurrency: 1   // One video at a time — the stream stays open during the full FFmpeg pipe.
                     // Two concurrent streams on a 2-core VPS would fight for I/O and CPU.
  }
);

mediaAnalysisWorker.on('completed', (job) => {
  console.log(`[MediaAnalysisWorker] Job ${job.id} (${job.name}) completed — mediaItemId: ${job.data?.mediaItemId}`);
});

mediaAnalysisWorker.on('failed', (job, err) => {
  console.error(`[MediaAnalysisWorker] Job ${job?.id} (${job?.name}) failed: ${err.message}`);
});

mediaAnalysisWorker.on('error', (err) => {
  console.error('[MediaAnalysisWorker] Worker error:', err.message);
});

module.exports = mediaAnalysisWorker;
