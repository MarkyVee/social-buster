/**
 * services/emailGroupResolver.js
 *
 * Shared helper that resolves an email group into a list of users.
 *
 * Used by:
 *   - routes/email.js    — for the group preview endpoint
 *   - workers/emailWorker.js — at send time to get the recipient list
 *
 * Extracted into its own file to avoid circular dependencies between
 * routes and workers (same pattern as messagingService.js).
 *
 * Two group types:
 *   'filter' — dynamic membership based on filter_criteria JSONB.
 *              Resolved fresh every time (users who match right now).
 *   'manual' — static list of user IDs stored in manual_user_ids.
 */

const { supabaseAdmin } = require('./supabaseService');

/**
 * resolveGroupMembers — returns the list of users that belong to a group.
 *
 * @param {Object} group — email_groups row (must include group_type, filter_criteria, manual_user_ids)
 * @returns {{ users: Array<{user_id, email, brand_name}>, count: number }}
 */
async function resolveGroupMembers(group) {
  if (group.group_type === 'manual') {
    return await resolveManualGroup(group);
  }

  if (group.group_type === 'filter') {
    return await resolveFilterGroup(group);
  }

  return { users: [], count: 0 };
}

// ----------------------------------------------------------------
// Manual group — fetch users by their IDs
// ----------------------------------------------------------------
async function resolveManualGroup(group) {
  const userIds = group.manual_user_ids || [];
  if (userIds.length === 0) return { users: [], count: 0 };

  const { data, error } = await supabaseAdmin
    .from('user_profiles')
    .select('user_id, email, brand_name')
    .in('user_id', userIds);

  if (error) {
    console.error('[EmailGroupResolver] Manual group query failed:', error.message);
    return { users: [], count: 0 };
  }

  return { users: data || [], count: (data || []).length };
}

// ----------------------------------------------------------------
// Filter group — build a dynamic query from filter_criteria
//
// Supported filter keys:
//   subscription_tier  — exact match (e.g. 'starter')
//   industry           — exact match
//   geo_region         — exact match
//   business_type      — exact match
//   signup_after       — created_at >= value
//   signup_before      — created_at <= value
//   platforms_connected — array of platform names (requires cross-table query)
// ----------------------------------------------------------------
async function resolveFilterGroup(group) {
  const criteria = group.filter_criteria || {};

  // Start building the query on user_profiles
  let query = supabaseAdmin
    .from('user_profiles')
    .select('user_id, email, brand_name');

  // Apply simple equality filters
  if (criteria.subscription_tier) {
    query = query.eq('subscription_tier', criteria.subscription_tier);
  }
  if (criteria.industry) {
    query = query.eq('industry', criteria.industry);
  }
  if (criteria.geo_region) {
    query = query.eq('geo_region', criteria.geo_region);
  }
  if (criteria.business_type) {
    query = query.eq('business_type', criteria.business_type);
  }

  // Date range filters
  if (criteria.signup_after) {
    query = query.gte('created_at', criteria.signup_after);
  }
  if (criteria.signup_before) {
    query = query.lte('created_at', criteria.signup_before);
  }

  // Platform filter — requires a separate query to platform_connections
  // to find users who have at least one of the specified platforms connected.
  if (criteria.platforms_connected && criteria.platforms_connected.length > 0) {
    const { data: connUsers, error: connErr } = await supabaseAdmin
      .from('platform_connections')
      .select('user_id')
      .in('platform', criteria.platforms_connected);

    if (connErr) {
      console.error('[EmailGroupResolver] Platform filter query failed:', connErr.message);
      return { users: [], count: 0 };
    }

    const connUserIds = [...new Set((connUsers || []).map(c => c.user_id))];
    if (connUserIds.length === 0) return { users: [], count: 0 };

    query = query.in('user_id', connUserIds);
  }

  const { data, error } = await query;

  if (error) {
    console.error('[EmailGroupResolver] Filter group query failed:', error.message);
    return { users: [], count: 0 };
  }

  return { users: data || [], count: (data || []).length };
}

module.exports = { resolveGroupMembers };
