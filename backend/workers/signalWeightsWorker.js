/**
 * workers/signalWeightsWorker.js
 *
 * BullMQ worker for the 'signal-weights' queue.
 *
 * Processes one job type:
 *   'signal-weights-user' — runs hookPerformanceAgent and
 *   toneObjectiveFitAgent for a single user, then writes the
 *   results to user_profiles.signal_weights.
 *
 * Both agents run sequentially for the same user (not parallel) so
 * they don't race on the signal_weights JSONB column — each reads the
 * current value first and merges its own keys in.
 *
 * Concurrency: 3 — each job is lightweight (2-3 DB queries + math).
 * Three users can be processed simultaneously without overloading Supabase.
 *
 * Schedule: weekly per user (seeded by workers/index.js on startup,
 * same pattern as research jobs). Jobs are deduplicated by jobId so
 * the server can restart without creating duplicate weekly jobs.
 */

const { Worker }                        = require('bullmq');
const { connection }                    = require('../queues');
const { runHookPerformanceAnalysis }    = require('../agents/hookPerformanceAgent');
const { runToneObjectiveFitAnalysis }   = require('../agents/toneObjectiveFitAgent');

const signalWeightsWorker = new Worker(
  'signal-weights',

  async (job) => {
    if (job.name !== 'signal-weights-user') return;

    const { userId } = job.data;
    if (!userId) {
      console.warn('[SignalWeightsWorker] Job missing userId — skipping');
      return;
    }

    // Run hook analysis first, then tone/objective.
    // Sequential so both read-modify-write operations on signal_weights don't clash.
    await runHookPerformanceAnalysis(userId);
    await runToneObjectiveFitAnalysis(userId);
  },

  {
    connection,
    concurrency: 3   // Lightweight jobs — 3 users in parallel is safe
  }
);

signalWeightsWorker.on('completed', (job) => {
  console.log(`[SignalWeightsWorker] Job ${job.id} (user: ${job.data?.userId}) completed`);
});

signalWeightsWorker.on('failed', (job, err) => {
  console.error(`[SignalWeightsWorker] Job ${job?.id} (user: ${job?.data?.userId}) failed: ${err.message}`);
});

signalWeightsWorker.on('error', (err) => {
  console.error('[SignalWeightsWorker] Worker error:', err.message);
});

module.exports = signalWeightsWorker;
