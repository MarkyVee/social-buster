/**
 * services/supabaseService.js
 *
 * Central service for all Supabase interactions.
 * Exports two types of clients:
 *   1. supabaseAdmin  - Full access, server-side only. NEVER expose to users.
 *   2. createUserClient() - Scoped to a user's JWT, respects RLS policies.
 */

const { createClient } = require('@supabase/supabase-js');

// Validate required environment variables on startup
if (!process.env.SUPABASE_URL) throw new Error('Missing SUPABASE_URL');
if (!process.env.SUPABASE_ANON_KEY) throw new Error('Missing SUPABASE_ANON_KEY');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');

// ----------------------------------------------------------------
// Admin client - uses the SERVICE_ROLE key which bypasses RLS.
// Use this ONLY for:
//   - Server-side agent operations
//   - Admin panel actions
//   - Webhook handlers (Stripe, etc.)
// NEVER use this in a route that a regular user can trigger.
// ----------------------------------------------------------------
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      // Prevent the admin client from trying to persist sessions
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

// ----------------------------------------------------------------
// Create a per-request Supabase client scoped to the user's JWT.
// This client respects Row Level Security (RLS) policies.
// Every user can only see and modify their own rows.
//
// Call this in middleware and attach the result to req.db so
// every route handler uses a pre-scoped client automatically.
// ----------------------------------------------------------------
function createUserClient(userJwt) {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY,
    {
      global: {
        headers: {
          // Passing the user's JWT makes Supabase evaluate RLS
          // policies as that user (auth.uid() = their user_id)
          Authorization: `Bearer ${userJwt}`
        }
      },
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    }
  );
}

// ----------------------------------------------------------------
// Verify a JWT and return the authenticated user object.
// Used by the auth middleware to validate every incoming request.
// ----------------------------------------------------------------
async function verifyToken(jwt) {
  const { data, error } = await supabaseAdmin.auth.getUser(jwt);
  if (error) throw new Error('Invalid or expired token');
  return data.user;
}

// ----------------------------------------------------------------
// Fetch a user's full profile from the user_profiles table.
// ----------------------------------------------------------------
async function getUserProfile(userId) {
  const { data, error } = await supabaseAdmin
    .from('user_profiles')
    .select('*')
    .eq('user_id', userId)
    .single();

  if (error) throw new Error(`Failed to fetch user profile: ${error.message}`);
  return data;
}

// ----------------------------------------------------------------
// Create a user profile row after registration.
// Called by the auth route immediately after Supabase auth.signUp.
// ----------------------------------------------------------------
async function createUserProfile(userId, email) {
  const { data, error } = await supabaseAdmin
    .from('user_profiles')
    .insert({
      user_id: userId,
      email: email,
      brand_name: null,
      industry: null,
      target_audience: null,
      brand_voice: null,
      onboarding_complete: false
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create user profile: ${error.message}`);
  return data;
}

// ----------------------------------------------------------------
// US state → geo_region mapping for cohort matching.
// geo_region is ALWAYS derived from state — never trusted from the client.
// ----------------------------------------------------------------
const STATE_TO_REGION = {
  // Northeast
  CT: 'northeast_us', ME: 'northeast_us', MA: 'northeast_us', NH: 'northeast_us',
  NJ: 'northeast_us', NY: 'northeast_us', PA: 'northeast_us', RI: 'northeast_us',
  VT: 'northeast_us',
  // Southeast
  AL: 'southeast_us', AR: 'southeast_us', DC: 'southeast_us', DE: 'southeast_us',
  FL: 'southeast_us', GA: 'southeast_us', KY: 'southeast_us', LA: 'southeast_us',
  MD: 'southeast_us', MS: 'southeast_us', NC: 'southeast_us', SC: 'southeast_us',
  TN: 'southeast_us', VA: 'southeast_us', WV: 'southeast_us',
  // Midwest
  IL: 'midwest_us', IN: 'midwest_us', IA: 'midwest_us', KS: 'midwest_us',
  MI: 'midwest_us', MN: 'midwest_us', MO: 'midwest_us', NE: 'midwest_us',
  ND: 'midwest_us', OH: 'midwest_us', SD: 'midwest_us', WI: 'midwest_us',
  // Southwest
  AZ: 'southwest_us', NM: 'southwest_us', OK: 'southwest_us', TX: 'southwest_us',
  // West
  AK: 'west_us', CA: 'west_us', CO: 'west_us', HI: 'west_us', ID: 'west_us',
  MT: 'west_us', NV: 'west_us', OR: 'west_us', UT: 'west_us', WA: 'west_us',
  WY: 'west_us'
};

// ----------------------------------------------------------------
// Update a user's brand profile settings.
// Only whitelisted fields can be updated this way (no user_id spoofing).
// geo_region is ALWAYS derived from state — the client cannot set it directly.
// ----------------------------------------------------------------
async function updateUserProfile(userId, updates) {
  const allowedFields = [
    // Original fields
    'brand_name', 'industry', 'target_audience', 'brand_voice', 'onboarding_complete',
    // Personal
    'full_name',
    // Geographic
    'city', 'state',
    // Business context
    'business_type', 'business_size', 'years_in_business', 'primary_goal', 'content_frequency',
    // Audience context
    'target_age_range', 'target_gender', 'audience_location', 'audience_interests',
    // Intelligence cold start
    'reference_accounts', 'primary_competitors',
    // Preferences
    'preferred_platforms'
  ];

  const safeUpdates = {};
  for (const key of allowedFields) {
    if (updates[key] !== undefined) safeUpdates[key] = updates[key];
  }

  // Derive geo_region from state whenever state is being updated.
  // Normalize to uppercase (accept "tx", "TX", "Texas abbreviation" style input).
  if (safeUpdates.state) {
    const stateCode = safeUpdates.state.trim().toUpperCase();
    safeUpdates.geo_region = STATE_TO_REGION[stateCode] || null;
  }

  const { data, error } = await supabaseAdmin
    .from('user_profiles')
    .update(safeUpdates)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) throw new Error(`Failed to update user profile: ${error.message}`);
  return data;
}

module.exports = {
  supabaseAdmin,
  createUserClient,
  verifyToken,
  getUserProfile,
  createUserProfile,
  updateUserProfile
};
