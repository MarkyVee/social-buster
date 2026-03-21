/**
 * server.js
 *
 * Main entry point for the Social Buster backend API server.
 * Start with: node server.js (or via Docker)
 */

// Load environment variables from .env FIRST — before anything else
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const { connectRedis }        = require('./services/redisService');
const { cleanupOldTempFiles } = require('./services/ffmpegService');

// ----------------------------------------------------------------
// Route imports
// ----------------------------------------------------------------
const authRoutes        = require('./routes/auth');
const billingRoutes     = require('./routes/billing');
const briefsRoutes      = require('./routes/briefs');        // Phase 2
const postsRoutes       = require('./routes/posts');         // Phase 2
const mediaRoutes       = require('./routes/media');         // Phase 4
const publishRoutes     = require('./routes/publish');       // Phase 5
const intelligenceRoutes = require('./routes/intelligence'); // Phase 5
const adminRoutes       = require('./routes/admin');          // Admin dashboard + BullMQ Board
const messagesRoutes    = require('./routes/messages');       // User-facing inbox + messaging
const automationsRoutes = require('./routes/automations');    // DM automation CRUD + leads
const webhooksRoutes    = require('./routes/webhooks');       // Meta webhook receiver (DM replies)
const emailRoutes       = require('./routes/email');          // Admin bulk email (groups + campaigns)

// ----------------------------------------------------------------
// BullMQ worker orchestrator (Phase 5)
// Replaces individual agent polling loops with a managed job queue system.
// Workers start listening immediately on import; startAllWorkers() registers
// the repeatable schedule and seeds any one-time startup jobs.
// ----------------------------------------------------------------
const { startAllWorkers } = require('./workers');

const app = express();
const PORT = process.env.PORT || 3000;

// ----------------------------------------------------------------
// IMPORTANT: Mount the Stripe webhook BEFORE express.json().
// Stripe requires the raw request body Buffer for signature verification.
// If express.json() runs first, the raw body is consumed and verification fails.
//
// We use app.post() directly (not app.use() with the billing router) because
// app.use('/billing/webhook', billingRoutes) would strip the prefix and the
// router would see path '/' instead of '/webhook', causing a mismatch.
// The route's own express.raw() middleware ensures the body stays as a Buffer.
// ----------------------------------------------------------------
app.post('/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const { constructWebhookEvent, handleWebhookEvent } = require('./services/stripeService');
  const signature = req.headers['stripe-signature'];

  if (!signature) {
    return res.status(400).json({ error: 'Missing Stripe signature' });
  }

  let event;
  try {
    event = constructWebhookEvent(req.body, signature);
  } catch (err) {
    console.error('[Stripe Webhook] Signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook signature invalid: ${err.message}` });
  }

  try {
    await handleWebhookEvent(event);
    return res.json({ received: true });
  } catch (err) {
    console.error('[Stripe Webhook] Event handling FAILED:', err.message);
    return res.status(400).json({ error: err.message });
  }
});

// IMPORTANT: Mount Meta webhook route BEFORE express.json().
// Meta webhook signature verification needs the raw request body.
// The route handles its own body parsing via express.raw().
app.use('/webhooks/meta', webhooksRoutes);

// ----------------------------------------------------------------
// Global middleware
// ----------------------------------------------------------------

// Set secure HTTP headers (removes X-Powered-By, sets Content-Security-Policy, etc.)
app.use(helmet({
  // Allow serving the frontend from the same origin
  contentSecurityPolicy: false
}));

// Enable CORS so the frontend can call the API
// In production, replace '*' with your actual domain
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Parse incoming JSON request bodies (max 10MB for media metadata)
app.use(express.json({ limit: '10mb' }));

// Log every request: method, path, status, response time
// Use 'dev' format in development, 'combined' in production
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ----------------------------------------------------------------
// Serve the static frontend files
// In production this would be behind nginx, but this works for dev
// ----------------------------------------------------------------
app.use(express.static(path.join(__dirname, '../frontend/public')));

// ----------------------------------------------------------------
// API Routes
// ----------------------------------------------------------------
app.use('/auth', authRoutes);
app.use('/billing', billingRoutes);
app.use('/briefs', briefsRoutes);         // Phase 2 — brief submission + AI generation
app.use('/posts', postsRoutes);           // Phase 2 — view and edit generated posts
app.use('/media', mediaRoutes);           // Phase 4 — media library + cloud storage
app.use('/publish', publishRoutes);       // Phase 5 — queue management + platform connections
app.use('/intelligence', intelligenceRoutes); // Phase 5 — insights, research, comments
app.use('/admin', adminRoutes);           // Admin dashboard + BullMQ Board (protected by requireAdmin)
app.use('/messages', messagesRoutes);     // User inbox + messaging (protected by requireAuth)
app.use('/automations', automationsRoutes); // DM automation CRUD + leads export
app.use('/email', emailRoutes);            // Admin bulk email (groups + campaigns)

// ----------------------------------------------------------------
// Health check endpoint — Docker and load balancers use this
// ----------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ----------------------------------------------------------------
// SPA fallback: serve index.html for any unmatched routes
// so client-side routing (#dashboard, #brief, etc.) works
// ----------------------------------------------------------------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

// ----------------------------------------------------------------
// Global error handler
// Catches any unhandled errors thrown in route handlers.
// Returns a clean JSON error response instead of crashing.
// ----------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('[Server] Unhandled error:', err);
  res.status(500).json({
    error: 'An unexpected error occurred. Please try again.',
    // Only expose error details in development
    ...(process.env.NODE_ENV !== 'production' && { details: err.message })
  });
});


// ----------------------------------------------------------------
// Startup sequence
// ----------------------------------------------------------------
// ----------------------------------------------------------------
// validateStartupDependencies
// Checks that critical env vars and binaries are present at boot.
// Logs clear errors so the operator knows exactly what's missing
// rather than getting cryptic failures later in background agents.
// ----------------------------------------------------------------
function validateStartupDependencies() {
  const required = [
    'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
    'TOKEN_ENCRYPTION_KEY', 'LLM_API_KEY', 'LLM_BASE_URL'
  ];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  // Validate TOKEN_ENCRYPTION_KEY length (must be ≥ 32 chars for AES-256)
  if (process.env.TOKEN_ENCRYPTION_KEY.length < 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be at least 32 characters long');
  }

  // Warn (don't crash) if FFmpeg is missing — only needed for video publishing
  const fs = require('fs');
  const ffmpegPath = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
  if (!fs.existsSync(ffmpegPath)) {
    console.warn(`[Server] WARNING: FFmpeg not found at ${ffmpegPath}. Video trimming will fail.`);
  }
}

// ================================================================
// SELF-HEALING HEALTH CHECK
//
// Runs on two cadences:
//   Every 5 minutes  — critical checks: Redis, workers, failed jobs
//   Every 60 minutes — full checks: DB, env vars, external APIs
//
// For each problem found it tries to FIX IT FIRST, then reports
// anything it couldn't fix. Only emails the admin when status
// CHANGES (ok → degraded/critical), not on every check.
//
// What it auto-fixes:
//   • Failed BullMQ jobs — retries them (up to 3 times before giving up)
//   • Workers with no active listeners — logs warning (Docker restarts them)
//
// What it alerts on (can't auto-fix):
//   • Redis down or unreachable
//   • Database unreachable
//   • Missing critical env vars
//   • External APIs returning errors (Cloudflare, LLM, Stripe)
//
// What it CANNOT fix (requires code changes):
//   • Bugs (e.g., missing token refresh logic — fixed in code, not here)
//   • Expired API keys — alerts you so you can rotate them
//   • Platform API changes — alerts you, requires manual investigation
//
// Email alerts: set SMTP_HOST, SMTP_USER, SMTP_PASS, ALERT_EMAIL_TO in .env
// If SMTP is not set, all alerts go to console (Docker logs) only.
// ================================================================

// Tracks the last known status so we only email on status CHANGES.
// Stored in memory — resets to 'ok' on each restart (intentional:
// a fresh boot is a good time to get a status email if something is wrong).
let _lastHealthStatus = 'ok';

// ----------------------------------------------------------------
// autoRemediate — attempts to fix known fixable issues.
// Returns an array of remediation action strings for logging.
// ----------------------------------------------------------------
async function autoRemediate(queues) {
  const actions = [];

  for (const [name, q] of Object.entries(queues)) {
    try {
      // Get failed jobs — these are jobs that exhausted all retry attempts
      const failedJobs = await q.getFailed();
      if (failedJobs.length === 0) continue;

      // Retry jobs that have failed fewer than 3 times total across all retries.
      // Jobs that have already been manually retried 3 times are discarded
      // (they have a permanent bug and retrying won't help).
      let retried = 0;
      let discarded = 0;
      for (const job of failedJobs) {
        const attemptsMade = job.attemptsMade || 0;
        if (attemptsMade < 3) {
          await job.retry();
          retried++;
        } else {
          // Job has genuinely failed too many times — remove it so the
          // failed count doesn't stay elevated and trigger repeated alerts.
          await job.remove();
          discarded++;
        }
      }

      if (retried > 0)   actions.push(`Auto-retried ${retried} failed job(s) in queue "${name}"`);
      if (discarded > 0) actions.push(`Discarded ${discarded} permanently failed job(s) in queue "${name}" (exceeded retry limit)`);

    } catch (e) {
      // Remediation failure is non-fatal — we still report the issue below
      actions.push(`Could not remediate queue "${name}": ${e.message}`);
    }
  }

  return actions;
}

// ----------------------------------------------------------------
// runHealthCheck
//
// mode: 'quick'  — Redis + workers + jobs only (runs every 5 min)
//       'full'   — everything including DB, env vars, APIs (runs hourly)
// ----------------------------------------------------------------
async function runHealthCheck(mode = 'full') {
  try {
    const {
      publishQueue, commentQueue, mediaScanQueue,
      performanceQueue, researchQueue, mediaAnalysisQueue
    } = require('./queues');
    const { cacheGet, cacheSet } = require('./services/redisService');
    const { supabaseAdmin }      = require('./services/supabaseService');
    const { sendAlert }          = require('./services/alertService');

    const issues  = [];
    const fixed   = [];
    let   highest = 'ok';

    const bump = (level) => {
      if (level === 'critical') highest = 'critical';
      else if (level === 'degraded' && highest !== 'critical') highest = 'degraded';
    };

    const queues = {
      publish:          publishQueue,
      comment:          commentQueue,
      'media-scan':     mediaScanQueue,
      performance:      performanceQueue,
      research:         researchQueue,
      'media-analysis': mediaAnalysisQueue
    };

    // ---- 1. Redis ping (always) ----
    try {
      await cacheSet('health:ping', '1', 30);
      const v = await cacheGet('health:ping');
      if (v !== '1') { issues.push('Redis: round-trip check failed'); bump('critical'); }
    } catch (e) { issues.push(`Redis unreachable: ${e.message}`); bump('critical'); }

    // ---- 2. Auto-remediate failed jobs BEFORE checking counts ----
    const remediations = await autoRemediate(queues);
    fixed.push(...remediations);

    // ---- 3. Worker liveness + remaining failed jobs (always) ----
    for (const [name, q] of Object.entries(queues)) {
      try {
        const [failedCount, workers] = await Promise.all([q.getFailedCount(), q.getWorkers()]);
        if ((workers?.length ?? 0) < 1) {
          issues.push(`Queue "${name}": no active worker — jobs queued but not processing`);
          bump('degraded');
        }
        // After remediation, if jobs are still failing they have a real bug
        if (failedCount > 0) {
          issues.push(`Queue "${name}": ${failedCount} job(s) still failing after auto-retry — manual inspection needed`);
          bump('degraded');
        }
      } catch (e) { issues.push(`Queue "${name}" unreachable: ${e.message}`); bump('degraded'); }
    }

    // ---- 4. Full checks — only run hourly to reduce DB/API load ----
    if (mode === 'full') {

      // Database connectivity
      try {
        const { error } = await supabaseAdmin
          .from('user_profiles')
          .select('*', { count: 'exact', head: true });
        if (error) { issues.push(`Database: ${error.message}`); bump('degraded'); }
      } catch (e) { issues.push(`Database unreachable: ${e.message}`); bump('critical'); }

      // Critical env vars — missing ones mean features are completely broken
      const criticalVars = [
        'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
        'TOKEN_ENCRYPTION_KEY', 'LLM_API_KEY', 'LLM_BASE_URL',
        'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'
      ];
      const missingVars = criticalVars.filter(k => !(process.env[k] || '').trim());
      if (missingVars.length) {
        issues.push(`Missing env vars: ${missingVars.join(', ')}`);
        bump('critical');
      }

      // Cloudflare Workers AI — verify token is still valid (zero-cost models list call)
      if (process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) {
        try {
          const axios = require('axios');
          const cfRes = await axios.get(
            `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/models/search?per_page=1`,
            { headers: { 'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` }, timeout: 8000 }
          );
          if (!cfRes.data?.success) {
            issues.push('Cloudflare AI: API returned success=false — image generation may be broken');
            bump('degraded');
          }
        } catch (e) {
          const status = e.response?.status;
          if (status === 401 || status === 403) {
            issues.push('Cloudflare AI: API token invalid or expired — image generation is broken');
            bump('critical');
          } else {
            issues.push(`Cloudflare AI: connectivity issue (${e.message})`);
            bump('degraded');
          }
        }
      }

      // LLM endpoint — verify it responds
      if (process.env.LLM_BASE_URL && process.env.LLM_API_KEY) {
        try {
          const axios = require('axios');
          await axios.get(`${process.env.LLM_BASE_URL}/models`, {
            headers: { 'Authorization': `Bearer ${process.env.LLM_API_KEY}` },
            timeout: 8000
          });
        } catch (e) {
          const status = e.response?.status;
          if (status === 401 || status === 403) {
            issues.push('LLM API: key invalid or expired — AI content generation is broken');
            bump('critical');
          } else if (status === 429) {
            issues.push('LLM API: rate limit hit — content generation temporarily unavailable');
            bump('degraded');
          } else if (e.code !== 'ECONNABORTED') { // ignore timeouts (LLM can be slow)
            issues.push(`LLM API: connectivity issue (${e.message})`);
            bump('degraded');
          }
        }
      }
    }

    // ---- 5. Log result ----
    const prefix = highest === 'ok'       ? '[HEALTH OK]'
                 : highest === 'critical' ? '[HEALTH CRITICAL]'
                 :                          '[HEALTH DEGRADED]';
    const ts = new Date().toISOString();

    if (fixed.length > 0) {
      console.log(`[HEALTH AUTO-FIXED] ${ts}`);
      fixed.forEach(f => console.log(`  ✓ ${f}`));
    }

    if (highest === 'ok') {
      // Log OK every hour (quiet on quick checks unless something changed)
      if (mode === 'full') console.log(`${prefix} All systems operational — ${ts}`);
    } else {
      console.error(`${prefix} ${ts}`);
      issues.forEach(i => console.error(`  • ${i}`));
    }

    // ---- 6. Email alert on status CHANGE only ----
    // Goes from ok → degraded/critical: send alert
    // Stays degraded/critical: no repeat email (already alerted)
    // Goes back to ok: send "resolved" email
    if (highest !== 'ok' && _lastHealthStatus === 'ok') {
      const subject = `${highest === 'critical' ? '🚨 CRITICAL' : '⚠️ DEGRADED'} — Social Buster needs attention`;
      const body    = [
        `Status changed to: ${highest.toUpperCase()}`,
        '',
        'Issues detected:',
        ...issues.map(i => `  • ${i}`),
        ...(fixed.length > 0 ? ['', 'Auto-fixed:', ...fixed.map(f => `  ✓ ${f}`)] : [])
      ].join('\n');
      await sendAlert(subject, body);
    } else if (highest === 'ok' && _lastHealthStatus !== 'ok') {
      await sendAlert('✅ RESOLVED — Social Buster is back to normal', 'All health checks are passing.');
    }

    _lastHealthStatus = highest;

  } catch (err) {
    console.error('[HEALTH CHECK ERROR]', err.message);
  }
}

// ----------------------------------------------------------------
// scheduleHealthCheck
//
// Quick check (Redis + workers + jobs) every 5 minutes.
// Full check (everything) every 60 minutes.
// Both start after a 60-second delay to let workers settle on boot.
// ----------------------------------------------------------------
function scheduleHealthCheck() {
  setTimeout(() => {
    // First full check after boot
    runHealthCheck('full');

    // Quick check every 5 minutes
    setInterval(() => runHealthCheck('quick'), 5 * 60 * 1000);

    // Full check every 60 minutes
    setInterval(() => runHealthCheck('full'), 60 * 60 * 1000);

  }, 60 * 1000);
}

async function start() {
  try {
    // Validate critical env vars and binaries before anything else
    validateStartupDependencies();

    // Connect to Redis cache
    connectRedis();
    console.log('[Server] Redis connection initiated');

    // Clean up any temp files left over from a previous run (e.g. after a crash).
    // Also schedule periodic cleanup every 6 hours to prevent disk fill.
    cleanupOldTempFiles();
    setInterval(cleanupOldTempFiles, 6 * 60 * 60 * 1000);

    // Start BullMQ workers (publishing, comment, media-scan, performance, research)
    await startAllWorkers();

    // Start the HTTP server
    app.listen(PORT, () => {
      console.log(`[Server] Social Buster API running on port ${PORT}`);
      console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`[Server] Frontend: http://localhost:${PORT}`);
    });

    // ----------------------------------------------------------------
    // Automated health check — runs every hour and logs to stdout.
    //
    // Why: The /admin/health endpoint is only useful if a human visits
    // the dashboard. In production (Docker/Coolify), stdout is captured
    // by the logging system. This means broken workers, failed jobs, or
    // expired API keys are visible in your server logs without anyone
    // needing to log in.
    //
    // Log prefixes Docker/Coolify log monitoring can alert on:
    //   [HEALTH OK]       — all systems green
    //   [HEALTH DEGRADED] — features broken, needs attention
    //   [HEALTH CRITICAL] — platform is down
    // ----------------------------------------------------------------
    scheduleHealthCheck();

  } catch (err) {
    console.error('[Server] Failed to start:', err);
    process.exit(1);
  }
}

start();
