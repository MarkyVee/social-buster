/**
 * workers/researchWorker.js
 *
 * BullMQ worker for the 'research' queue.
 *
 * Processes one job type:
 *   'research-user' — refreshes trend/niche research for one specific user.
 *                     Scheduled weekly per user by workers/index.js.
 *                     Also triggered on-demand when a user clicks
 *                     "Refresh Research" in the Intelligence Dashboard
 *                     (POST /intelligence/refresh route).
 *
 * Concurrency: 2 — research calls the LLM, which is network I/O bound.
 * Keeping concurrency low (2) prevents overwhelming the LLM endpoint
 * with bulk weekly refresh jobs while still processing multiple users
 * in parallel.
 */

const { Worker } = require('bullmq');
const { connection } = require('../queues');
const { refreshResearch } = require('../agents/researchAgent');

const researchWorker = new Worker(
  'research',

  async (job) => {
    if (job.name === 'research-user') {
      const { userId } = job.data;
      if (!userId) throw new Error('research-user job is missing userId');

      console.log(`[ResearchWorker] Refreshing research for user ${userId}...`);
      await refreshResearch(userId);
      console.log(`[ResearchWorker] Research complete for user ${userId}`);
    }
  },

  {
    connection,
    concurrency: 2
  }
);

researchWorker.on('completed', (job) => {
  console.log(`[ResearchWorker] Job ${job.id} (${job.name}) completed`);
});

researchWorker.on('failed', (job, err) => {
  console.error(`[ResearchWorker] Job ${job?.id} (${job?.name}) failed: ${err.message}`);
});

researchWorker.on('error', (err) => {
  console.error('[ResearchWorker] Worker error:', err.message);
});

module.exports = researchWorker;
