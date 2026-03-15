/**
 * services/redisService.js
 *
 * Redis connection management. All other services import getRedisClient()
 * to get the single shared Redis connection — we never create multiple connections.
 *
 * Usage in other files:
 *   const { getRedisClient } = require('./redisService');
 *   const redis = getRedisClient();
 *   await redis.set('key', 'value', 'EX', 3600);
 */

const Redis = require('ioredis');

let client = null;

// ----------------------------------------------------------------
// Connect to Redis. Called once at server startup.
// Subsequent calls return the existing connection.
// ----------------------------------------------------------------
function connectRedis() {
  if (client) return client;

  client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    // Retry strategy: wait longer between each failed reconnect attempt
    retryStrategy(times) {
      if (times > 10) {
        console.error('[Redis] Too many retry attempts. Giving up.');
        return null; // Stop retrying
      }
      return Math.min(times * 200, 2000); // Wait up to 2 seconds between retries
    },
    // Don't crash the app if Redis goes down — log and continue
    enableOfflineQueue: false,
    lazyConnect: false
  });

  client.on('connect', () => {
    console.log('[Redis] Connected successfully');
  });

  client.on('error', (err) => {
    console.error('[Redis] Connection error:', err.message);
    // We don't throw here — Redis errors are handled gracefully
    // in each service that uses Redis (with fallbacks where needed)
  });

  client.on('reconnecting', () => {
    console.log('[Redis] Reconnecting...');
  });

  return client;
}

// ----------------------------------------------------------------
// Get the Redis client. Throws if connect() was never called.
// ----------------------------------------------------------------
function getRedisClient() {
  if (!client) {
    // Auto-connect if not already connected
    return connectRedis();
  }
  return client;
}

// ----------------------------------------------------------------
// Cache helpers — simple get/set with JSON serialization
// ----------------------------------------------------------------

// Set a value in Redis with an expiry time in seconds
async function cacheSet(key, value, ttlSeconds = 3600) {
  try {
    const redis = getRedisClient();
    await redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    // Log but don't throw — cache failures should never break user requests
    console.error(`[Redis] cacheSet failed for key ${key}:`, err.message);
  }
}

// Get a value from Redis. Returns null if missing or on error.
async function cacheGet(key) {
  try {
    const redis = getRedisClient();
    const value = await redis.get(key);
    return value ? JSON.parse(value) : null;
  } catch (err) {
    console.error(`[Redis] cacheGet failed for key ${key}:`, err.message);
    return null; // Fallback: treat as cache miss
  }
}

// Delete a key from Redis
async function cacheDel(key) {
  try {
    const redis = getRedisClient();
    await redis.del(key);
  } catch (err) {
    console.error(`[Redis] cacheDel failed for key ${key}:`, err.message);
  }
}

module.exports = { connectRedis, getRedisClient, cacheSet, cacheGet, cacheDel };
