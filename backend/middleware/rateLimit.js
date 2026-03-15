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
      // If Redis is down, log the error but don't block the user.
      // It's better to allow a request than to break the platform.
      console.error('[RateLimit] Redis error, allowing request:', err.message);
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
