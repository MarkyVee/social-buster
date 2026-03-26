/**
 * agents/watchdogAgent.js
 *
 * System Watchdog — runs every 5 minutes via BullMQ to monitor platform health.
 *
 * What it does:
 *   1. Tracks API call rates per user+platform (detects infinite loops)
 *   2. Monitors job execution times (detects slowdowns)
 *   3. Tracks error frequency trends (detects degradation)
 *   4. Watches queue depths over time (detects stuck queues)
 *   5. Checks worker liveness (detects dead workers)
 *   6. Computes a 0-100 health confidence score
 *   7. Auto-pauses the system when confidence drops below threshold
 *   8. Stores diagnostic events in system_events table
 *   9. Sends email alerts on status changes
 *
 * The confidence score is a weighted composite:
 *   - Redis health:       15 points
 *   - Queue flow:         20 points (are jobs being processed?)
 *   - Error rate:         20 points (% of jobs failing)
 *   - API rate anomalies: 15 points (no runaway loops)
 *   - Worker liveness:    15 points (all workers alive)
 *   - DB connectivity:    15 points
 *
 * Auto-pause triggers when confidence < 30 for 2 consecutive checks.
 */

const { supabaseAdmin } = require('../services/supabaseService');
const { getRedisClient } = require('../services/redisService');
const { sendAlert }      = require('../services/alertService');

// Auto-pause threshold — if score stays below this for 2 checks, pause the system
const PAUSE_THRESHOLD = 30;
// Track consecutive low scores in memory (resets on restart — intentional)
let _consecutiveLowScores = 0;
let _lastWatchdogStatus = 'healthy'; // healthy | degraded | critical | paused

// ================================================================
// runWatchdogCycle — main entry point, called by watchdogWorker.js
// ================================================================
async function runWatchdogCycle() {
  console.log('[Watchdog] Starting watchdog cycle...');

  const results = {
    redis:    { score: 15, issues: [] },
    queues:   { score: 20, issues: [] },
    errors:   { score: 20, issues: [] },
    apiRate:  { score: 15, issues: [] },
    workers:  { score: 15, issues: [] },
    database: { score: 15, issues: [] }
  };

  const anomalies = [];

  try {
    // ---- 1. Redis health ----
    await checkRedis(results.redis);

    // ---- 2. Queue flow + backlog detection ----
    await checkQueues(results.queues, anomalies);

    // ---- 3. Error rate trends ----
    await checkErrorRates(results.errors, anomalies);

    // ---- 4. API call rate anomalies (loop detection) ----
    await checkApiRates(results.apiRate, anomalies);

    // ---- 5. Worker liveness ----
    await checkWorkers(results.workers, anomalies);

    // ---- 6. Database connectivity ----
    await checkDatabase(results.database);

  } catch (err) {
    console.error('[Watchdog] Unexpected error in checks:', err.message);
  }

  // ---- Compute confidence score ----
  const confidence = Object.values(results).reduce((sum, r) => sum + r.score, 0);
  const status = confidence >= 80 ? 'healthy'
               : confidence >= 50 ? 'degraded'
               : 'critical';

  console.log(`[Watchdog] Confidence: ${confidence}/100 — Status: ${status}`);

  // ---- Store health snapshot ----
  await logEvent('health_snapshot', status === 'healthy' ? 'info' : status === 'degraded' ? 'warning' : 'critical', 'system', `Health score: ${confidence}/100 — ${status}`, {
    confidence,
    status,
    breakdown: {
      redis:    results.redis.score,
      queues:   results.queues.score,
      errors:   results.errors.score,
      apiRate:  results.apiRate.score,
      workers:  results.workers.score,
      database: results.database.score
    },
    issues: Object.values(results).flatMap(r => r.issues)
  }, confidence);

  // ---- Store anomalies ----
  for (const anomaly of anomalies) {
    await logEvent('anomaly', anomaly.severity, anomaly.category, anomaly.title, anomaly.details, confidence);
  }

  // ---- Auto-pause logic ----
  if (confidence < PAUSE_THRESHOLD) {
    _consecutiveLowScores++;
    if (_consecutiveLowScores >= 2) {
      await autoPause(`Confidence score ${confidence}/100 for ${_consecutiveLowScores} consecutive checks`);
    }
  } else {
    // If we were paused and score recovered, auto-resume
    if (_consecutiveLowScores >= 2) {
      const pauseState = await getSystemPauseState();
      if (pauseState?.paused && pauseState?.paused_by === 'watchdog') {
        await autoResume(`Confidence score recovered to ${confidence}/100`);
      }
    }
    _consecutiveLowScores = 0;
  }

  // ---- Email alert on status change ----
  if (status !== _lastWatchdogStatus) {
    if (status === 'critical' && _lastWatchdogStatus !== 'critical') {
      const allIssues = Object.values(results).flatMap(r => r.issues);
      await sendAlert(
        `🚨 CRITICAL — System confidence dropped to ${confidence}/100`,
        [
          `Watchdog status changed: ${_lastWatchdogStatus} → ${status}`,
          `Confidence score: ${confidence}/100`,
          '',
          'Issues:',
          ...allIssues.map(i => `  • ${i}`),
          '',
          anomalies.length > 0 ? 'Anomalies detected:' : '',
          ...anomalies.map(a => `  ⚠ ${a.title}`)
        ].join('\n')
      );
    } else if (status === 'degraded' && _lastWatchdogStatus === 'healthy') {
      await sendAlert(
        `⚠️ DEGRADED — System confidence at ${confidence}/100`,
        `Watchdog status changed: healthy → degraded\nConfidence: ${confidence}/100\n\nIssues:\n${Object.values(results).flatMap(r => r.issues).map(i => `  • ${i}`).join('\n')}`
      );
    } else if (status === 'healthy' && _lastWatchdogStatus !== 'healthy') {
      await sendAlert(
        `✅ RECOVERED — System confidence back to ${confidence}/100`,
        'All watchdog checks are passing. System is healthy.'
      );
    }
    _lastWatchdogStatus = status;
  }

  // ---- Periodic cleanup (every cycle, cheap operation) ----
  await cleanupOldEvents();

  console.log('[Watchdog] Cycle complete.');
  return { confidence, status, anomalies: anomalies.length };
}

// ================================================================
// CHECK FUNCTIONS
// Each receives its result object and deducts points for issues.
// ================================================================

// ---- Redis ----
async function checkRedis(result) {
  try {
    const redis = getRedisClient();
    const start = Date.now();
    await redis.ping();
    const latency = Date.now() - start;

    if (latency > 1000) {
      result.score -= 5;
      result.issues.push(`Redis latency high: ${latency}ms`);
    }
    if (latency > 3000) {
      result.score -= 10;
      result.issues.push(`Redis latency critical: ${latency}ms`);
    }
  } catch (err) {
    result.score = 0;
    result.issues.push(`Redis unreachable: ${err.message}`);
  }
}

// ---- Queue flow + backlog ----
async function checkQueues(result, anomalies) {
  const {
    publishQueue, commentQueue, mediaScanQueue,
    performanceQueue, researchQueue, mediaAnalysisQueue,
    dmQueue, emailQueue
  } = require('../queues');

  const queues = {
    publish: publishQueue, comment: commentQueue,
    'media-scan': mediaScanQueue, performance: performanceQueue,
    research: researchQueue, 'media-analysis': mediaAnalysisQueue,
    dm: dmQueue, email: emailQueue
  };

  // Track queue depths over time in Redis for trend detection
  const redis = getRedisClient();

  for (const [name, q] of Object.entries(queues)) {
    try {
      const [waiting, active, failed] = await Promise.all([
        q.getWaitingCount(), q.getActiveCount(), q.getFailedCount()
      ]);

      // Store current depth for trend analysis (keep last 12 readings = 1 hour at 5-min intervals)
      const depthKey = `watchdog:queue_depth:${name}`;
      try {
        await redis.lpush(depthKey, JSON.stringify({ waiting, active, failed, ts: Date.now() }));
        await redis.ltrim(depthKey, 0, 11);
      } catch { /* Redis failure non-fatal */ }

      // Check for growing backlog (3 consecutive readings with increasing waiting count)
      try {
        const history = await redis.lrange(depthKey, 0, 2);
        if (history.length >= 3) {
          const readings = history.map(h => JSON.parse(h));
          const growing = readings[0].waiting > readings[1].waiting && readings[1].waiting > readings[2].waiting;
          if (growing && readings[0].waiting > 10) {
            result.score -= 5;
            result.issues.push(`Queue "${name}" backlog growing: ${readings[2].waiting} → ${readings[1].waiting} → ${readings[0].waiting}`);
            anomalies.push({
              severity: 'warning', category: 'queue_backlog',
              title: `Queue "${name}" backlog growing for 3 consecutive checks`,
              details: { queue: name, readings: readings.map(r => r.waiting) }
            });
          }
        }
      } catch { /* trend check non-fatal */ }

      // High waiting count (absolute threshold)
      if (waiting > 100) {
        result.score -= 5;
        result.issues.push(`Queue "${name}" has ${waiting} waiting jobs`);
      }

      // Failed jobs still present
      if (failed > 10) {
        result.score -= 3;
        result.issues.push(`Queue "${name}" has ${failed} failed jobs`);
      }

    } catch (err) {
      result.score -= 3;
      result.issues.push(`Queue "${name}" unreachable: ${err.message}`);
    }
  }

  // Ensure score doesn't go negative
  result.score = Math.max(0, result.score);
}

// ---- Error rate trends ----
async function checkErrorRates(result, anomalies) {
  const redis = getRedisClient();

  try {
    // Track errors per 5-min window using Redis counters
    const window = Math.floor(Date.now() / (5 * 60 * 1000));
    const errorKey = `watchdog:errors:${window}`;
    const prevKey  = `watchdog:errors:${window - 1}`;

    const [currentErrors, prevErrors] = await Promise.all([
      redis.get(errorKey).then(v => parseInt(v || '0', 10)),
      redis.get(prevKey).then(v => parseInt(v || '0', 10))
    ]);

    // Spike detection: current window has 3x more errors than previous
    if (currentErrors > 5 && prevErrors > 0 && currentErrors > prevErrors * 3) {
      result.score -= 10;
      result.issues.push(`Error spike: ${currentErrors} errors this window vs ${prevErrors} previous`);
      anomalies.push({
        severity: 'critical', category: 'job_failure',
        title: `Error rate spiked 3x: ${prevErrors} → ${currentErrors} in 5 minutes`,
        details: { current: currentErrors, previous: prevErrors }
      });
    } else if (currentErrors > 20) {
      result.score -= 5;
      result.issues.push(`High error count: ${currentErrors} errors in current window`);
    }

  } catch (err) {
    // Can't check errors — non-fatal, just lose visibility
    result.issues.push(`Error rate check failed: ${err.message}`);
  }

  result.score = Math.max(0, result.score);
}

// ---- API call rate anomalies (loop detection) ----
async function checkApiRates(result, anomalies) {
  const redis = getRedisClient();

  try {
    // Scan for platform_daily:* keys (set by platformAPIs.js rate limiter)
    const keys = await redis.keys('platform_daily:*');

    for (const key of keys) {
      const count = parseInt(await redis.get(key) || '0', 10);
      // Extract userId and platform from key format: platform_daily:{userId}:{platform}
      const parts = key.replace('platform_daily:', '').split(':');
      const platform = parts.pop();
      const userId = parts.join(':');

      // Thresholds for loop detection
      const LOOP_THRESHOLD = {
        facebook: 150, instagram: 40, tiktok: 40,
        default: 80
      };
      const threshold = LOOP_THRESHOLD[platform] || LOOP_THRESHOLD.default;

      if (count > threshold) {
        result.score -= 8;
        result.issues.push(`Possible API loop: ${platform} has ${count} calls for user ${userId.substring(0, 8)}…`);
        anomalies.push({
          severity: 'critical', category: 'api_rate',
          title: `High API call rate: ${count} ${platform} calls for user ${userId.substring(0, 8)}…`,
          details: { userId, platform, count, threshold }
        });
      } else if (count > threshold * 0.7) {
        result.score -= 3;
        result.issues.push(`API rate warning: ${platform} at ${count}/${threshold} for user ${userId.substring(0, 8)}…`);
        anomalies.push({
          severity: 'warning', category: 'api_rate',
          title: `API rate approaching limit: ${count}/${threshold} ${platform} calls`,
          details: { userId, platform, count, threshold }
        });
      }
    }
  } catch (err) {
    result.issues.push(`API rate check failed: ${err.message}`);
  }

  result.score = Math.max(0, result.score);
}

// ---- Worker liveness ----
async function checkWorkers(result, anomalies) {
  const {
    publishQueue, commentQueue, mediaScanQueue,
    performanceQueue, researchQueue, mediaAnalysisQueue,
    dmQueue, emailQueue
  } = require('../queues');

  const queues = {
    publish: publishQueue, comment: commentQueue,
    'media-scan': mediaScanQueue, performance: performanceQueue,
    research: researchQueue, 'media-analysis': mediaAnalysisQueue,
    dm: dmQueue, email: emailQueue
  };

  let deadCount = 0;

  for (const [name, q] of Object.entries(queues)) {
    try {
      const workers = await q.getWorkers();
      if (!workers || workers.length === 0) {
        deadCount++;
        result.issues.push(`Worker DEAD: "${name}" has no active listeners`);
        anomalies.push({
          severity: 'critical', category: 'worker_dead',
          title: `Worker "${name}" is not running — jobs will queue up and never process`,
          details: { queue: name, workers: 0 }
        });
      }
    } catch (err) {
      result.issues.push(`Worker check failed for "${name}": ${err.message}`);
    }
  }

  // Deduct points proportionally: 1 dead = -5, 2 = -10, 3+ = all 15
  result.score -= Math.min(15, deadCount * 5);
  result.score = Math.max(0, result.score);
}

// ---- Database ----
async function checkDatabase(result) {
  try {
    const start = Date.now();
    const { error } = await supabaseAdmin
      .from('user_profiles')
      .select('user_id', { count: 'exact', head: true });
    const latency = Date.now() - start;

    if (error) {
      result.score = 0;
      result.issues.push(`Database error: ${error.message}`);
    } else if (latency > 3000) {
      result.score -= 10;
      result.issues.push(`Database latency critical: ${latency}ms`);
    } else if (latency > 1000) {
      result.score -= 5;
      result.issues.push(`Database latency high: ${latency}ms`);
    }
  } catch (err) {
    result.score = 0;
    result.issues.push(`Database unreachable: ${err.message}`);
  }
}

// ================================================================
// AUTO-PAUSE / AUTO-RESUME
// ================================================================

async function autoPause(reason) {
  console.error(`[Watchdog] AUTO-PAUSING SYSTEM: ${reason}`);

  try {
    await supabaseAdmin.from('system_state').upsert({
      key: 'pause',
      value: { paused: true, reason, paused_at: new Date().toISOString(), paused_by: 'watchdog' },
      updated_at: new Date().toISOString()
    });

    await logEvent('auto_pause', 'critical', 'system',
      `System auto-paused: ${reason}`,
      { reason, paused_by: 'watchdog' }, null);

    // Pause all queues
    const {
      publishQueue, commentQueue, mediaScanQueue,
      performanceQueue, researchQueue, dmQueue
    } = require('../queues');

    await Promise.all([
      publishQueue.pause(), commentQueue.pause(),
      mediaScanQueue.pause(), performanceQueue.pause(),
      researchQueue.pause(), dmQueue.pause()
    ]);

    await sendAlert(
      '🛑 SYSTEM AUTO-PAUSED — Confidence below threshold',
      `The watchdog has automatically paused all job queues.\n\nReason: ${reason}\n\nAll publishing, comment scanning, DM sending, and background jobs are paused.\nReview the Watchdog tab in the admin dashboard and click "Resume System" when ready.`
    );

    _lastWatchdogStatus = 'paused';

  } catch (err) {
    console.error('[Watchdog] Failed to auto-pause:', err.message);
  }
}

async function autoResume(reason) {
  console.log(`[Watchdog] AUTO-RESUMING SYSTEM: ${reason}`);

  try {
    await supabaseAdmin.from('system_state').upsert({
      key: 'pause',
      value: { paused: false, reason: null, paused_at: null, paused_by: null },
      updated_at: new Date().toISOString()
    });

    await logEvent('auto_resume', 'info', 'system',
      `System auto-resumed: ${reason}`,
      { reason }, null);

    const {
      publishQueue, commentQueue, mediaScanQueue,
      performanceQueue, researchQueue, dmQueue
    } = require('../queues');

    await Promise.all([
      publishQueue.resume(), commentQueue.resume(),
      mediaScanQueue.resume(), performanceQueue.resume(),
      researchQueue.resume(), dmQueue.resume()
    ]);

    await sendAlert(
      '✅ SYSTEM AUTO-RESUMED — Health recovered',
      `The watchdog detected health recovery and resumed all queues.\n\nReason: ${reason}`
    );

  } catch (err) {
    console.error('[Watchdog] Failed to auto-resume:', err.message);
  }
}

// ================================================================
// SYSTEM STATE HELPERS
// ================================================================

async function getSystemPauseState() {
  try {
    const { data } = await supabaseAdmin
      .from('system_state')
      .select('value')
      .eq('key', 'pause')
      .single();
    return data?.value || { paused: false };
  } catch {
    return { paused: false };
  }
}

// ================================================================
// EVENT LOGGING
// ================================================================

async function logEvent(eventType, severity, category, title, details = {}, confidence = null) {
  try {
    await supabaseAdmin.from('system_events').insert({
      event_type: eventType,
      severity,
      category,
      title,
      details,
      confidence
    });
  } catch (err) {
    console.error(`[Watchdog] Failed to log event: ${err.message}`);
  }
}

// Increment error counter (called by workers on job failure)
async function incrementErrorCount() {
  try {
    const redis = getRedisClient();
    const window = Math.floor(Date.now() / (5 * 60 * 1000));
    const key = `watchdog:errors:${window}`;
    await redis.incr(key);
    await redis.expire(key, 600); // Keep for 10 minutes (2 windows)
  } catch { /* non-fatal */ }
}

// Track job execution time (called by workers on job completion)
async function trackJobDuration(queueName, durationMs) {
  try {
    const redis = getRedisClient();
    const key = `watchdog:job_duration:${queueName}`;
    // Store last 50 durations for rolling average
    await redis.lpush(key, durationMs.toString());
    await redis.ltrim(key, 0, 49);
    await redis.expire(key, 7200); // 2 hours
  } catch { /* non-fatal */ }
}

// Get recent events for the admin dashboard
async function getRecentEvents(limit = 50, filters = {}) {
  try {
    let query = supabaseAdmin
      .from('system_events')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (filters.severity) query = query.eq('severity', filters.severity);
    if (filters.event_type) query = query.eq('event_type', filters.event_type);
    if (filters.resolved === false) query = query.eq('resolved', false);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error('[Watchdog] Failed to fetch events:', err.message);
    return [];
  }
}

// Get the latest health snapshot
async function getLatestSnapshot() {
  try {
    const { data } = await supabaseAdmin
      .from('system_events')
      .select('*')
      .eq('event_type', 'health_snapshot')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    return data;
  } catch {
    return null;
  }
}

// Get health score trend (last 24 hours of snapshots)
async function getScoreTrend(hours = 24) {
  try {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const { data } = await supabaseAdmin
      .from('system_events')
      .select('confidence, created_at')
      .eq('event_type', 'health_snapshot')
      .gte('created_at', cutoff)
      .order('created_at', { ascending: true });
    return data || [];
  } catch {
    return [];
  }
}

// Get job duration stats per queue
async function getJobDurationStats() {
  const redis = getRedisClient();
  const stats = {};
  const queueNames = ['publish', 'comment', 'media-scan', 'performance', 'research', 'media-analysis', 'dm', 'email'];

  for (const name of queueNames) {
    try {
      const key = `watchdog:job_duration:${name}`;
      const durations = await redis.lrange(key, 0, 49);
      if (durations.length === 0) {
        stats[name] = { avg: 0, max: 0, min: 0, count: 0 };
        continue;
      }
      const nums = durations.map(d => parseInt(d, 10));
      stats[name] = {
        avg: Math.round(nums.reduce((a, b) => a + b, 0) / nums.length),
        max: Math.max(...nums),
        min: Math.min(...nums),
        count: nums.length
      };
    } catch {
      stats[name] = { avg: 0, max: 0, min: 0, count: 0 };
    }
  }

  return stats;
}

// Cleanup events older than 90 days
async function cleanupOldEvents() {
  try {
    await supabaseAdmin.rpc('cleanup_old_system_events');
  } catch { /* RPC may not exist yet — non-fatal */ }
}

module.exports = {
  runWatchdogCycle,
  incrementErrorCount,
  trackJobDuration,
  getRecentEvents,
  getLatestSnapshot,
  getScoreTrend,
  getJobDurationStats,
  getSystemPauseState
};
