/**
 * services/activityService.js
 *
 * Single write point for all activity log events.
 *
 * logActivity() is fire-and-forget by design:
 *   - NEVER throws — errors are swallowed with console.warn
 *   - Returns undefined, not a Promise — callers cannot accidentally await it
 *   - NEVER blocks a request or worker response path
 *
 * Known event types:
 *   login, logout,
 *   post_created, post_published,
 *   dm_sent,
 *   subscription_changed,
 *   referral_created, referral_converted,
 *   media_uploaded,
 *   platform_connected, platform_disconnected
 *
 * Usage (no await — intentional):
 *   logActivity(userId, 'login', { user_agent: req.headers['user-agent'] }, req.ip);
 *   logActivity(userId, 'post_published', { post_id: post.id, platform: post.platform });
 */

const { supabaseAdmin } = require('./supabaseService');

/**
 * @param {string} userId     - UUID of the user this event belongs to
 * @param {string} eventType  - One of the known event_type values above
 * @param {object} [metadata] - Small JSONB payload. IDs only — never raw content.
 * @param {string} [ip]       - Client IP. Pass null for worker-origin events.
 */
function logActivity(userId, eventType, metadata = {}, ip = null) {
  // Skip silently if called with missing required fields
  if (!userId || !eventType) {
    console.warn('[ActivityService] logActivity called without userId or eventType — skipping');
    return;
  }

  // Fire-and-forget: do not return the promise
  supabaseAdmin
    .from('activity_log')
    .insert({
      user_id:    userId,
      event_type: eventType,
      metadata:   metadata || {},
      ip:         ip || null,
    })
    .then(({ error }) => {
      if (error) {
        console.warn(`[ActivityService] Failed to log "${eventType}" for user ${userId}:`, error.message);
      }
    })
    .catch((err) => {
      console.warn(`[ActivityService] Unexpected error logging "${eventType}":`, err.message);
    });
  // Returns undefined — callers cannot await this
}

module.exports = { logActivity };
