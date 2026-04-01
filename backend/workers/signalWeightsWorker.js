/**
 * workers/signalWeightsWorker.js
 *
 * BullMQ worker for the 'signal-weights' queue.
 *
 * Processes one job type:
 *   'signal-weights-user' — runs all Layer 1 + Layer 2 learning agents
 *   sequentially for a single user, writing results to signal_weights.
 *
 *   Layer 1 (post performance math):
 *     hookPerformanceAgent    → signal_weights.hook_formats
 *     toneObjectiveFitAgent   → signal_weights.tone_objective_fit
 *     postTypeCalendarAgent   → signal_weights.best_hours
 *
 *   Layer 2 (comment signal):
 *     commentSentimentAgent   → signal_weights.comment_signals
 *     ctaEffectivenessAgent   → signal_weights.cta_effectiveness
 *
 * All agents run sequentially — not parallel — so their read-modify-write
 * operations on signal_weights JSONB don't overwrite each other's keys.
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
const { runHookPerformanceAnalysis }      = require('../agents/hookPerformanceAgent');
const { runToneObjectiveFitAnalysis }     = require('../agents/toneObjectiveFitAgent');
const { runPostTypeCalendarAnalysis }     = require('../agents/postTypeCalendarAgent');
const { runCommentSentimentAnalysis }     = require('../agents/commentSentimentAgent');
const { runCtaEffectivenessAnalysis }     = require('../agents/ctaEffectivenessAgent');

const signalWeightsWorker = new Worker(
  'signal-weights',

  async (job) => {
    if (job.name !== 'signal-weights-user') return;

    const { userId } = job.data;
    if (!userId) {
      console.warn('[SignalWeightsWorker] Job missing userId — skipping');
      return;
    }

    // Run all three Layer 1 agents sequentially for this user.
    // Sequential — not parallel — so their read-modify-write operations
    // on signal_weights JSONB don't overwrite each other's keys.
    // Layer 1 — post performance patterns
    await runHookPerformanceAnalysis(userId);
    await runToneObjectiveFitAnalysis(userId);
    await runPostTypeCalendarAnalysis(userId);

    // Layer 2 — comment signals (what the audience actually says)
    await runCommentSentimentAnalysis(userId);
    await runCtaEffectivenessAnalysis(userId);
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
