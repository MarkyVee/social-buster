/**
 * routes/admin.js
 *
 * Admin-only routes + BullMQ Board queue monitor.
 *
 * All routes require:
 *   1. requireAuth   — valid JWT
 *   2. requireAdmin  — email must be in ADMIN_EMAILS env var
 *
 * Routes:
 *   GET  /admin/health         — Redis ping + queue depths + DB row counts
 *   GET  /admin/stats          — Platform-wide KPIs (users, posts, jobs)
 *   GET  /admin/users          — Paginated user list (?page=1&limit=50&q=search)
 *   GET  /admin/users/:id      — Single user detail (profile + recent posts + metrics)
 *   PUT  /admin/users/:id      — Override a user's subscription tier or add notes
 *   GET  /admin/queues/*       — BullMQ Board (visual job queue monitor UI)
 */

const express = require('express');
const router  = express.Router();

const { requireAuth }    = require('../middleware/auth');
const { requireAdmin }   = require('../middleware/adminAuth');
const { supabaseAdmin }  = require('../services/supabaseService');
const { cacheGet }       = require('../services/redisService');

const {
  publishQueue,
  commentQueue,
  mediaScanQueue,
  performanceQueue,
  researchQueue,
  mediaAnalysisQueue,
  dmQueue,
  emailQueue
} = require('../queues');

// ----------------------------------------------------------------
// Mount BullMQ Board at /admin/queues
//
// The board is a separate Express middleware that serves its own
// static assets and API. We protect it with our admin middleware
// before mounting so anonymous users can't reach it.
//
// Packages required: @bull-board/api @bull-board/express
// Install: npm install @bull-board/api @bull-board/express
// ----------------------------------------------------------------
try {
  const { createBullBoard }  = require('@bull-board/api');
  const { BullMQAdapter }    = require('@bull-board/api/bullMQAdapter');
  const { ExpressAdapter }   = require('@bull-board/express');

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');

  createBullBoard({
    queues: [
      new BullMQAdapter(publishQueue,       { readOnlyMode: false }),
      new BullMQAdapter(commentQueue,       { readOnlyMode: false }),
      new BullMQAdapter(mediaScanQueue,     { readOnlyMode: false }),
      new BullMQAdapter(performanceQueue,   { readOnlyMode: false }),
      new BullMQAdapter(researchQueue,      { readOnlyMode: false }),
      new BullMQAdapter(mediaAnalysisQueue, { readOnlyMode: false }),
      new BullMQAdapter(dmQueue,            { readOnlyMode: false }),
      new BullMQAdapter(emailQueue,         { readOnlyMode: false })
    ],
    serverAdapter
  });

  // Protect the entire /queues sub-path with admin auth, then hand off to Bull Board
  router.use('/queues', requireAuth, requireAdmin, serverAdapter.getRouter());

  console.log('[Admin] BullMQ Board mounted at /admin/queues');

} catch (err) {
  // Non-fatal — admin dashboard still works without the Board UI
  // Install @bull-board/api and @bull-board/express to enable it
  console.warn('[Admin] BullMQ Board not available:', err.message);
  router.get('/queues', requireAuth, requireAdmin, (req, res) => {
    res.status(503).json({
      error: 'BullMQ Board not installed. Run: npm install @bull-board/api @bull-board/express'
    });
  });
}

// Apply auth + admin check to all remaining routes in this file
router.use(requireAuth, requireAdmin);

// ----------------------------------------------------------------
// GET /admin/health
//
// Quick platform health check:
//   - Redis connectivity (ping)
//   - Queue depths (active, waiting, failed counts per queue)
//   - DB connectivity (row count from a lightweight table)
//
// Used by monitoring tools (uptime robots, Docker health checks).
// ----------------------------------------------------------------
router.get('/health', async (req, res) => {
  const health = {
    status:         'ok',
    timestamp:      new Date().toISOString(),
    redis:          'unknown',
    database:       'unknown',
    storage:        'unknown',
    workers:        {},
    queues:         {},
    env_vars:       {},
    external_apis:  {},
    rls_issues:     []          // Tables with RLS enabled but no policy
  };

  const axios = require('axios');

  // ---- Redis ping ----
  // Write + read a test key. If this fails all queues are broken.
  try {
    const testKey = 'admin:health:ping';
    const { cacheSet } = require('../services/redisService');
    await cacheSet(testKey, '1', 10);
    const val = await cacheGet(testKey);
    health.redis = val === '1' ? 'ok' : 'error — key did not round-trip';
    if (health.redis !== 'ok') health.status = 'degraded';
  } catch (err) {
    health.redis  = `error — ${err.message}`;
    health.status = 'critical'; // Redis down = nothing works
  }

  // ---- Queue depths + worker liveness ----
  //
  // queue.getWorkers() returns the list of workers currently registered
  // in Redis for that queue. If workers = 0, jobs will pile up forever
  // and nothing will publish — this is the most dangerous silent failure.
  const queues = {
    publish:          publishQueue,
    comment:          commentQueue,
    'media-scan':     mediaScanQueue,
    performance:      performanceQueue,
    research:         researchQueue,
    'media-analysis': mediaAnalysisQueue
  };

  for (const [name, q] of Object.entries(queues)) {
    try {
      const [waiting, active, failed, delayed, workers] = await Promise.all([
        q.getWaitingCount(),
        q.getActiveCount(),
        q.getFailedCount(),
        q.getDelayedCount(),
        q.getWorkers()
      ]);
      const workerCount = workers?.length ?? 0;
      health.queues[name] = { waiting, active, failed, delayed, workers: workerCount };

      if (failed > 0)      health.status = health.status !== 'critical' ? 'degraded' : health.status;
      if (workerCount < 1) health.status = health.status !== 'critical' ? 'degraded' : health.status;
    } catch (err) {
      health.queues[name] = { error: err.message };
      health.status = health.status !== 'critical' ? 'degraded' : health.status;
    }
  }

  // Summary: total workers across all queues. Each worker process registers
  // on every queue it handles, so a healthy system shows at least 1 per queue.
  const workerless = Object.entries(health.queues)
    .filter(([, q]) => !q.error && q.workers === 0)
    .map(([name]) => name);
  if (workerless.length > 0) {
    health.workers.warning = `No active workers on: ${workerless.join(', ')} — jobs will not process`;
  } else {
    health.workers.status = 'ok — all queues have active workers';
  }

  // ---- DB connectivity ----
  try {
    const { count, error } = await supabaseAdmin
      .from('user_profiles')
      .select('*', { count: 'exact', head: true });
    health.database = error ? `error — ${error.message}` : `ok (${count} users)`;
    if (error) health.status = health.status !== 'critical' ? 'degraded' : health.status;
  } catch (err) {
    health.database = `error — ${err.message}`;
    health.status   = health.status !== 'critical' ? 'degraded' : health.status;
  }

  // ---- Supabase Storage bucket check ----
  //
  // Verify the required storage buckets are accessible.
  // We check for three buckets: ai-generated-images, video-segments, processed-media.
  // If listBuckets fails entirely (Supabase intermittent issue), treat as warning not error.
  const REQUIRED_BUCKETS = ['ai-generated-images', 'video-segments', 'processed-media'];
  try {
    const { data: buckets, error: bucketErr } = await supabaseAdmin.storage.listBuckets();

    if (bucketErr) {
      // Supabase storage API intermittently fails — don't mark as degraded
      health.storage = `warning — bucket check failed: ${bucketErr.message} (may be transient)`;
    } else {
      const bucketNames = (buckets || []).map(b => b.name);
      const missing     = REQUIRED_BUCKETS.filter(name => !bucketNames.includes(name));
      const privateBkts = (buckets || []).filter(b => REQUIRED_BUCKETS.includes(b.name) && b.public === false);

      if (missing.length > 0) {
        // Supabase listBuckets() sometimes returns empty even when buckets exist
        // (permissions issue with service role listing). Don't mark as degraded —
        // actual upload/download failures are caught at the point of use.
        health.storage = `warning — listBuckets returned ${bucketNames.length} bucket(s), expected ${REQUIRED_BUCKETS.length}. This may be a Supabase API permissions issue.`;
      } else if (privateBkts.length > 0) {
        health.storage = `warning — private bucket(s): ${privateBkts.map(b => b.name).join(', ')}. Set to public in Supabase dashboard.`;
      } else {
        health.storage = `ok — all ${REQUIRED_BUCKETS.length} buckets exist and are public`;
      }
    }
  } catch (err) {
    // Don't degrade for transient storage API errors
    health.storage = `warning — bucket check error: ${err.message} (non-blocking)`;
  }

  // ---- Environment variable audit ----
  //
  // Check every required variable. This runs on every health call (not just at startup)
  // so a bad redeploy that drops vars is caught immediately without restarting.
  //
  // Variables are grouped by severity:
  //   critical — server does not function at all without these
  //   important — major features break without these
  //   optional  — non-fatal (billing not yet live, etc.)
  const envChecks = [
    { key: 'SUPABASE_URL',              level: 'critical',  label: 'Supabase URL' },
    { key: 'SUPABASE_ANON_KEY',         level: 'critical',  label: 'Supabase anon key' },
    { key: 'SUPABASE_SERVICE_ROLE_KEY', level: 'critical',  label: 'Supabase service role key' },
    { key: 'TOKEN_ENCRYPTION_KEY',      level: 'critical',  label: 'Token encryption key' },
    { key: 'LLM_API_KEY',               level: 'critical',  label: 'LLM API key (post generation)' },
    { key: 'LLM_BASE_URL',              level: 'critical',  label: 'LLM base URL' },
    { key: 'LLM_MODEL',                 level: 'important', label: 'LLM model name' },
    { key: 'CLOUDFLARE_ACCOUNT_ID',    level: 'important', label: 'Cloudflare account ID (image generation)' },
    { key: 'CLOUDFLARE_API_TOKEN',     level: 'important', label: 'Cloudflare API token (image generation)' },
    { key: 'ADMIN_EMAILS',              level: 'important', label: 'Admin email list' },
    { key: 'REDIS_URL',                 level: 'important', label: 'Redis connection URL' },
    { key: 'FRONTEND_URL',              level: 'important', label: 'Frontend URL (CORS + reset links)' },
    { key: 'STRIPE_SECRET_KEY',         level: 'optional',  label: 'Stripe secret key (billing)' },
    { key: 'STRIPE_WEBHOOK_SECRET',     level: 'optional',  label: 'Stripe webhook secret' },
    { key: 'META_WEBHOOK_VERIFY_TOKEN', level: 'optional',  label: 'Meta webhook verify token (DM automation)' }
  ];

  let missingCritical = false;
  health.env_vars.summary = [];

  for (const { key, level, label } of envChecks) {
    const isSet = !!(process.env[key] || '').trim();
    const entry = { key, label, level, status: isSet ? 'set' : 'missing' };
    health.env_vars.summary.push(entry);
    if (!isSet && level === 'critical') {
      missingCritical = true;
      health.status = 'critical';
    }
    if (!isSet && level === 'important') {
      health.status = health.status !== 'critical' ? 'degraded' : health.status;
    }
  }

  health.env_vars.missing_critical  = missingCritical;
  health.env_vars.missing_count     = health.env_vars.summary.filter(e => e.status === 'missing').length;

  // ---- External API key checks ----

  // Cloudflare Workers AI — verify token by listing AI models (zero cost, read-only)
  try {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '';
    const apiToken  = process.env.CLOUDFLARE_API_TOKEN  || '';
    if (!accountId || !apiToken) {
      health.external_apis.cloudflare_ai = 'missing — set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in .env';
      health.status = health.status !== 'critical' ? 'degraded' : health.status;
    } else {
      const cfRes = await axios.get(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=1`,
        { headers: { 'Authorization': `Bearer ${apiToken}` }, timeout: 8000 }
      );
      health.external_apis.cloudflare_ai = cfRes.data?.success ? 'ok' : 'unexpected response from Cloudflare';
    }
  } catch (err) {
    const s = err.response?.status;
    health.external_apis.cloudflare_ai = (s === 401 || s === 403)
      ? 'invalid token or missing Workers AI permission — check dash.cloudflare.com/profile/api-tokens'
      : `error (HTTP ${s || '?'}) — ${err.message}`;
    health.status = health.status !== 'critical' ? 'degraded' : health.status;
  }

  // LLM (Groq / OpenAI-compatible) — live check via /models endpoint, zero cost
  try {
    const llmBase = process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1';
    const llmKey  = process.env.LLM_API_KEY  || '';
    if (!llmKey) {
      health.external_apis.llm = 'missing — set LLM_API_KEY in .env';
      health.status = health.status !== 'critical' ? 'degraded' : health.status;
    } else {
      const llmRes     = await axios.get(`${llmBase}/models`, {
        headers: { 'Authorization': `Bearer ${llmKey}` },
        timeout: 8000
      });
      const modelCount = llmRes.data?.data?.length ?? '?';
      health.external_apis.llm = `ok (${modelCount} models visible)`;
    }
  } catch (err) {
    const s = err.response?.status;
    health.external_apis.llm = (s === 401 || s === 403)
      ? 'invalid or expired key — check LLM_API_KEY in .env'
      : `error — ${err.message}`;
    health.status = health.status !== 'critical' ? 'degraded' : health.status;
  }

  // Stripe — live balance check
  try {
    const stripeKey = process.env.STRIPE_SECRET_KEY || '';
    if (!stripeKey) {
      health.external_apis.stripe = 'not configured (ok — billing not yet enabled)';
    } else {
      const stripeRes = await axios.get('https://api.stripe.com/v1/balance', {
        auth: { username: stripeKey, password: '' },
        timeout: 8000
      });
      health.external_apis.stripe = stripeRes.status === 200 ? 'ok' : `unexpected status ${stripeRes.status}`;
    }
  } catch (err) {
    const s = err.response?.status;
    health.external_apis.stripe = s === 401
      ? 'invalid key — check STRIPE_SECRET_KEY in .env'
      : `error — ${err.message}`;
    // Stripe failure is degraded, not critical — billing not live yet
    health.status = health.status !== 'critical' ? 'degraded' : health.status;
  }

  // Meta Webhook — check if DM automation webhook is configured
  health.external_apis.meta_webhook = process.env.META_WEBHOOK_VERIFY_TOKEN
    ? 'configured'
    : 'not configured (DM reply handling disabled)';

  // ---- RLS policy check ----
  // Find tables that have Row Level Security ON but no policy defined.
  // Without a policy, ALL writes are silently rejected — even from supabaseAdmin.
  // This has caused real data loss bugs (dm_conversations, dm_collected_data).
  try {
    const { data: unprotected } = await supabaseAdmin.rpc('check_rls_policies');
    if (unprotected && unprotected.length > 0) {
      health.rls_issues = unprotected.map(t => t.table_name);
      health.status = 'critical';
    }
  } catch (e) {
    // RPC not created yet — non-fatal, just note it
    health.rls_issues = null; // null = check not available (RPC missing)
  }

  // ---- Final status determination ----
  // 'critical' = platform is fully down (Redis gone, DB gone, or required env vars missing)
  // 'degraded' = platform is up but features are broken (failed jobs, missing workers, bad API keys)
  // 'ok'       = everything checks out
  // Always return 200 — the status field in the JSON body carries the health signal.
  // Returning 503 causes apiFetch (and monitoring tools) to treat this as a request
  // failure, which means the admin dashboard never sees the degraded/critical data.
  return res.status(200).json(health);
});

// ----------------------------------------------------------------
// GET /admin/stats
//
// Platform-wide KPIs for the admin overview dashboard:
//   - Total registered users
//   - Users who have published at least one post (active users)
//   - Total posts published (all time)
//   - Posts published in the last 7 days
//   - Total post_metrics records (proxy for platform engagement activity)
//   - Failed jobs across all queues (needs attention indicator)
// ----------------------------------------------------------------
router.get('/stats', async (req, res) => {
  try {
    const now          = new Date();
    const sevenDaysAgo = new Date(Date.now() - 7  * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo= new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    // Start of today (UTC midnight)
    const todayStart   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

    // Run all DB + Auth queries in parallel for speed.
    // Total Users comes from Supabase Auth (the source of truth for registered accounts),
    // not user_profiles (which may be missing rows for users who haven't completed onboarding).
    const [
      authListResult,
      { count: totalPosts },
      { count: recentPosts },
      { count: totalMetrics },
      { count: totalBriefs },
      { count: briefs7d },
      { count: newUsersToday },
      { count: newUsers7d },
      // For DAU/MAU we need user_ids — fetch just that column, deduplicate in JS
      { data: dauRows },
      { data: mauRows }
    ] = await Promise.all([
      supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1 }),
      supabaseAdmin.from('posts').select('*',               { count: 'exact', head: true }).eq('status', 'published'),
      supabaseAdmin.from('posts').select('*',               { count: 'exact', head: true }).eq('status', 'published').gte('published_at', sevenDaysAgo),
      supabaseAdmin.from('post_metrics').select('*',        { count: 'exact', head: true }),
      supabaseAdmin.from('briefs').select('*',              { count: 'exact', head: true }),
      supabaseAdmin.from('briefs').select('*',              { count: 'exact', head: true }).gte('created_at', sevenDaysAgo),
      supabaseAdmin.from('user_profiles').select('*',       { count: 'exact', head: true }).gte('created_at', todayStart),
      supabaseAdmin.from('user_profiles').select('*',       { count: 'exact', head: true }).gte('created_at', sevenDaysAgo),
      // DAU: distinct users who submitted a brief today
      supabaseAdmin.from('briefs').select('user_id').gte('created_at', todayStart),
      // MAU: distinct users who submitted a brief in the last 30 days
      supabaseAdmin.from('briefs').select('user_id').gte('created_at', thirtyDaysAgo)
    ]);

    // Total users from Supabase Auth (includes users without profiles)
    const totalUsers = authListResult?.data?.total || 0;

    // Count distinct user_ids for DAU and MAU
    const dau = new Set((dauRows || []).map(r => r.user_id)).size;
    const mau = new Set((mauRows || []).map(r => r.user_id)).size;

    // Total failed jobs across all queues
    let totalFailed = 0;
    for (const q of [publishQueue, commentQueue, mediaScanQueue, performanceQueue, researchQueue, mediaAnalysisQueue]) {
      try { totalFailed += await q.getFailedCount(); } catch (_) {}
    }

    return res.json({
      total_users:       totalUsers   || 0,
      total_posts:       totalPosts   || 0,
      recent_posts_7d:   recentPosts  || 0,
      total_metrics:     totalMetrics || 0,
      total_briefs:      totalBriefs  || 0,
      briefs_7d:         briefs7d     || 0,
      new_users_today:   newUsersToday|| 0,
      new_users_7d:      newUsers7d   || 0,
      dau,
      mau,
      total_failed_jobs: totalFailed
    });

  } catch (err) {
    console.error('[Admin] Stats error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch platform stats' });
  }
});

// ----------------------------------------------------------------
// GET /admin/users
//
// Paginated, searchable list of all registered users.
// Optional: ?q=email_fragment  ?page=1  ?limit=50
// ----------------------------------------------------------------
router.get('/users', async (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 50);
  const q     = (req.query.q || '').trim();

  try {
    // Fetch ALL users from Supabase Auth (the source of truth for who is registered).
    // Then merge with user_profiles for brand/industry data.
    // This ensures users who registered but haven't completed onboarding still show up.
    const { data: authData, error: authErr } = await supabaseAdmin.auth.admin.listUsers({
      page,
      perPage: limit
    });

    if (authErr) throw new Error(authErr.message);

    const authUsers = authData?.users || [];
    const total     = authData?.total || authUsers.length;

    // Fetch matching profiles (if they exist)
    const userIds = authUsers.map(u => u.id);
    let profiles = [];
    if (userIds.length > 0) {
      const { data: profileData } = await supabaseAdmin
        .from('user_profiles')
        .select('user_id, brand_name, industry, geo_region, business_type, onboarding_complete, subscription_tier, created_at')
        .in('user_id', userIds);
      profiles = profileData || [];
    }

    // Build a lookup map for profiles
    const profileMap = {};
    for (const p of profiles) {
      profileMap[p.user_id] = p;
    }

    // Merge auth users with their profiles
    let users = authUsers.map(u => {
      const p = profileMap[u.id] || {};
      return {
        user_id:             u.id,
        email:               u.email,
        brand_name:          p.brand_name || null,
        industry:            p.industry || null,
        geo_region:          p.geo_region || null,
        business_type:       p.business_type || null,
        subscription_tier:   p.subscription_tier || 'free_trial',
        onboarding_complete: p.onboarding_complete || false,
        created_at:          p.created_at || u.created_at
      };
    });

    // Apply search filter if provided
    if (q) {
      const ql = q.toLowerCase();
      users = users.filter(u =>
        (u.email && u.email.toLowerCase().includes(ql)) ||
        (u.brand_name && u.brand_name.toLowerCase().includes(ql))
      );
    }

    // Sort by created_at descending
    users.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return res.json({
      users,
      total:    q ? users.length : total,
      page,
      limit,
      pages:    Math.ceil((q ? users.length : total) / limit)
    });

  } catch (err) {
    console.error('[Admin] Users list error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// ----------------------------------------------------------------
// GET /admin/users/:id
//
// Full detail for a single user — profile + recent activity.
// ----------------------------------------------------------------
router.get('/users/:id', async (req, res) => {
  const userId = req.params.id;

  try {
    // Fetch profile, recent posts, and recent metrics in parallel
    const [
      { data: profile },
      { data: recentPosts },
      { data: recentMetrics, count: metricCount }
    ] = await Promise.all([
      supabaseAdmin
        .from('user_profiles')
        .select('*')
        .eq('user_id', userId)
        .single(),

      supabaseAdmin
        .from('posts')
        .select('id, platform, status, hook, published_at, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(10),

      supabaseAdmin
        .from('post_metrics')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
    ]);

    // If no user_profiles row exists (user hasn't completed onboarding),
    // fall back to basic info from Supabase Auth so the admin can still view them.
    let userProfile = profile;
    if (!userProfile) {
      try {
        const { data: authData } = await supabaseAdmin.auth.admin.getUserById(userId);
        if (!authData?.user) {
          return res.status(404).json({ error: 'User not found' });
        }
        userProfile = {
          user_id: userId,
          email: authData.user.email,
          created_at: authData.user.created_at,
          brand_name: null,
          industry: null,
          geo_region: null,
          onboarding_completed: false
        };
      } catch (_) {
        return res.status(404).json({ error: 'User not found' });
      }
    }

    // Summarise post counts by status
    const { data: postCounts } = await supabaseAdmin
      .from('posts')
      .select('status')
      .eq('user_id', userId);

    const statusSummary = {};
    (postCounts || []).forEach(p => {
      statusSummary[p.status] = (statusSummary[p.status] || 0) + 1;
    });

    return res.json({
      profile:         userProfile,
      recent_posts:    recentPosts  || [],
      post_summary:    statusSummary,
      total_metrics:   metricCount  || 0
    });

  } catch (err) {
    console.error('[Admin] User detail error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch user detail' });
  }
});

// ----------------------------------------------------------------
// PUT /admin/users/:id
//
// Override a user's subscription tier or add admin notes.
// Body: { subscription_tier?: string, admin_notes?: string }
//
// Note: subscription_tier is stored in the user_profiles table
// (billing.js handles the Stripe side; this is the override path
// used during trials, support cases, and manual upgrades).
// ----------------------------------------------------------------
router.put('/users/:id', async (req, res) => {
  const userId = req.params.id;
  const { subscription_tier, admin_notes } = req.body;

  const validTiers = ['free_trial', 'starter', 'professional', 'enterprise', 'suspended'];

  if (subscription_tier && !validTiers.includes(subscription_tier)) {
    return res.status(400).json({
      error: `Invalid tier. Must be one of: ${validTiers.join(', ')}`
    });
  }

  try {
    const updates = { updated_at: new Date().toISOString() };
    if (subscription_tier !== undefined) updates.subscription_tier = subscription_tier;
    if (admin_notes       !== undefined) updates.admin_notes        = admin_notes;

    const { data, error } = await supabaseAdmin
      .from('user_profiles')
      .update(updates)
      .eq('user_id', userId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    if (!data)  return res.status(404).json({ error: 'User not found' });

    console.log(`[Admin] User ${userId} updated by admin ${req.user.email}: ${JSON.stringify(updates)}`);

    return res.json({ message: 'User updated successfully', user: data });

  } catch (err) {
    console.error('[Admin] User update error:', err.message);
    return res.status(500).json({ error: 'Failed to update user' });
  }
});

// ================================================================
// ADMIN MESSAGING
//
// Admin can:
//   - Read messages sent by users (inbox)
//   - Send direct messages to a specific user
//   - Broadcast a message to all users
//   - Reply to user messages
//   - Mark messages as read
//   - Delete messages
// ================================================================

// ----------------------------------------------------------------
// GET /admin/messages
//
// Admin inbox, sent messages, or broadcasts.
// Query: ?type=inbox (default) | sent | broadcast
// ----------------------------------------------------------------
router.get('/messages', async (req, res) => {
  const type = req.query.type || 'inbox';

  try {
    let data, error;

    if (type === 'broadcast') {
      // All broadcasts sent by admin
      ({ data, error } = await supabaseAdmin
        .from('admin_messages')
        .select('id, subject, body, created_at, sender_email')
        .eq('sender_type', 'admin')
        .eq('is_broadcast', true)
        .is('parent_id', null)
        .order('created_at', { ascending: false }));

    } else if (type === 'sent') {
      // Direct messages admin sent to specific users
      ({ data, error } = await supabaseAdmin
        .from('admin_messages')
        .select('id, subject, body, read_at, created_at, sender_email, recipient_id')
        .eq('sender_type', 'admin')
        .eq('is_broadcast', false)
        .is('parent_id', null)
        .order('created_at', { ascending: false }));

      // Look up recipient emails from user_profiles (denormalized display only)
      if (!error && data?.length) {
        const recipientIds = [...new Set(data.map(m => m.recipient_id).filter(Boolean))];
        if (recipientIds.length) {
          const { data: profiles } = await supabaseAdmin
            .from('user_profiles')
            .select('user_id, email')
            .in('user_id', recipientIds);
          const emailMap = Object.fromEntries((profiles || []).map(p => [p.user_id, p.email]));
          data = data.map(m => ({ ...m, recipient_email: emailMap[m.recipient_id] || m.recipient_id }));
        }
      }

    } else {
      // Inbox: messages sent by users to admin
      ({ data, error } = await supabaseAdmin
        .from('admin_messages')
        .select('id, subject, body, read_at, created_at, sender_email, sender_id')
        .eq('sender_type', 'user')
        .is('parent_id', null)
        .order('created_at', { ascending: false }));
    }

    if (error) throw new Error(error.message);

    // Count unread in inbox (used for the tab badge)
    let unread = 0;
    if (type === 'inbox') {
      const { count } = await supabaseAdmin
        .from('admin_messages')
        .select('*', { count: 'exact', head: true })
        .eq('sender_type', 'user')
        .is('read_at', null)
        .is('parent_id', null);
      unread = count || 0;
    }

    return res.json({ messages: data || [], unread });

  } catch (err) {
    console.error('[Admin Messages] List error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ----------------------------------------------------------------
// POST /admin/messages
//
// Send a direct message to a user, or broadcast to all users.
// Body: { recipient_id?: string, is_broadcast?: bool, subject: string, body: string }
// ----------------------------------------------------------------
router.post('/messages', async (req, res) => {
  const adminId = req.user.id;
  const { recipient_id, is_broadcast = false, subject, body } = req.body;

  if (!subject?.trim()) return res.status(400).json({ error: 'Subject is required' });
  if (!body?.trim())    return res.status(400).json({ error: 'Message body is required' });

  if (!is_broadcast && !recipient_id) {
    return res.status(400).json({ error: 'Either recipient_id or is_broadcast:true is required' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('admin_messages')
      .insert({
        sender_type:  'admin',
        sender_id:    adminId,
        sender_email: req.user.email,
        recipient_id: is_broadcast ? null : recipient_id,
        is_broadcast: !!is_broadcast,
        subject:      subject.trim().slice(0, 255),
        body:         body.trim()
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    console.log(`[Admin Messages] ${req.user.email} sent: ${is_broadcast ? 'BROADCAST' : `to ${recipient_id}`} — "${subject}"`);
    return res.status(201).json({ message: data });

  } catch (err) {
    console.error('[Admin Messages] Send error:', err.message);
    return res.status(500).json({ error: 'Failed to send message' });
  }
});

// ----------------------------------------------------------------
// GET /admin/messages/:id
//
// Single message thread (root + all replies).
// ----------------------------------------------------------------
router.get('/messages/:id', async (req, res) => {
  const messageId = req.params.id;

  try {
    const { data: message, error: msgErr } = await supabaseAdmin
      .from('admin_messages')
      .select('id, subject, body, sender_type, is_broadcast, recipient_id, read_at, parent_id, created_at, sender_email, sender_id')
      .eq('id', messageId)
      .single();

    if (msgErr || !message) return res.status(404).json({ error: 'Message not found' });

    // Auto-mark as read when admin opens a user-sent message
    if (message.sender_type === 'user' && !message.read_at) {
      await supabaseAdmin
        .from('admin_messages')
        .update({ read_at: new Date().toISOString() })
        .eq('id', messageId);
      message.read_at = new Date().toISOString();
    }

    // Look up recipient email for direct messages
    if (message.recipient_id) {
      const { data: profile } = await supabaseAdmin
        .from('user_profiles')
        .select('email')
        .eq('user_id', message.recipient_id)
        .single();
      message.recipient_email = profile?.email;
    }

    // Fetch replies in chronological order
    const { data: replies } = await supabaseAdmin
      .from('admin_messages')
      .select('id, body, sender_type, sender_email, created_at')
      .eq('parent_id', messageId)
      .order('created_at', { ascending: true });

    return res.json({ message, replies: replies || [] });

  } catch (err) {
    console.error('[Admin Messages] Get error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch message' });
  }
});

// ----------------------------------------------------------------
// POST /admin/messages/:id/reply
//
// Admin replies to a user's message.
// Automatically marks the original message as read.
// Body: { body: string }
// ----------------------------------------------------------------
router.post('/messages/:id/reply', async (req, res) => {
  const adminId  = req.user.id;
  const parentId = req.params.id;
  const { body } = req.body;

  if (!body?.trim()) return res.status(400).json({ error: 'Reply body is required' });

  try {
    const { data: parent, error: parentErr } = await supabaseAdmin
      .from('admin_messages')
      .select('id, subject, sender_id, sender_email')
      .eq('id', parentId)
      .single();

    if (parentErr || !parent) return res.status(404).json({ error: 'Message not found' });

    // Mark the original message as read since we're replying to it
    await supabaseAdmin
      .from('admin_messages')
      .update({ read_at: new Date().toISOString() })
      .eq('id', parentId)
      .is('read_at', null);

    const { data, error } = await supabaseAdmin
      .from('admin_messages')
      .insert({
        sender_type:  'admin',
        sender_id:    adminId,
        sender_email: req.user.email,
        recipient_id: parent.sender_id, // reply goes back to the user who messaged
        is_broadcast: false,
        subject:      `Re: ${parent.subject}`,
        body:         body.trim(),
        parent_id:    parentId
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    return res.status(201).json({ reply: data });

  } catch (err) {
    console.error('[Admin Messages] Reply error:', err.message);
    return res.status(500).json({ error: 'Failed to send reply' });
  }
});

// ----------------------------------------------------------------
// PUT /admin/messages/:id/read
//
// Mark a user message as read without replying.
// ----------------------------------------------------------------
router.put('/messages/:id/read', async (req, res) => {
  const messageId = req.params.id;

  try {
    const { error } = await supabaseAdmin
      .from('admin_messages')
      .update({ read_at: new Date().toISOString() })
      .eq('id', messageId)
      .is('read_at', null);

    if (error) throw new Error(error.message);
    return res.json({ ok: true });

  } catch (err) {
    console.error('[Admin Messages] Mark read error:', err.message);
    return res.status(500).json({ error: 'Failed to mark as read' });
  }
});

// ----------------------------------------------------------------
// DELETE /admin/messages/:id
//
// Delete a message. Replies are set to parent_id=null via FK ON DELETE SET NULL.
// ----------------------------------------------------------------
router.delete('/messages/:id', async (req, res) => {
  const messageId = req.params.id;

  try {
    const { error } = await supabaseAdmin
      .from('admin_messages')
      .delete()
      .eq('id', messageId);

    if (error) throw new Error(error.message);

    console.log(`[Admin Messages] Deleted ${messageId} by ${req.user.email}`);
    return res.json({ ok: true });

  } catch (err) {
    console.error('[Admin Messages] Delete error:', err.message);
    return res.status(500).json({ error: 'Failed to delete message' });
  }
});

// ================================================================
// TIER LIMITS MANAGEMENT
//
// Admin can view and edit the usage limits applied to each
// subscription tier. Changes take effect within seconds because
// the cache is busted immediately on every PUT.
// ================================================================

const { bustLimitsCache } = require('../middleware/checkLimit');

// ----------------------------------------------------------------
// GET /admin/tier-limits
//
// Returns all tier limit rows. The frontend groups them into a
// tier × feature grid for display.
// ----------------------------------------------------------------
router.get('/tier-limits', async (req, res) => {
  try {
    let { data, error } = await supabaseAdmin
      .from('tier_limits')
      .select('*')
      .order('tier')
      .order('feature');

    if (error) throw new Error(error.message);

    // Auto-seed default limits if the table is empty.
    // This makes the system self-healing — no manual SQL needed.
    if (!data || data.length === 0) {
      console.log('[Admin] tier_limits table empty — auto-seeding defaults...');
      const defaults = [];
      const tiers    = ['free_trial', 'starter', 'professional', 'enterprise'];
      const features = {
        briefs_per_month:       { values: [5, 30, 100, -1], label: 'Briefs per month' },
        ai_images_per_month:    { values: [3, 20, 60, -1],  label: 'AI images per month' },
        platforms_connected:    { values: [2, 4, 7, 7],      label: 'Platforms connected' },
        scheduled_queue_size:   { values: [5, 25, 100, -1],  label: 'Scheduled queue size' },
        comment_monitoring:     { values: [0, 1, 1, 1],      label: 'Comment monitoring' },
        dm_lead_capture:        { values: [0, 0, 1, 1],      label: 'DM lead capture' },
        intelligence_dashboard: { values: [0, 0, 1, 1],      label: 'Intelligence dashboard' },
        performance_predictor:  { values: [0, 0, 1, 1],      label: 'Performance predictor' },
        pain_point_miner:       { values: [0, 0, 1, 1],      label: 'Pain-point miner' },
        brand_voice_tracker:    { values: [0, 0, 1, 1],      label: 'Brand voice tracker' }
      };

      for (const [feature, config] of Object.entries(features)) {
        tiers.forEach((tier, i) => {
          defaults.push({
            tier,
            feature,
            limit_value: config.values[i],
            enabled: true,
            label: config.label
          });
        });
      }

      const { error: seedErr } = await supabaseAdmin
        .from('tier_limits')
        .upsert(defaults, { onConflict: 'tier,feature' });

      if (seedErr) {
        console.error('[Admin] Auto-seed failed:', seedErr.message, seedErr.details, seedErr.hint);
        // Return the error so the admin can see exactly what's wrong
        return res.json({ limits: [], seedError: seedErr.message });
      } else {
        console.log(`[Admin] Seeded ${defaults.length} tier limit rows`);
        // Re-fetch after seeding
        const refetch = await supabaseAdmin
          .from('tier_limits')
          .select('*')
          .order('tier')
          .order('feature');
        data = refetch.data || [];
      }
    }

    return res.json({ limits: data || [] });

  } catch (err) {
    console.error('[Admin] Tier limits fetch error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch tier limits' });
  }
});

// ----------------------------------------------------------------
// PUT /admin/tier-limits/:id
//
// Update a limit's value or enabled toggle.
// Body: { limit_value?: number, enabled?: boolean }
//
// Busts the Redis cache immediately so the new value is enforced
// on the very next request (no waiting for the 5-minute TTL).
// ----------------------------------------------------------------
router.put('/tier-limits/:id', async (req, res) => {
  const { id } = req.params;
  const { limit_value, enabled } = req.body;

  // Build the update object — only include fields that were sent
  const updates = { updated_at: new Date().toISOString() };
  if (limit_value !== undefined) updates.limit_value = Number(limit_value);
  if (enabled    !== undefined) updates.enabled      = Boolean(enabled);

  // Make sure there's actually something to update
  if (Object.keys(updates).length === 1) {
    return res.status(400).json({ error: 'Provide limit_value and/or enabled to update' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('tier_limits')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    if (!data)  return res.status(404).json({ error: 'Limit not found' });

    // Bust cache so the change takes effect on the next request
    await bustLimitsCache();

    console.log(`[Admin] Tier limit ${id} updated by ${req.user.email}: ${JSON.stringify(updates)}`);

    return res.json({ limit: data });

  } catch (err) {
    console.error('[Admin] Tier limit update error:', err.message);
    return res.status(500).json({ error: 'Failed to update tier limit' });
  }
});

// ----------------------------------------------------------------
// GET /admin/revenue
//
// Revenue dashboard data calculated from the subscriptions table
// and plan prices defined in environment variables.
//
// Plan prices come from .env so they can be updated without
// a code redeploy:
//   PLAN_PRICE_STARTER       (default 29)
//   PLAN_PRICE_PROFESSIONAL  (default 79)
//   PLAN_PRICE_ENTERPRISE    (default 199)
//
// Until Stripe is live, "MRR" is estimated from active subscription
// records × plan price — not confirmed charge data.  Stripe will
// provide verified charge history once connected.
//
// Billing note: 30-day rolling cycles (not calendar-monthly).
// ----------------------------------------------------------------
router.get('/revenue', async (req, res) => {
  try {
    // Pull plan prices from the plans table (admin-editable)
    // Falls back to env vars if the plans table doesn't exist yet
    const PRICES = { free_trial: 0, free: 0 };
    try {
      const { data: dbPlans } = await supabaseAdmin
        .from('plans')
        .select('tier, price_display')
        .eq('is_active', true);

      if (dbPlans && dbPlans.length > 0) {
        for (const p of dbPlans) {
          // Parse "$29" or "$199" → number
          const num = parseFloat((p.price_display || '0').replace(/[^0-9.]/g, ''));
          PRICES[p.tier] = isNaN(num) ? 0 : num;
        }
      } else {
        // Fallback to env vars
        PRICES.starter      = parseFloat(process.env.PLAN_PRICE_STARTER)      || 29;
        PRICES.professional = parseFloat(process.env.PLAN_PRICE_PROFESSIONAL)  || 79;
        PRICES.enterprise   = parseFloat(process.env.PLAN_PRICE_ENTERPRISE)    || 199;
      }
    } catch (_) {
      PRICES.starter      = parseFloat(process.env.PLAN_PRICE_STARTER)      || 29;
      PRICES.professional = parseFloat(process.env.PLAN_PRICE_PROFESSIONAL)  || 79;
      PRICES.enterprise   = parseFloat(process.env.PLAN_PRICE_ENTERPRISE)    || 199;
    }

    const now          = new Date();
    const thirtyAgo    = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // 1. Fetch all subscriptions so we can slice them however we need
    const { data: subs, error: subsError } = await supabaseAdmin
      .from('subscriptions')
      .select('user_id, plan, status, created_at, current_period_end');

    if (subsError) throw new Error(subsError.message);

    const allSubs = subs || [];

    // 2. Active paid subscribers per tier (status = 'active', plan is not free/free_trial)
    const FREE_PLANS = ['free', 'free_trial'];
    const activePaid = allSubs.filter(s => s.status === 'active' && !FREE_PLANS.includes(s.plan));

    // 3. Tier breakdown — count and MRR contribution per tier
    const tierBreakdown = {};
    for (const [tier, price] of Object.entries(PRICES)) {
      if (FREE_PLANS.includes(tier)) continue;
      const count = activePaid.filter(s => s.plan === tier).length;
      tierBreakdown[tier] = { count, price, mrr: count * price };
    }

    // 4. Top-level MRR / ARR / ARPU
    const mrr  = Object.values(tierBreakdown).reduce((sum, t) => sum + t.mrr, 0);
    const arr  = mrr * 12;
    const arpu = activePaid.length > 0 ? mrr / activePaid.length : 0;

    // 5. Free trial funnel
    const freeTrial = allSubs.filter(s => FREE_PLANS.includes(s.plan)).length;

    // 6. Churn rate — subscribers who cancelled in the last 30 days
    //    as a % of those who were active 30 days ago.
    //    We approximate "active 30 days ago" as all active + recently cancelled.
    const cancelledLast30 = allSubs.filter(
      s => s.status === 'cancelled' && s.current_period_end && s.current_period_end >= thirtyAgo
    ).length;
    const activeOrRecentlyCancelled = activePaid.length + cancelledLast30;
    const monthlyChurnRate = activeOrRecentlyCancelled > 0
      ? cancelledLast30 / activeOrRecentlyCancelled
      : 0;

    // 7. CLV = ARPU / monthly churn rate  (guard against divide-by-zero)
    const clv = monthlyChurnRate > 0 ? arpu / monthlyChurnRate : null;

    // 8. Free trial → paid conversion rate
    const totalSignups = allSubs.length;
    const everPaid     = allSubs.filter(s => !FREE_PLANS.includes(s.plan)).length;
    const conversionRate = totalSignups > 0 ? everPaid / totalSignups : 0;

    // 9. MRR projection for the next 6 months using simple churn decay:
    //    projected_mrr_month_n = mrr × (1 - churn_rate)^n
    //    We also add a rough new-customer estimate based on recent signup rate
    //    (new paid subs in last 30 days × avg plan price).
    const newPaidLast30 = allSubs.filter(
      s => !FREE_PLANS.includes(s.plan) && s.created_at >= thirtyAgo
    ).length;
    const estimatedNewMrrPerMonth = newPaidLast30 * arpu;

    const projections = [];
    let projectedMrr = mrr;
    for (let i = 1; i <= 6; i++) {
      // Decay existing MRR by churn, then add estimated new revenue
      projectedMrr = projectedMrr * (1 - monthlyChurnRate) + estimatedNewMrrPerMonth;
      const projDate = new Date(now);
      projDate.setMonth(projDate.getMonth() + i);
      projections.push({
        month: projDate.toLocaleString('en-US', { month: 'short', year: 'numeric' }),
        mrr:   Math.round(projectedMrr * 100) / 100
      });
    }

    // 10. Cumulative projected revenue for the remainder of the current year
    const monthsLeftInYear = 12 - now.getMonth(); // e.g. March = 2 left (April–Dec = 9... wait, months 0-indexed so March=2, months left = 12-3=9)
    const projectedYearRemainder = projections
      .slice(0, monthsLeftInYear)
      .reduce((sum, p) => sum + p.mrr, 0);

    return res.json({
      // Prices used for calculations (so frontend can display them)
      prices: PRICES,

      // Core metrics
      mrr,
      arr,
      arpu:             Math.round(arpu * 100) / 100,
      monthly_churn_rate: Math.round(monthlyChurnRate * 10000) / 100, // as %
      clv:              clv ? Math.round(clv * 100) / 100 : null,
      conversion_rate:  Math.round(conversionRate * 10000) / 100,     // as %

      // Subscriber counts
      total_subscribers:  totalSignups,
      active_paid:        activePaid.length,
      free_trial_count:   freeTrial,
      cancelled_last_30:  cancelledLast30,
      new_paid_last_30:   newPaidLast30,

      // Per-tier breakdown
      tier_breakdown: tierBreakdown,

      // Projections
      projections,
      projected_year_remainder: Math.round(projectedYearRemainder * 100) / 100,

      // Flag that this is estimated (not verified Stripe charge data)
      stripe_connected: !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_SECRET_KEY !== 'sk_test_placeholder')
    });

  } catch (err) {
    console.error('[Admin] Revenue error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch revenue data' });
  }
});

// ----------------------------------------------------------------
// GET /admin/plans
//
// Returns all plans (active + inactive) for the admin editor.
// ----------------------------------------------------------------
router.get('/plans', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('plans')
      .select('*')
      .order('sort_order');

    if (error) throw new Error(error.message);

    return res.json({ plans: data || [] });

  } catch (err) {
    console.error('[Admin] Plans fetch error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch plans' });
  }
});

// ----------------------------------------------------------------
// PUT /admin/plans/:id
//
// Update a plan's display info, features, Stripe price ID, etc.
// Body: any subset of { name, price_display, period_label,
//   stripe_price_id, features, color, badge, sort_order, is_active }
// ----------------------------------------------------------------
router.put('/plans/:id', async (req, res) => {
  const { id } = req.params;
  const allowed = [
    'name', 'price_display', 'period_label', 'stripe_price_id',
    'features', 'color', 'badge', 'sort_order', 'is_active'
  ];

  const updates = { updated_at: new Date().toISOString() };
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 1) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('plans')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    if (!data) return res.status(404).json({ error: 'Plan not found' });

    console.log(`[Admin] Plan ${data.tier} updated by ${req.user.email}`);

    return res.json({ plan: data });

  } catch (err) {
    console.error('[Admin] Plan update error:', err.message);
    return res.status(500).json({ error: 'Failed to update plan' });
  }
});

// ----------------------------------------------------------------
// GET /admin/rls-check
//
// Returns tables that have Row Level Security enabled but NO policy.
// These tables silently reject all writes — including from supabaseAdmin.
// This is a critical data loss risk. The check calls the check_rls_policies()
// Supabase RPC function (see migration_rls_health_check.sql).
// ----------------------------------------------------------------
router.get('/rls-check', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin.rpc('check_rls_policies');
    if (error) throw new Error(error.message);

    return res.json({
      tables: (data || []).map(t => t.table_name),
      count: (data || []).length,
      status: (data || []).length === 0 ? 'ok' : 'critical'
    });
  } catch (err) {
    // If the RPC function doesn't exist, tell the admin to run the migration
    return res.status(500).json({
      error: 'RLS check failed — the check_rls_policies() function may not exist yet. ' +
             'Run migration_rls_health_check.sql in Supabase SQL Editor first.',
      detail: err.message
    });
  }
});

// ----------------------------------------------------------------
// POST /admin/rls-fix
//
// Creates a standard RLS policy for a table that has RLS enabled
// but no policy. The policy allows users to read/write their own rows
// using the standard pattern: user_id = auth.uid()
//
// Body: { table: "table_name" }
//
// SAFETY: Only creates a policy — never disables RLS or drops anything.
// The table name is validated to be alphanumeric + underscores only.
// ----------------------------------------------------------------
router.post('/rls-fix', async (req, res) => {
  try {
    const tableName = (req.body.table || '').trim();

    // Validate table name — only alphanumeric + underscores to prevent SQL injection
    if (!tableName || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tableName)) {
      return res.status(400).json({ error: 'Invalid table name. Only letters, numbers, and underscores allowed.' });
    }

    // Verify this table actually has RLS enabled and no policy (don't blindly create policies)
    const { data: rlsCheck } = await supabaseAdmin.rpc('check_rls_policies');
    const needsFix = (rlsCheck || []).some(t => t.table_name === tableName);
    if (!needsFix) {
      return res.status(400).json({
        error: `Table "${tableName}" either doesn't exist, doesn't have RLS enabled, or already has a policy.`
      });
    }

    // Create the standard user_id = auth.uid() policy
    // This is the same pattern used on every other table in the project.
    const policyName = `Users can manage own ${tableName}`;
    const sql = `
      CREATE POLICY "${policyName}"
      ON ${tableName}
      FOR ALL
      USING (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
    `;

    const { error: sqlError } = await supabaseAdmin.rpc('exec_sql', { sql });

    // If the exec_sql RPC doesn't exist, tell the admin to run it manually
    if (sqlError) {
      // Return the SQL so the admin can run it manually in Supabase SQL Editor
      return res.status(200).json({
        fixed: false,
        message: `Auto-fix not available (exec_sql RPC not installed). Run this SQL manually in Supabase SQL Editor:`,
        sql: sql.trim(),
        table: tableName
      });
    }

    console.log(`[Admin] RLS policy created for "${tableName}" by ${req.user.email}`);

    return res.json({
      fixed: true,
      message: `RLS policy created for "${tableName}". Writes should now work.`,
      table: tableName,
      policy: policyName
    });

  } catch (err) {
    console.error('[Admin] RLS fix error:', err.message);
    return res.status(500).json({ error: `Failed to fix RLS: ${err.message}` });
  }
});

module.exports = router;

