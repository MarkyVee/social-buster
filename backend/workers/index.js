/**
 * workers/index.js
 *
 * Starts all BullMQ workers and registers repeatable (scheduled) jobs.
 * Called once at server startup — replaces the old startAgents() pattern
 * of setInterval polling loops.
 *
 * Schedule summary:
 *   publish queue     → 'scan-and-publish'  every 60 seconds
 *   comment queue     → 'comment-cycle'     every 15 minutes
 *   media-scan queue  → 'scan-all-users'    every 30 minutes
 *   performance queue → 'performance-cycle' every 2 hours
 *   research queue    → per-user jobs added weekly (seeded at startup)
 *
 * Workers are imported here so they start listening immediately.
 * BullMQ workers stay alive for the lifetime of the process — no
 * explicit start/stop needed.
 */

const { supabaseAdmin }              = require('../services/supabaseService');
const { retagUntaggedSegments }      = require('../services/videoAnalysisService');
const {
  publishQueue,
  commentQueue,
  mediaScanQueue,
  performanceQueue,
  researchQueue,
  mediaAnalysisQueue,
  mediaProcessQueue,
  dmQueue,
  emailQueue,
  evaluationQueue,
  watchdogQueue
} = require('../queues');

// Importing these modules starts each worker immediately
const publishWorker       = require('./publishWorker');
const commentWorker       = require('./commentWorker');
const mediaWorker         = require('./mediaWorker');
const performanceWorker   = require('./performanceWorker');
const researchWorker      = require('./researchWorker');
const mediaAnalysisWorker = require('./mediaAnalysisWorker');   // Video segment analysis (FFmpeg scene detection)
const mediaProcessWorker  = require('./mediaProcessWorker');    // Media pre-processing: Drive → Supabase Storage
const dmWorker            = require('./dmWorker');              // DM automation: sends DMs + expires stale conversations
const emailWorker         = require('./emailWorker');           // Admin bulk email campaigns via Resend
const evaluationWorker    = require('./evaluationWorker');      // FEAT-001: AI avatar field evaluations
require('./watchdogWorker');        // System health watchdog: anomaly detection + auto-pause

// ---- Watchdog instrumentation ----
// Hook into all workers to track job durations and error counts.
// This gives the watchdog agent data to compute health confidence.
const { incrementErrorCount, trackJobDuration } = require('../agents/watchdogAgent');

function instrumentWorker(worker, queueName) {
  worker.on('completed', (job) => {
    if (job?.processedOn && job?.finishedOn) {
      const duration = job.finishedOn - job.processedOn;
      trackJobDuration(queueName, duration).catch(() => {});
    }
  });
  worker.on('failed', () => {
    incrementErrorCount().catch(() => {});
  });
}

instrumentWorker(publishWorker,       'publish');
instrumentWorker(commentWorker,       'comment');
instrumentWorker(mediaWorker,         'media-scan');
instrumentWorker(performanceWorker,   'performance');
instrumentWorker(researchWorker,      'research');
instrumentWorker(mediaAnalysisWorker, 'media-analysis');
instrumentWorker(mediaProcessWorker,  'media-process');
instrumentWorker(dmWorker,            'dm');
instrumentWorker(emailWorker,         'email');
instrumentWorker(evaluationWorker,    'evaluation');

// ----------------------------------------------------------------
// registerRepeatableJobs
//
// Adds recurring jobs to each queue. BullMQ stores these in Redis
// so they survive server restarts — we use `upsert` behavior by
// always providing a fixed jobId so duplicate repeatable jobs are
// never created if the server restarts.
// ----------------------------------------------------------------
async function registerRepeatableJobs() {

  // Publishing queue — checks the scheduled posts queue every 60 seconds
  await publishQueue.add(
    'scan-and-publish',
    {},
    {
      repeat: { every: 60 * 1000 },   // every 60 seconds
      jobId: 'repeatable:scan-and-publish'
    }
  );

  // Comment queue — ingests new comments and fires DM triggers every 15 min
  await commentQueue.add(
    'comment-cycle',
    {},
    {
      repeat: { every: 15 * 60 * 1000 }, // every 15 minutes
      jobId: 'repeatable:comment-cycle'
    }
  );

  // Media scan queue — checks all users' cloud storage for new files every 30 min
  // The 'scan-all-users' job then fans out into individual 'scan-user' jobs
  await mediaScanQueue.add(
    'scan-all-users',
    {},
    {
      repeat: { every: 30 * 60 * 1000 }, // every 30 minutes
      jobId: 'repeatable:scan-all-users'
    }
  );

  // Performance queue — polls platform metrics every 2 hours
  await performanceQueue.add(
    'performance-cycle',
    {},
    {
      repeat: { every: 2 * 60 * 60 * 1000 }, // every 2 hours
      jobId: 'repeatable:performance-cycle'
    }
  );

  // DM queue — expires stale conversations (24hr messaging window) every 30 minutes
  await dmQueue.add(
    'expire-stale-conversations',
    {},
    {
      repeat: { every: 30 * 60 * 1000 }, // every 30 minutes
      jobId: 'repeatable:expire-stale-conversations'
    }
  );

  // Watchdog queue — system health monitoring every 5 minutes
  await watchdogQueue.add(
    'watchdog-cycle',
    {},
    {
      repeat: { every: 5 * 60 * 1000 }, // every 5 minutes
      jobId: 'repeatable:watchdog-cycle'
    }
  );

  // Evaluation cleanup — deletes old evaluation_results daily based on retention_days setting
  await evaluationQueue.add(
    'cleanup-old-evaluations',
    {},
    {
      repeat: { every: 24 * 60 * 60 * 1000 }, // once per day
      jobId: 'repeatable:eval-cleanup'
    }
  );

  console.log('[Workers] Repeatable jobs registered (publish, comment, media-scan, performance, dm-expire, watchdog, eval-cleanup)');
}

// ----------------------------------------------------------------
// seedWeeklyResearchJobs
//
// Queues a one-time 'research-user' job for every existing user
// so research is populated immediately after a fresh deploy.
//
// After that, research jobs are added individually when:
//   a) A user submits a new brief (routes/briefs.js)
//   b) A user clicks "Refresh Research" (routes/intelligence.js)
//
// We don't use a repeating job here because each user's research
// refreshes on their own 7-day cadence (tracked by the Redis TTL
// on research:{userId}). The researchAgent checks the TTL and
// skips users whose cache is still fresh.
// ----------------------------------------------------------------
async function seedWeeklyResearchJobs() {
  try {
    // Find all users who have at least one published post (active users only)
    const { data: users, error } = await supabaseAdmin
      .from('posts')
      .select('user_id')
      .eq('status', 'published');

    if (error || !users) return;

    const uniqueUserIds = [...new Set(users.map(u => u.user_id))];

    for (const userId of uniqueUserIds) {
      // jobId deduplicates: won't re-queue if this user's research job already exists
      await researchQueue.add(
        'research-user',
        { userId },
        {
          jobId: `research-user-weekly-${userId}`,
          // Delay between 0–60 min (randomized) to spread the load
          // instead of hammering the LLM endpoint with all users at once
          delay: Math.floor(Math.random() * 60 * 60 * 1000)
        }
      );
    }

    if (uniqueUserIds.length > 0) {
      console.log(`[Workers] Seeded weekly research jobs for ${uniqueUserIds.length} user(s)`);
    }
  } catch (err) {
    // Non-fatal — research will still run on-demand when users submit briefs
    console.error('[Workers] Failed to seed weekly research jobs:', err.message);
  }
}

// ----------------------------------------------------------------
// seedPendingVideoAnalysis
//
// On startup, handles two cases:
//
//   1. 'analyzing' items — these were in-flight when the server last died.
//      BullMQ marks stalled jobs as failed without calling our job processor,
//      so setAnalysisStatus('failed') is never called and they stay stuck as
//      'analyzing' forever. We reset them to 'pending' so they get re-queued.
//
//   2. 'pending' items — pre-existing videos from before the analysis pipeline
//      existed, or jobs that were lost before Redis persisted them.
//
// jobId deduplication prevents double-queuing if a BullMQ job already exists.
// ----------------------------------------------------------------
async function seedPendingVideoAnalysis() {
  try {
    // ---- Reset stale 'analyzing' items ----
    // These were mid-analysis when the server crashed. Reset them so they re-run.
    const { data: staleItems, error: staleError } = await supabaseAdmin
      .from('media_items')
      .update({ analysis_status: 'pending' })
      .eq('file_type', 'video')
      .eq('analysis_status', 'analyzing')
      .select('id');

    if (!staleError && staleItems && staleItems.length > 0) {
      console.log(`[Workers] Reset ${staleItems.length} stale 'analyzing' video(s) back to 'pending'`);

      // Also wipe any partial segments left over from the interrupted analysis run.
      // Without this, the re-run would insert duplicates on top of the partial data.
      const staleIds = staleItems.map(i => i.id);
      await supabaseAdmin
        .from('video_segments')
        .delete()
        .in('media_item_id', staleIds);
    }

    // ⚠️  DO NOT auto-reset 'failed' items here.
    // A video marked 'failed' either timed out or has a corrupt/unsupported format.
    // Auto-resetting failed → pending causes an infinite retry loop: the video fails,
    // restarts on next deploy, fails again, loops forever — holding the concurrency-1
    // analysis queue and starving every new video the user uploads. This was a real bug.
    // 'failed' stays 'failed'. The UI shows a badge. Users can manually retry.

    // ---- Queue all pending items (including the ones we just reset) ----
    const { data: pendingVideos, error } = await supabaseAdmin
      .from('media_items')
      .select('id')
      .eq('file_type', 'video')
      .eq('analysis_status', 'pending');

    if (error || !pendingVideos || pendingVideos.length === 0) return;

    let seededCount = 0;

    for (const item of pendingVideos) {
      const jobId = `analyze-video-${item.id}`;

      // Remove any existing job with this ID before adding a fresh one.
      //
      // Why: when the server crashes mid-analysis, the job stays in BullMQ's
      // "active" state in Redis. Calling queue.add() with the same jobId returns
      // the stale "active" job instead of creating a new waiting one. Stall
      // detection (30s interval) eventually fails the old job, but no new job
      // was ever queued, so the video sits in 'pending' forever.
      //
      // We skip removal for genuinely-active jobs (worker lock is still valid)
      // so we don't cancel a job that's actually running right now.
      try {
        const existingJob = await mediaAnalysisQueue.getJob(jobId);
        if (existingJob) {
          const state = await existingJob.getState();
          if (state !== 'active') {
            await existingJob.remove();
          }
        }
      } catch (_) {
        // Non-fatal — if removal fails, add() will return the existing job
      }

      await mediaAnalysisQueue.add(
        'analyze-video',
        { mediaItemId: item.id },
        { jobId }
      );
      seededCount++;
    }

    console.log(`[Workers] Seeded ${seededCount} pending video analysis job(s)`);
  } catch (err) {
    // Non-fatal — videos will still work via the LLM suggest-clip fallback
    console.error('[Workers] Failed to seed pending video analysis jobs:', err.message);
  }
}

// ----------------------------------------------------------------
// seedPendingMediaProcessing
//
// On startup, queues 'process-media-item' jobs for media that is
// attached to posts that still need publishing (draft, approved,
// scheduled, or failed) but hasn't been copied to Supabase yet.
//
// IMPORTANT: We only process media that is actually needed for
// upcoming posts — NOT every item in the media library. Scanning
// the entire library would queue large video downloads that compete
// with video analysis and could fill VPS disk space.
//
// Jobs are deduplicated by jobId so re-running on every startup is
// safe — nothing already queued will be double-added.
// ----------------------------------------------------------------
async function seedPendingMediaProcessing() {
  try {
    // Find media items attached to posts that still need publishing
    const { data: posts, error } = await supabaseAdmin
      .from('posts')
      .select('media_id')
      .in('status', ['draft', 'approved', 'scheduled', 'failed'])
      .not('media_id', 'is', null);

    if (error || !posts || posts.length === 0) return;

    // Deduplicate — multiple posts may reference the same media item
    const mediaIds = [...new Set(posts.map(p => p.media_id))];

    // Fetch only the items that aren't ready yet
    const { data: pendingItems, error: fetchErr } = await supabaseAdmin
      .from('media_items')
      .select('id, file_type')
      .in('id', mediaIds)
      .not('process_status', 'eq', 'ready')
      .not('process_status', 'eq', 'processing');

    if (fetchErr || !pendingItems || pendingItems.length === 0) return;

    let seededCount = 0;

    for (const item of pendingItems) {
      const jobId = `process-media-${item.id}`;
      try {
        const existing = await mediaProcessQueue.getJob(jobId);
        if (!existing) {
          await mediaProcessQueue.add(
            'process-media-item',
            { mediaItemId: item.id },
            { jobId, removeOnComplete: true }
          );
          seededCount++;
        }
      } catch (_) { /* Non-fatal — will be picked up when user re-attaches */ }
    }

    if (seededCount > 0) {
      console.log(`[Workers] Seeded ${seededCount} pending media processing job(s)`);
    }

    // Also re-queue any 'ready' images from Google Drive that were uploaded before
    // the image optimization feature was added. These may be oversized (e.g. 13 MB)
    // and will hang at publish time. The media process agent now resizes on copy,
    // so resetting them to 'pending' lets the agent re-download and optimize.
    const { data: oversizedCandidates } = await supabaseAdmin
      .from('media_items')
      .select('id')
      .eq('process_status', 'ready')
      .eq('file_type', 'image')
      .eq('cloud_provider', 'google_drive');

    if (oversizedCandidates && oversizedCandidates.length > 0) {
      let requeued = 0;
      for (const item of oversizedCandidates) {
        const jobId = `reprocess-image-${item.id}`;
        try {
          const existing = await mediaProcessQueue.getJob(jobId);
          if (existing) continue; // already queued from a previous startup

          // Reset to pending so processMediaItem picks it up
          await supabaseAdmin
            .from('media_items')
            .update({ process_status: 'pending' })
            .eq('id', item.id);

          await mediaProcessQueue.add(
            'process-media-item',
            { mediaItemId: item.id },
            { jobId, removeOnComplete: true }
          );
          requeued++;
        } catch (_) { /* non-fatal */ }
      }
      if (requeued > 0) {
        console.log(`[Workers] Re-queued ${requeued} Google Drive image(s) for optimization`);
      }
    }

  } catch (err) {
    // Non-fatal — media processing still triggers on-demand when media is attached
    console.error('[Workers] Failed to seed pending media processing jobs:', err.message);
  }
}

// ----------------------------------------------------------------
// startAllWorkers — called by server.js at startup.
// ----------------------------------------------------------------
async function startAllWorkers() {
  // Each step is wrapped independently so one failure cannot prevent the others
  // from running. The original single try/catch meant a failure in step N would
  // silently skip all subsequent steps (e.g. retagUntaggedSegments never ran).

  const run = async (label, fn) => {
    try {
      await fn();
    } catch (err) {
      console.error(`[Workers] ${label} failed (non-fatal): ${err.message}`);
    }
  };

  await run('registerRepeatableJobs',    registerRepeatableJobs);
  await run('seedWeeklyResearchJobs',    seedWeeklyResearchJobs);
  await run('seedPendingVideoAnalysis',  seedPendingVideoAnalysis);
  await run('seedPendingMediaProcessing', seedPendingMediaProcessing);
  await run('retagUntaggedSegments',     retagUntaggedSegments);

  console.log('[Workers] All BullMQ workers started and scheduled');
}

module.exports = { startAllWorkers };
