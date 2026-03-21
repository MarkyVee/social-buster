/**
 * routes/auth.js
 *
 * Authentication routes: register, login, logout, password reset, and profile fetch.
 * These routes are public (no requireAuth) except for GET /auth/me.
 */

const express = require('express');
const router = express.Router();

const { supabaseAdmin, createUserProfile, getUserProfile } = require('../services/supabaseService');
const { createStripeCustomer } = require('../services/stripeService');
const { requireAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');

// Apply auth-specific rate limiting (by IP) to all routes in this file
router.use(authLimiter);

// ----------------------------------------------------------------
// POST /auth/register
// Creates a new user account.
//
// Steps:
// 1. Create the user in Supabase Auth
// 2. Create a user_profiles row in the database
// 3. Create a Stripe customer so billing is ready
// 4. Return the session (JWT + user data)
//
// If any step fails after Supabase Auth creation, we clean up
// by deleting the auth user so no orphaned accounts exist.
// ----------------------------------------------------------------
router.post('/register', async (req, res) => {
  const { email, password } = req.body;

  // Validate inputs
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  let authUserId = null;

  try {
    // Step 1: Create user in Supabase Auth
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true // Auto-confirm so user can log in immediately after registration
    });

    if (authError) {
      // Handle common errors with clear messages
      if (authError.message.includes('already registered')) {
        return res.status(409).json({ error: 'An account with this email already exists' });
      }
      throw authError;
    }

    authUserId = authData.user.id;

    // Step 2: Create user profile row
    await createUserProfile(authUserId, email);

    // Step 3: Create Stripe customer (best-effort — don't fail registration if Stripe is down)
    try {
      await createStripeCustomer(authUserId, email);
    } catch (stripeErr) {
      // Log but don't block registration — Stripe customer can be created later
      console.error('[Auth] Stripe customer creation failed:', stripeErr.message);
    }

    // Step 4: Sign in immediately to get the session JWT
    // (admin.createUser doesn't return a session, so we sign in right after)
    const { data: sessionData, error: sessionError } = await supabaseAdmin.auth.signInWithPassword({
      email,
      password
    });

    if (sessionError) throw sessionError;

    return res.status(201).json({
      message: 'Account created successfully',
      session: sessionData.session,
      user: {
        id: authUserId,
        email
      }
    });

  } catch (err) {
    // If anything failed after auth user was created, clean up to avoid orphaned accounts
    if (authUserId) {
      try {
        await supabaseAdmin.auth.admin.deleteUser(authUserId);
      } catch (cleanupErr) {
        console.error('[Auth] Failed to clean up auth user after error:', cleanupErr.message);
      }
    }

    console.error('[Auth] Registration error:', err.message);
    return res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ----------------------------------------------------------------
// POST /auth/login
// Authenticates an existing user and returns a JWT session.
// ----------------------------------------------------------------
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const { data, error } = await supabaseAdmin.auth.signInWithPassword({ email, password });

    if (error) {
      // Return a generic error to avoid revealing whether the email exists
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    return res.json({
      message: 'Login successful',
      session: data.session,
      user: {
        id: data.user.id,
        email: data.user.email
      }
    });

  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    return res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ----------------------------------------------------------------
// POST /auth/refresh
// Exchanges a refresh token for a new access token + refresh token.
// Called automatically by the frontend when a 401 is received.
// The refresh token is long-lived (60 days by default in Supabase).
// ----------------------------------------------------------------
router.post('/refresh', async (req, res) => {
  const { refresh_token } = req.body;

  if (!refresh_token) {
    return res.status(400).json({ error: 'refresh_token is required' });
  }

  try {
    const { data, error } = await supabaseAdmin.auth.refreshSession({ refresh_token });

    if (error || !data.session) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    return res.json({
      session: data.session   // includes new access_token + refresh_token
    });

  } catch (err) {
    console.error('[Auth] Refresh error:', err.message);
    return res.status(500).json({ error: 'Token refresh failed. Please log in again.' });
  }
});

// ----------------------------------------------------------------
// POST /auth/logout
// Invalidates the current session. Requires a valid JWT.
// ----------------------------------------------------------------
router.post('/logout', requireAuth, async (req, res) => {
  try {
    // Sign out from Supabase (invalidates the token server-side)
    await supabaseAdmin.auth.admin.signOut(req.token);

    return res.json({ message: 'Logged out successfully' });

  } catch (err) {
    console.error('[Auth] Logout error:', err.message);
    // Even if sign-out fails, tell the client it succeeded
    // The client should delete the token from localStorage regardless
    return res.json({ message: 'Logged out' });
  }
});

// ----------------------------------------------------------------
// POST /auth/reset
// Sends a password reset email via Supabase.
// ----------------------------------------------------------------
router.post('/reset', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    // Always return a success message, even if the email doesn't exist.
    // This prevents user enumeration (attackers probing which emails are registered).
    await supabaseAdmin.auth.resetPasswordForEmail(email, {
      redirectTo: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password`
    });

    return res.json({ message: 'If that email exists, a reset link has been sent.' });

  } catch (err) {
    console.error('[Auth] Password reset error:', err.message);
    // Return success anyway to prevent enumeration
    return res.json({ message: 'If that email exists, a reset link has been sent.' });
  }
});

// ----------------------------------------------------------------
// POST /auth/update-password
// Sets a new password after clicking a reset link from email.
// The frontend sends the recovery access_token (from the URL fragment)
// so we can authenticate the user and update their password.
// ----------------------------------------------------------------
router.post('/update-password', async (req, res) => {
  const { access_token, new_password } = req.body;

  if (!access_token || !new_password) {
    return res.status(400).json({ error: 'access_token and new_password are required' });
  }

  if (new_password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    // Verify the recovery token by getting the user it belongs to
    const { data: userData, error: userError } = await supabaseAdmin.auth.getUser(access_token);

    if (userError || !userData?.user) {
      return res.status(401).json({ error: 'Invalid or expired reset link. Please request a new one.' });
    }

    // Update the user's password using the admin API
    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(
      userData.user.id,
      { password: new_password }
    );

    if (updateError) throw updateError;

    // Sign the user in with their new password so they don't have to
    // manually log in again after resetting
    const { data: sessionData, error: sessionError } = await supabaseAdmin.auth.signInWithPassword({
      email: userData.user.email,
      password: new_password
    });

    if (sessionError) {
      // Password was updated but auto-login failed — still a success,
      // just tell them to log in manually
      return res.json({
        message: 'Password updated successfully. Please log in with your new password.',
        session: null
      });
    }

    return res.json({
      message: 'Password updated successfully.',
      session: sessionData.session,
      user: {
        id: userData.user.id,
        email: userData.user.email
      }
    });

  } catch (err) {
    console.error('[Auth] Update password error:', err.message);
    return res.status(500).json({ error: 'Failed to update password. Please try again.' });
  }
});

// ----------------------------------------------------------------
// GET /auth/me
// Returns the current user's profile. Requires authentication.
// ----------------------------------------------------------------
router.get('/me', requireAuth, async (req, res) => {
  try {
    const profile = await getUserProfile(req.user.id);

    // Check if this user is an admin (email in the ADMIN_EMAILS env var)
    const adminEmails = (process.env.ADMIN_EMAILS || '')
      .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    const isAdmin = adminEmails.includes((req.user.email || '').toLowerCase());

    // Fetch subscription data so the frontend can show the correct plan badge
    let subscription = { plan: 'free_trial', status: 'active' };
    try {
      const { data: sub } = await supabaseAdmin
        .from('subscriptions')
        .select('plan, status, current_period_end')
        .eq('user_id', req.user.id)
        .single();
      if (sub) subscription = sub;
    } catch (_) { /* non-fatal — default to free_trial */ }

    return res.json({
      user: {
        id:       req.user.id,
        email:    req.user.email,
        is_admin: isAdmin,
        subscription,
        profile
      }
    });

  } catch (err) {
    console.error('[Auth] /me error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch user profile' });
  }
});

// ----------------------------------------------------------------
// PUT /auth/me
// Updates the current user's brand profile (called from the Settings page).
// Only brand_name, industry, target_audience, brand_voice can be updated —
// the updateUserProfile() function in supabaseService whitelists these fields.
// ----------------------------------------------------------------
router.put('/me', requireAuth, async (req, res) => {
  const { updateUserProfile } = require('../services/supabaseService');

  try {
    const updated = await updateUserProfile(req.user.id, req.body);

    return res.json({
      message: 'Profile updated successfully',
      profile: updated
    });

  } catch (err) {
    console.error('[Auth] PUT /me error:', err.message);
    return res.status(500).json({ error: 'Failed to update profile' });
  }
});

module.exports = router;
