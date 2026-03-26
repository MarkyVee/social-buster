/**
 * queues/index.js
 *
 * Central definition of all BullMQ queues.
 *
 * Why BullMQ instead of setInterval?
 *   - Concurrency limits: prevents 50 FFmpeg jobs from firing at once
 *   - Retry logic: failed jobs retry with backoff instead of disappearing
 *   - Dead letter queue: permanently failed jobs are visible, not silently lost
 *   - Priority: publishing jobs run before low-priority research jobs
 *   - Visibility: BullMQ Board shows what's running, queued, and failed
 *   - Persistence: jobs survive server restarts (stored in Redis with AOF on)
 *
 * Queue summary:
 *   publish     — platform publishing (highest priority, max 5 concurrent)
 *   comment     — comment ingestion + DM triggers (medium priority)
 *   media-scan  — cloud storage scanning + video analysis (max 3 — FFmpeg intensive)
 *   performance — metrics polling (low priority, runs every 2 hours)
 *   research    — LLM trend research (lowest priority, runs weekly)
 *
 * All queues share the same Redis instance but use separate key prefixes
 * (BullMQ does this automatically via the queue name).
 */

const { Queue } = require('bullmq');

// ----------------------------------------------------------------
// Parse the Redis connection from the environment variable.
//
// BullMQ uses ioredis under the hood and needs explicit host/port
// (it doesn't accept a redis:// URL string directly).
//
// REDIS_URL format: redis://host:port
// Docker Compose sets this to redis://redis:6379 automatically.
// ----------------------------------------------------------------
function getRedisConnection() {
  return {
    host:                 process.env.REDIS_HOST     || 'localhost',
    port:                 parseInt(process.env.REDIS_PORT || '6379', 10),
    username:             process.env.REDIS_USERNAME || 'default',
    password:             process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null  // Required by BullMQ — disables ioredis auto-retry per command
  };
}

const connection = getRedisConnection();

// ----------------------------------------------------------------
// Default job options shared across all queues.
//
// attempts:         How many times to try before marking a job as failed.
// backoff:          Exponential backoff between retries (type + initial delay).
// removeOnComplete: Keep only the last 100 completed jobs (prevents Redis bloat).
// removeOnFail:     Keep the last 500 failed jobs so the admin can review them.
// ----------------------------------------------------------------
const DEFAULT_JOB_OPTIONS = {
  attempts:         3,
  backoff: {
    type:  'exponential',
    delay: 5000           // First retry after 5s, then 10s, then 20s
  },
  removeOnComplete: { count: 100 },
  removeOnFail:     { count: 500 }
};

// ----------------------------------------------------------------
// Queue definitions
// Each queue has a name, connection, and default options.
// The 'defaultJobOptions' on the Queue constructor sets defaults for
// every job added — individual jobs can override these.
// ----------------------------------------------------------------

// Publishing queue — highest priority, handles all scheduled post publishing.
// Concurrency is controlled in the worker (publishWorker.js).
const publishQueue = new Queue('publish', {
  connection,
  defaultJobOptions: {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 5,        // Publishing gets more retries — platform APIs are flaky
    backoff: {
      type:  'exponential',
      delay: 10000      // First retry after 10s — give platform APIs time to recover
    }
  }
});

// Comment queue — ingests platform comments and checks DM automation triggers.
const commentQueue = new Queue('comment', {
  connection,
  defaultJobOptions: DEFAULT_JOB_OPTIONS
});

// Media scan queue — scans cloud storage and catalogs new files.
// Max 3 concurrent (set in worker) — scanning involves network I/O but not heavy CPU.
const mediaScanQueue = new Queue('media-scan', {
  connection,
  defaultJobOptions: {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 2         // Scan failures are non-critical — will retry next scheduled run
  }
});

// Performance queue — polls platform APIs for post metrics.
const performanceQueue = new Queue('performance', {
  connection,
  defaultJobOptions: {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 2
  }
});

// Research queue — generates niche/trend research via LLM, cached in Redis.
// Lowest priority — purely background, not user-visible in real time.
const researchQueue = new Queue('research', {
  connection,
  defaultJobOptions: {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 2,
    backoff: {
      type:  'exponential',
      delay: 30000      // Research LLM calls can be slow — wait 30s before retry
    }
  }
});

// Media process queue — copies user media from cloud storage (Google Drive etc.) to
// Supabase Storage at the moment a user attaches media to a post.
// This decouples OAuth-dependent downloads from the publish step, so publishing
// never has to deal with Drive tokens, redirects, or network timeouts.
// Max 2 concurrent — Drive downloads are I/O-bound, 2 is plenty without rate-limiting.
const mediaProcessQueue = new Queue('media-process', {
  connection,
  defaultJobOptions: {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 3,
    backoff: {
      type:  'exponential',
      delay: 10000      // First retry after 10s — give Drive API time to recover
    }
  }
});

// Video analysis queue — runs FFmpeg scene detection + audio energy analysis on videos.
// Max 2 concurrent — FFmpeg is CPU-intensive; running too many at once slows the server.
// Only processes videos that are newly added to the library (analysis_status = 'pending').
//
// attempts: 1 (no retry) — analysis failures are non-critical; the clip picker falls back
// to the manual slider. More importantly, a video that is too large / corrupted will
// OOM-kill or timeout on every attempt — retrying just wastes CPU and blocks the queue.
// The mediaAgent marks the item as 'failed' so the user sees the badge, not a spinner.
const mediaAnalysisQueue = new Queue('media-analysis', {
  connection,
  defaultJobOptions: {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 1,
    backoff: {
      type:  'exponential',
      delay: 15000
    }
  }
});

// DM queue — sends DMs via Meta Graph API when comment triggers match.
// Rate-limited to prevent hitting platform DM caps.
// Also handles periodic cleanup of expired conversations (24hr window).
const dmQueue = new Queue('dm', {
  connection,
  defaultJobOptions: {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 3,
    backoff: {
      type:  'exponential',
      delay: 5000
    }
  }
});

// Email queue — admin bulk email campaigns via Resend.
// Concurrency 1 in the worker (one campaign at a time).
// No auto-retry — admin can re-send manually if a campaign fails.
const emailQueue = new Queue('email', {
  connection,
  defaultJobOptions: {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 1,
    backoff: {
      type:  'exponential',
      delay: 5000
    }
  }
});

// Watchdog queue — system health monitoring, anomaly detection, auto-pause.
// Runs every 5 minutes. Concurrency 1 (only one check at a time).
// Does not need retries — if a check fails, the next scheduled run will try again.
const watchdogQueue = new Queue('watchdog', {
  connection,
  defaultJobOptions: {
    ...DEFAULT_JOB_OPTIONS,
    attempts: 1
  }
});

module.exports = {
  publishQueue,
  commentQueue,
  mediaScanQueue,
  performanceQueue,
  researchQueue,
  mediaAnalysisQueue,
  mediaProcessQueue,
  dmQueue,
  emailQueue,
  watchdogQueue,
  connection    // Exported so workers can use the same parsed connection config
};
