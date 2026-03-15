/**
 * middleware/adminAuth.js
 *
 * Restricts routes to admin users only.
 *
 * Must be used AFTER requireAuth (which populates req.user).
 *
 * Admin list is stored in the ADMIN_EMAILS environment variable as a
 * comma-separated list of email addresses. This intentionally avoids
 * any DB column change — admins are always set at the infrastructure
 * level, not by any user action.
 *
 * Usage:
 *   const { requireAdmin } = require('../middleware/adminAuth');
 *   router.get('/something', requireAuth, requireAdmin, handler);
 */

function requireAdmin(req, res, next) {
  if (!req.user?.email) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean);

  if (!adminEmails.includes(req.user.email.toLowerCase())) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  next();
}

module.exports = { requireAdmin };
