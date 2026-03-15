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
  mediaAnalysisQueue
} = require('../queues');

// Importing these modules starts each worker immediately
require('./publishWorker');
require('./commentWorker');
require('./mediaWorker');
require('./performanceWorker');
require('./researchWorker');
require('./mediaAnalysisWorker');  // Video segment analysis (FFmpeg scene detection)

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

  console.log('[Workers] Repeatable jobs registered (publish, comment, media-scan, performance)');
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
    }

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
// startAllWorkers — called by server.js at startup.
// ----------------------------------------------------------------
async function startAllWorkers() {
  try {
    await registerRepeatableJobs();
    await seedWeeklyResearchJobs();
    await seedPendingVideoAnalysis();
    await retagUntaggedSegments();   // Phase 2: back-fill vision tags on existing segments
    console.log('[Workers] All BullMQ workers started and scheduled');
  } catch (err) {
    // Worker startup failures are logged but don't crash the server.
    // The HTTP API remains functional even if background workers fail to start.
    console.error('[Workers] Failed to start workers:', err.message);
  }
}

module.exports = { startAllWorkers };
