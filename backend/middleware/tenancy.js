/**
 * middleware/tenancy.js
 *
 * Multi-tenant isolation middleware. This is the most critical security layer
 * in the entire platform. It MUST run on every request that touches the database.
 *
 * What it does:
 * - Runs after requireAuth (which puts req.user on the request)
 * - Creates a Supabase client scoped to the user's JWT and attaches it to req.db
 * - Because the scoped client passes the user's JWT, PostgreSQL RLS policies
 *   enforce that auth.uid() must match the user_id column on every query
 * - If anyone tries to access another user's data, the DB rejects it at the row level
 *
 * Usage (apply both middlewares together on every protected router):
 *   const { requireAuth } = require('../middleware/auth');
 *   const { enforceTenancy } = require('../middleware/tenancy');
 *   router.use(requireAuth, enforceTenancy);
 *
 * Then in route handlers, use req.db for all database queries:
 *   const { data } = await req.db.from('briefs').select('*');
 *   // This automatically returns ONLY the current user's briefs.
 */

const { createUserClient } = require('../services/supabaseService');

function enforceTenancy(req, res, next) {
  // requireAuth must have run first — bail out if user is missing
  if (!req.user || !req.user.id) {
    return res.status(401).json({ error: 'Authentication required before tenancy check' });
  }

  // Create a Supabase client scoped to this user's JWT.
  // All queries made through req.db will be automatically filtered
  // to this user by PostgreSQL Row Level Security policies.
  req.db = createUserClient(req.token);

  // Also make the user's ID directly available as a convenience shortcut
  req.userId = req.user.id;

  next();
}

module.exports = { enforceTenancy };
