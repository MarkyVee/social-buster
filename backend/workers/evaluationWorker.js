/**
 * workers/evaluationWorker.js
 *
 * FEAT-001: Avatar-Based Content Evaluation System
 *
 * BullMQ worker that processes evaluation jobs. Each job evaluates one field
 * (hook, caption, hashtags, CTA, or media) against 3-5 AI avatar personalities.
 *
 * Concurrency 5: each job does 3-5 parallel LLM calls (~3s each), so at peak
 * we have ~25 LLM calls in flight. This is well within Groq's rate limits
 * (14,400 req/day = ~10 req/sec) and keeps user wait time under 5 seconds.
 *
 * The worker stores results in evaluation_results and also returns them as
 * job.returnvalue so the frontend can poll /evaluation/status/:jobId.
 */

const { Worker } = require('bullmq');
const { connection } = require('../queues');
const { runEvaluation } = require('../services/evaluationService');
const { supabaseAdmin } = require('../services/supabaseService');

// ----------------------------------------------------------------
// Job handler
//
// job.data shape:
// {
//   userId:       UUID — who requested the evaluation
//   postId:       UUID — which post the field belongs to
//   field:        'hook' | 'caption' | 'hashtags' | 'cta' | 'media'
//   fieldContent: string — the actual text being evaluated
//   mediaUrl:     string (optional) — for media field evaluations
//   postType:     string (optional) — post type from brief (educational, promotional, etc.)
//   briefContext:  string (optional) — brief metadata formatted as text
// }
// ----------------------------------------------------------------
async function handleEvaluation(job) {
  // Daily cleanup job — deletes evaluation results older than retention_days
  if (job.name === 'cleanup-old-evaluations') {
    const { data: setting } = await supabaseAdmin
      .from('evaluation_settings')
      .select('value')
      .eq('key', 'retention_days')
      .single();

    const days = parseInt(setting?.value || '60', 10);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const { count } = await supabaseAdmin
      .from('evaluation_results')
      .delete()
      .lt('created_at', cutoff)
      .select('id', { count: 'exact', head: true });

    console.log(`[EvalWorker] Cleanup: deleted ${count || 0} evaluation results older than ${days} days`);
    return { deleted: count || 0 };
  }

  // Normal evaluation job
  const { userId, postId, field } = job.data;
  console.log(`[EvalWorker] Evaluating ${field} for post ${postId} (user ${userId})`);

  const results = await runEvaluation(job.data);

  console.log(`[EvalWorker] Done — ${results.length} avatar(s) evaluated ${field} for post ${postId}`);

  // Return results so they're accessible via job.returnvalue for polling
  return results;
}

// ----------------------------------------------------------------
// Worker definition
// Concurrency 5 — each job is mostly I/O-bound (LLM API calls)
// ----------------------------------------------------------------
const evaluationWorker = new Worker('evaluation', handleEvaluation, {
  connection,
  concurrency: 5
});

evaluationWorker.on('failed', (job, err) => {
  console.error(`[EvalWorker] Job ${job?.id} failed:`, err.message);
});

module.exports = evaluationWorker;
