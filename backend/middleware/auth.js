/**
 * middleware/auth.js
 *
 * Authentication middleware. Verifies the JWT on every protected request.
 * Attach this to any route that requires a logged-in user.
 *
 * Usage:
 *   const { requireAuth } = require('../middleware/auth');
 *   router.get('/protected', requireAuth, handler);
 */

const { verifyToken } = require('../services/supabaseService');

async function requireAuth(req, res, next) {
  try {
    // Pull the Authorization header from the request
    const authHeader = req.headers.authorization;

    // If no header is present, reject immediately
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    // Extract the token (everything after "Bearer ")
    const token = authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    // Verify the token with Supabase and get the user object
    // verifyToken throws if the token is invalid or expired
    const user = await verifyToken(token);

    // Attach the authenticated user and raw token to the request
    // so downstream middleware and route handlers can use them
    req.user = user;
    req.token = token;

    // Pass control to the next middleware or route handler
    next();

  } catch (err) {
    // Token was invalid or expired — reject the request
    return res.status(401).json({ error: 'Unauthorized: ' + err.message });
  }
}

module.exports = { requireAuth };
