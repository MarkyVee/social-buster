/**
 * workers/payoutWorker.js
 *
 * BullMQ worker for the 'payout' queue.
 *
 * Processes one job type:
 *   'run-monthly-payouts' — triggers affiliateService.processMonthlyPayouts()
 *
 * This job is scheduled monthly (5th of each month at 02:00 UTC) via
 * a cron repeatable in workers/index.js. Admins can also trigger it
 * manually via POST /admin/payouts/process.
 *
 * Concurrency: 1 — only one payout run can execute at a time.
 * Financial operations (Stripe transfers) must never overlap.
 *
 * Failure handling:
 *   - BullMQ retries the job up to 3 times (exponential backoff)
 *   - If all retries fail, the job lands in the 'failed' state in BullMQ Board
 *   - Admin can see it in the queue monitor and re-trigger manually
 *
 * The worker starts when this module is required (by workers/index.js).
 */

const { Worker } = require('bullmq');
const { connection } = require('../queues');
const { processMonthlyPayouts, releaseMaturedReserves } = require('../services/affiliateService');

// ----------------------------------------------------------------
// Payout worker — concurrency 1 (financial operations must not overlap)
// ----------------------------------------------------------------
const payoutWorker = new Worker(
  'payout',
  async (job) => {
    const { name } = job;

    if (name === 'run-monthly-payouts') {
      console.log('[PayoutWorker] Starting monthly payout run...');

      const result = await processMonthlyPayouts();

      console.log(
        `[PayoutWorker] Monthly payout complete: ` +
        `${result.processed} paid, ${result.skipped} skipped, ${result.errors} errors`
      );

      return result;
    }

    if (name === 'release-matured-reserves') {
      console.log('[PayoutWorker] Releasing matured affiliate reserves...');

      const result = await releaseMaturedReserves();

      console.log(`[PayoutWorker] Reserve release complete: ${result.released} released`);

      return result;
    }

    console.warn(`[PayoutWorker] Unknown job name: ${name}`);
  },
  {
    connection,
    concurrency: 1,  // one payout run at a time — never overlap financial operations
  }
);

payoutWorker.on('completed', (job, result) => {
  console.log(`[PayoutWorker] Job "${job.name}" completed:`, result);
});

payoutWorker.on('failed', (job, err) => {
  console.error(`[PayoutWorker] Job "${job?.name}" failed:`, err.message);
});

module.exports = payoutWorker;
