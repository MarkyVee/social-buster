/**
 * middleware/checkLimit.js
 *
 * Usage enforcement middleware. Checks whether a user has reached their
 * tier's limit for a given feature before allowing an action.
 *
 * Usage:
 *   const { checkLimit } = require('../middleware/checkLimit');
 *   router.post('/briefs', requireAuth, checkLimit('briefs_per_month'), handler);
 *
 * Limit values:
 *   -1  = unlimited (always allowed)
 *    0  = blocked entirely
 *    N  = max N (per month for time-based features, total for others)
 *
 * If the limit check itself errors (e.g. DB down), the request is allowed
 * through — we never block users due to our own infrastructure failures.
 */

const { supabaseAdmin } = require('../services/supabaseService');
const { cacheGet, cacheSet, cacheDel } = require('../services/redisService');

// How long to cache the full tier_limits table in Redis (5 minutes).
// Admin edits bust this cache immediately via cacheDel().
const LIMITS_CACHE_TTL = 300;
const LIMITS_CACHE_KEY = 'tier_limits_all';

// ----------------------------------------------------------------
// getAllLimits — returns all rows from tier_limits.
// Cached in Redis; falls back to DB on cache miss.
// ----------------------------------------------------------------
async function getAllLimits() {
  const cached = await cacheGet(LIMITS_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (_) {}
  }

  const { data, error } = await supabaseAdmin
    .from('tier_limits')
    .select('*');

  if (error) throw new Error(`Failed to load tier limits: ${error.message}`);

  const limits = data || [];
  await cacheSet(LIMITS_CACHE_KEY, JSON.stringify(limits), LIMITS_CACHE_TTL);
  return limits;
}

// ----------------------------------------------------------------
// getLimitForFeature — find one limit row for a tier + feature.
// ----------------------------------------------------------------
async function getLimitForFeature(tier, feature) {
  const all = await getAllLimits();
  return all.find(l => l.tier === tier && l.feature === feature) || null;
}

// ----------------------------------------------------------------
// bustLimitsCache — called by admin PUT /tier-limits/:id so changes
// take effect on the very next request (no waiting for TTL).
// ----------------------------------------------------------------
async function bustLimitsCache() {
  await cacheDel(LIMITS_CACHE_KEY);
}

// ----------------------------------------------------------------
// countUsage — count how many times the user has used a feature.
// Time-based features are counted within the current calendar month.
// Absolute features (platforms, queue size) are counted in total.
// ----------------------------------------------------------------
async function countUsage(userId, feature) {
  // Start of the current calendar month (UTC)
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  switch (feature) {

    case 'briefs_per_month': {
      // Each submitted brief = one AI generation
      const { count, error } = await supabaseAdmin
        .from('briefs')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .gte('created_at', monthStart);
      if (error) throw new Error(error.message);
      return count || 0;
    }

    case 'ai_images_per_month': {
      // Posts that have an AI-generated image attached
      const { count, error } = await supabaseAdmin
        .from('posts')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .not('ai_image_url', 'is', null)
        .gte('created_at', monthStart);
      if (error) throw new Error(error.message);
      return count || 0;
    }

    case 'platforms_connected': {
      // Total connected platforms right now (not time-based)
      const { count, error } = await supabaseAdmin
        .from('platform_connections')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId);
      if (error) throw new Error(error.message);
      return count || 0;
    }

    case 'scheduled_queue_size': {
      // Posts currently sitting in the active queue
      const { count, error } = await supabaseAdmin
        .from('posts')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', userId)
        .in('status', ['approved', 'scheduled']);
      if (error) throw new Error(error.message);
      return count || 0;
    }

    default:
      return 0;
  }
}

// ----------------------------------------------------------------
// checkLimit — Express middleware factory.
// Attach to any route to enforce a feature limit before the handler runs.
// ----------------------------------------------------------------
function checkLimit(feature) {
  return async (req, res, next) => {
    // Support both tenancy middleware (req.userId) and plain auth (req.user.id)
    const userId = req.userId || req.user?.id;
    if (!userId) return next();

    try {
      // 1. Get the user's current plan from the subscriptions table.
      // Plan values: free | starter | professional | enterprise
      // We normalise 'free' → 'free_trial' to match the tier_limits table keys.
      // Treat cancelled or past_due subscriptions as free_trial for limit purposes.
      const { data: sub } = await supabaseAdmin
        .from('subscriptions')
        .select('plan, status')
        .eq('user_id', userId)
        .single();

      const activePlan = (sub?.status === 'active' || sub?.status === 'trialing')
        ? (sub?.plan || 'free')
        : 'free';
      const tier = activePlan === 'free' ? 'free_trial' : activePlan;

      // 2. Look up this tier's limit for the feature
      const limit = await getLimitForFeature(tier, feature);

      // No limit configured or limit is toggled off → allow through
      if (!limit || !limit.enabled) return next();

      // -1 = unlimited → always allow
      if (limit.limit_value === -1) return next();

      // 3. Count the user's current usage
      const usage = await countUsage(userId, feature);

      // Under the limit → allow
      if (usage < limit.limit_value) return next();

      // Limit reached → block with a clear message the frontend can show
      console.log(`[CheckLimit] User ${userId} (${tier}) reached ${feature}: ${usage}/${limit.limit_value}`);

      return res.status(429).json({
        error:         `You've reached your ${limit.label} limit (${limit.limit_value}). Upgrade your plan to continue.`,
        limit_reached: true,
        feature,
        limit:         limit.limit_value,
        usage,
        tier
      });

    } catch (err) {
      // Never block users because of our own infrastructure errors
      console.error('[CheckLimit] Error (allowing through):', err.message);
      next();
    }
  };
}

module.exports = { checkLimit, bustLimitsCache, getAllLimits };
