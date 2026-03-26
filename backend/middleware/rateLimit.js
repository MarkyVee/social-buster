/**
 * middleware/rateLimit.js
 *
 * Rate limiting middleware using Redis.
 * Protects expensive operations and prevents abuse.
 *
 * Pre-built limiters exported from this file:
 *   standardLimiter  - General API routes (120 req/min per user)
 *   aiLimiter        - AI generation routes (10 req/hour per user)
 *   videoLimiter     - FFmpeg processing routes (20 req/hour per user)
 *   authLimiter      - Auth routes by IP (20 req/min per IP)
 */

const { getRedisClient } = require('../services/redisService');

// ----------------------------------------------------------------
// In-memory fallback rate limiter — used when Redis is unavailable.
// This is NOT a replacement for Redis — it's a safety net that prevents
// brute-force attacks during brief Redis outages. It uses a simple
// Map with per-key counters and auto-expires entries after the window.
// At 5,000 users this Map might hold ~5,000 entries (one per user) —
// that's ~500 KB of memory, completely safe.
// ----------------------------------------------------------------
const memoryFallback = new Map();
const MEMORY_CLEANUP_INTERVAL = 60_000; // Clean expired entries every 60s

// Periodic cleanup of expired in-memory entries
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of memoryFallback) {
    if (now > entry.expiresAt) memoryFallback.delete(key);
  }
}, MEMORY_CLEANUP_INTERVAL).unref(); // .unref() prevents this from keeping Node alive

function checkMemoryRateLimit(key, limit, windowSec) {
  const now = Date.now();
  const entry = memoryFallback.get(key);

  if (!entry || now > entry.expiresAt) {
    // New window — start counting
    memoryFallback.set(key, { count: 1, expiresAt: now + windowSec * 1000 });
    return { allowed: true };
  }

  entry.count++;
  if (entry.count > limit) {
    const retryAfter = Math.ceil((entry.expiresAt - now) / 1000);
    return { allowed: false, retryAfter };
  }

  return { allowed: true };
}

// ----------------------------------------------------------------
// Core rate limit checker.
// key      - Redis key to increment (e.g. "rl:user:uuid:standard")
// limit    - Maximum allowed requests in the window
// windowSec- Window size in seconds
// ----------------------------------------------------------------
async function checkRateLimit(key, limit, windowSec) {
  const redis = getRedisClient();

  // Increment the counter for this key
  const current = await redis.incr(key);

  if (current === 1) {
    // First request in this window — set expiry so the key auto-cleans
    await redis.expire(key, windowSec);
  }

  if (current > limit) {
    // Get remaining TTL so we can tell the client when to retry
    const ttl = await redis.ttl(key);
    return { allowed: false, retryAfter: ttl };
  }

  return { allowed: true };
}

// ----------------------------------------------------------------
// Factory: creates an Express middleware function for a given tier.
// identifier - function(req) that returns the unique key for this req
//              (e.g. user ID for authenticated routes, IP for auth routes)
// ----------------------------------------------------------------
function createLimiter({ limit, windowSec, tier, getIdentifier }) {
  return async function rateLimitMiddleware(req, res, next) {
    try {
      const id = getIdentifier(req);

      // If we can't identify the requester, allow the request through
      // (avoids blocking legitimate users when Redis is unavailable)
      if (!id) return next();

      const key = `rl:${tier}:${id}`;
      const result = await checkRateLimit(key, limit, windowSec);

      if (!result.allowed) {
        const minutes = Math.ceil(result.retryAfter / 60);
        const when = minutes <= 1 ? 'in about a minute' : `in ${minutes} minutes`;
        return res.status(429).json({
          error: tier === 'ai'
            ? `You've reached the generation limit for this period. Please try again ${when}.`
            : `You've made too many requests. Please wait ${when} before trying again.`,
          retryAfter: result.retryAfter
        });
      }

      next();

    } catch (err) {
      // Redis is down — fall back to in-memory rate limiting.
      // This prevents brute-force attacks during Redis outages while
      // still allowing legitimate users through. The in-memory limiter
      // is per-process (not shared across containers), so limits are
      // slightly less accurate, but it's far better than no limiting.
      console.error('[RateLimit] Redis error — using in-memory fallback:', err.message);

      const id = getIdentifier(req);
      if (!id) return next();

      const key = `rl:${tier}:${id}`;
      const result = checkMemoryRateLimit(key, limit, windowSec);

      if (!result.allowed) {
        return res.status(429).json({
          error: 'Too many requests. Please wait before trying again.',
          retryAfter: result.retryAfter
        });
      }

      res.set('X-RateLimit-Fallback', 'true');
      next();
    }
  };
}

// ----------------------------------------------------------------
// Get real IP address (handles proxies and load balancers)
// ----------------------------------------------------------------
function getIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

// ----------------------------------------------------------------
// Exported rate limiters — apply these directly to routes
// ----------------------------------------------------------------

// General API: 120 requests per minute per authenticated user
const standardLimiter = createLimiter({
  limit: 120,
  windowSec: 60,
  tier: 'standard',
  getIdentifier: (req) => req.user?.id || getIp(req)
});

// AI generation: configurable per environment.
// Default: 50/hour in development (for testing), 20/hour in production.
// Override with AI_RATE_LIMIT in .env.
const aiLimiter = createLimiter({
  limit: parseInt(process.env.AI_RATE_LIMIT || (process.env.NODE_ENV === 'production' ? '20' : '50'), 10),
  windowSec: 3600,
  tier: 'ai',
  getIdentifier: (req) => req.user?.id
});

// Video processing: 20 per hour per authenticated user
const videoLimiter = createLimiter({
  limit: 20,
  windowSec: 3600,
  tier: 'video',
  getIdentifier: (req) => req.user?.id
});

// Auth routes: 20 per minute by IP (no user yet — they're not logged in)
// Prevents brute force login/registration attempts
const authLimiter = createLimiter({
  limit: 20,
  windowSec: 60,
  tier: 'auth',
  getIdentifier: (req) => getIp(req)
});

module.exports = { standardLimiter, aiLimiter, videoLimiter, authLimiter };
