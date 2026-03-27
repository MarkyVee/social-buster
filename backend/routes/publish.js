/**
 * routes/publish.js
 *
 * Publishing queue management and social platform connection routes.
 *
 * Routes:
 *   GET    /publish/queue                      — list the user's publishing queue
 *   DELETE /publish/queue/:id                  — remove a post from the queue (→ approved)
 *   GET    /publish/platforms                  — list connected social platforms
 *   POST   /publish/platforms/connect          — save a platform OAuth token
 *   DELETE /publish/platforms/:platform        — disconnect a platform
 *   POST   /publish/:postId                    — immediately publish an approved post
 *
 * NOTE: Actual publishing calls platform APIs which require OAuth credentials.
 * Until credentials are configured per platform, POST /publish/:postId will
 * return a clear error message explaining what to set up.
 *
 * All queries are scoped to req.user.id via enforceTenancy (RLS enforced at DB level).
 */

const express = require('express');
const router  = express.Router();
const axios   = require('axios');
const crypto  = require('crypto');

const { requireAuth }    = require('../middleware/auth');
const { enforceTenancy } = require('../middleware/tenancy');
const { standardLimiter, authLimiter } = require('../middleware/rateLimit');
const { checkLimit }     = require('../middleware/checkLimit');
const { supabaseAdmin }  = require('../services/supabaseService');
const { encryptToken }   = require('../services/tokenEncryption');
const { publish }        = require('../services/platformAPIs');
const { cacheSet, cacheGet, cacheDel } = require('../services/redisService');

// ----------------------------------------------------------------
// Redirect URIs — must be registered in each platform's developer portal.
// META:    https://developers.facebook.com → Your App → Facebook Login → Valid OAuth Redirect URIs
// THREADS: https://developers.facebook.com → Your App → Threads API → Redirect URIs
// ----------------------------------------------------------------
const FRONTEND_URL          = process.env.FRONTEND_URL          || 'http://localhost:3001';
const META_REDIRECT_URI     = process.env.META_REDIRECT_URI     || `${FRONTEND_URL}/publish/oauth/meta/callback`;
const THREADS_REDIRECT_URI  = process.env.THREADS_REDIRECT_URI  || `${FRONTEND_URL}/publish/oauth/threads/callback`;
const TIKTOK_REDIRECT_URI   = process.env.TIKTOK_REDIRECT_URI   || `${FRONTEND_URL}/publish/oauth/tiktok/callback`;
const LINKEDIN_REDIRECT_URI = process.env.LINKEDIN_REDIRECT_URI || `${FRONTEND_URL}/publish/oauth/linkedin/callback`;
const X_REDIRECT_URI        = process.env.X_REDIRECT_URI        || `${FRONTEND_URL}/publish/oauth/x/callback`;

// ================================================================
// UNPROTECTED OAUTH CALLBACKS
//
// Google/Meta/Threads redirect the user's browser to these URLs after
// the user approves access. They MUST be declared BEFORE router.use()
// below so they don't get blocked by the auth middleware.
// ================================================================

// ----------------------------------------------------------------
// GET /publish/oauth/meta/callback
//
// Called by Meta after the user grants permission.
// Exchanges the one-time code for access tokens, then:
//   - Fetches the user's Facebook Pages (for page posting)
//   - Stores a `facebook` connection using the Page access token
//   - Checks for a linked Instagram Business Account and stores `instagram`
// Sets a cookie so the frontend can show a success/error message.
// ----------------------------------------------------------------
// ISSUE-006: Rate limit OAuth callbacks to prevent abuse (20 req/min per IP)
router.get('/oauth/meta/callback', authLimiter, async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  // Helper: set result cookie and redirect back to the Settings page
  const finish = (result) => {
    res.cookie('sb_platform_oauth', JSON.stringify(result), {
      maxAge:   30000,   // 30 seconds — just long enough to read on redirect
      httpOnly: false,   // Frontend JS must be able to read it
      sameSite: 'lax',
      secure:   process.env.NODE_ENV === 'production'  // ISSUE-016: Secure flag in production
    });
    return res.redirect(`${FRONTEND_URL}/#settings`);
  };

  if (oauthError || !code || !state) {
    return finish({ status: 'cancelled' });
  }

  try {
    // Verify the OAuth state nonce — prevents state injection attacks.
    // The nonce was stored in Redis during /oauth/meta/start. If it doesn't exist,
    // the flow was forged or expired (10 min TTL). Each nonce is single-use.
    const userId = await cacheGet(`oauth_nonce:${state}`);
    if (!userId) throw new Error('Invalid or expired OAuth state. Please try connecting again.');
    await cacheDel(`oauth_nonce:${state}`);

    // Step 1: Exchange the one-time code for a short-lived user access token
    const tokenRes = await axios.get('https://graph.facebook.com/v21.0/oauth/access_token', {
      params: {
        client_id:     process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
        redirect_uri:  META_REDIRECT_URI,
        code
      }
    });
    const shortToken = tokenRes.data.access_token;

    // Step 2: Exchange short-lived token for a long-lived token (60 days)
    const longTokenRes = await axios.get('https://graph.facebook.com/v21.0/oauth/access_token', {
      params: {
        grant_type:        'fb_exchange_token',
        client_id:         process.env.META_APP_ID,
        client_secret:     process.env.META_APP_SECRET,
        fb_exchange_token: shortToken
      }
    });
    const longToken  = longTokenRes.data.access_token;
    const expiresIn  = longTokenRes.data.expires_in || 5184000; // default 60 days
    const expiresAt  = new Date(Date.now() + expiresIn * 1000).toISOString();

    // Step 3: Get the user's Facebook Pages (each page has its own permanent token)
    const pagesRes = await axios.get('https://graph.facebook.com/v21.0/me/accounts', {
      params: {
        access_token: longToken,
        fields:       'id,name,access_token,instagram_business_account'
      }
    });
    const pages = pagesRes.data.data || [];

    if (pages.length === 0) {
      // No Facebook Pages found — the user may only have a personal profile.
      console.warn(`[Publish] Meta OAuth: user ${userId} has no Facebook Pages.`);
      return finish({
        status:  'error',
        message: 'No Facebook Page found. Please create a Facebook Page before connecting.'
      });
    }

    // Always show the page picker — even with a single page.
    // This lets the user confirm they're connecting the right Page
    // and cancel if Meta returned the wrong account.
    const sessionId = require('crypto').randomUUID();
    await cacheSet(`meta_page_select:${sessionId}`, { userId, pages }, 300);
    console.log(`[Publish] Meta OAuth: ${pages.length} page(s) found for user ${userId}, awaiting page selection`);
    return finish({ status: 'page_select', session: sessionId });

  } catch (err) {
    console.error('[Publish] Meta OAuth callback error:', err.response?.data || err.message);
    return finish({ status: 'error', message: 'Meta connection failed. Please try again.' });
  }
});

// ----------------------------------------------------------------
// saveMetaPageConnection (internal helper)
//
// Saves a Facebook Page and its linked Instagram account to the DB.
// Called both from the OAuth callback (single page) and from the
// select-page endpoint (user-chosen page).
//
// finish — a function(result) that sends the response. The callback
//          passes its redirect-cookie finish(). The select-page route
//          passes a simple res.json() wrapper.
// ----------------------------------------------------------------
async function saveMetaPageConnection(userId, page, finish) {
  const connectedPlatforms = [];

  // Store the Facebook Page connection using the page's own access token
  await supabaseAdmin
    .from('platform_connections')
    .upsert({
      user_id:           userId,
      platform:          'facebook',
      access_token:      encryptToken(page.access_token),
      refresh_token:     null,          // Page tokens don't expire (until revoked)
      token_expires_at:  null,
      platform_user_id:  page.id,
      platform_username: page.name,
      connected_at:      new Date().toISOString()
    }, { onConflict: 'user_id,platform' });

  connectedPlatforms.push('facebook');
  console.log(`[Publish] Facebook Page "${page.name}" (${page.id}) connected for user ${userId}`);

  // Subscribe the Page to our app's webhooks so Meta sends us
  // real-time events (comments, messages, etc.) for this Page.
  // Without this call, the webhook URL we registered won't receive events.
  try {
    await axios.post(
      `https://graph.facebook.com/v21.0/${page.id}/subscribed_apps`,
      null,
      { params: {
          access_token: page.access_token,
          subscribed_fields: 'feed,messages,messaging_postbacks,message_deliveries,messaging_optins'
        },
        timeout: 10000
      }
    );
    console.log(`[Publish] Page "${page.name}" subscribed to app webhooks (feed, messages)`);
  } catch (subErr) {
    // Non-fatal — webhooks won't fire but polling still works as a safety net
    console.warn(`[Publish] Could not subscribe Page to webhooks:`, subErr.response?.data?.error?.message || subErr.message);
  }

  // Check for a linked Instagram Business Account on this Page
  if (page.instagram_business_account?.id) {
    try {
      const igRes = await axios.get(
        `https://graph.facebook.com/v21.0/${page.instagram_business_account.id}`,
        { params: { access_token: page.access_token, fields: 'id,username' } }
      );
      const igAccount = igRes.data;

      // Instagram posts are made using the Page's access token, targeting the IG account ID
      await supabaseAdmin
        .from('platform_connections')
        .upsert({
          user_id:           userId,
          platform:          'instagram',
          access_token:      encryptToken(page.access_token),
          refresh_token:     null,
          token_expires_at:  null,
          platform_user_id:  igAccount.id,
          platform_username: igAccount.username || page.name,
          connected_at:      new Date().toISOString()
        }, { onConflict: 'user_id,platform' });

      connectedPlatforms.push('instagram');
      console.log(`[Publish] Instagram "@${igAccount.username}" connected for user ${userId}`);

      // Subscribe the Instagram Business Account to our app's webhooks
      // so Meta sends real-time events (comments, DMs) for this account.
      // Same pattern as Facebook Page subscription above.
      try {
        await axios.post(
          `https://graph.facebook.com/v21.0/${igAccount.id}/subscribed_apps`,
          null,
          {
            params: {
              access_token: page.access_token,
              subscribed_fields: 'comments,messages,message_reactions'
            },
            timeout: 10000
          }
        );
        console.log(`[Publish] Instagram "@${igAccount.username}" subscribed to app webhooks (comments, messages)`);
      } catch (subErr) {
        // Non-fatal — webhooks won't fire but polling still works as a safety net
        console.warn(`[Publish] Could not subscribe Instagram to webhooks:`, subErr.response?.data?.error?.message || subErr.message);
      }
    } catch (igErr) {
      // Non-fatal — Facebook still connects even if Instagram lookup fails
      console.warn('[Publish] Could not fetch Instagram account:', igErr.message);
    }
  }

  return finish({ status: 'connected', platforms: connectedPlatforms });
}

// ----------------------------------------------------------------
// GET /publish/oauth/threads/callback
//
// Called by Threads (threads.net) after the user grants permission.
// Exchanges the code for a token, fetches user info, stores the connection.
// ----------------------------------------------------------------
router.get('/oauth/threads/callback', authLimiter, async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  const finish = (result) => {
    res.cookie('sb_platform_oauth', JSON.stringify(result), {
      maxAge: 30000, httpOnly: false, sameSite: 'lax'
    });
    return res.redirect(`${FRONTEND_URL}/#settings`);
  };

  if (oauthError || !code || !state) {
    return finish({ status: 'cancelled' });
  }

  try {
    // Verify the OAuth state nonce — same pattern as Meta callback
    const userId = await cacheGet(`oauth_nonce:${state}`);
    if (!userId) throw new Error('Invalid or expired OAuth state. Please try connecting again.');
    await cacheDel(`oauth_nonce:${state}`);

    // Threads has its own App ID/Secret, separate from the Facebook Login Meta App.
    const threadsAppId     = process.env.THREADS_APP_ID || process.env.META_APP_ID;
    const threadsAppSecret = process.env.THREADS_APP_SECRET || process.env.META_APP_SECRET;

    // Step 1: Exchange code for short-lived Threads access token
    const tokenRes = await axios.post(
      'https://graph.threads.net/oauth/access_token',
      new URLSearchParams({
        client_id:     threadsAppId,
        client_secret: threadsAppSecret,
        grant_type:    'authorization_code',
        redirect_uri:  THREADS_REDIRECT_URI,
        code
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const shortToken = tokenRes.data.access_token;

    // Step 2: Exchange for long-lived token (60 days)
    const longTokenRes = await axios.get('https://graph.threads.net/access_token', {
      params: {
        grant_type:    'th_exchange_token',
        client_secret: threadsAppSecret,
        access_token:  shortToken
      }
    });
    const longToken = longTokenRes.data.access_token;
    const expiresIn = longTokenRes.data.expires_in || 5184000;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    // Step 3: Get the Threads user's profile info
    const meRes = await axios.get('https://graph.threads.net/v1.0/me', {
      params: { access_token: longToken, fields: 'id,username,name' }
    });
    const threadsUser = meRes.data;

    // Step 4: Store the Threads connection
    await supabaseAdmin
      .from('platform_connections')
      .upsert({
        user_id:           userId,
        platform:          'threads',
        access_token:      encryptToken(longToken),
        refresh_token:     null,
        token_expires_at:  expiresAt,
        platform_user_id:  threadsUser.id,
        platform_username: threadsUser.username || threadsUser.name || 'Threads',
        connected_at:      new Date().toISOString()
      }, { onConflict: 'user_id,platform' });

    return finish({ status: 'connected', platforms: ['threads'] });

  } catch (err) {
    console.error('[Publish] Threads OAuth callback error:', err.response?.data || err.message);
    return finish({ status: 'error', message: 'Threads connection failed. Please try again.' });
  }
});

// ----------------------------------------------------------------
// POST /publish/oauth/threads/deauthorize
//
// Meta calls this webhook when a user removes your app from their Threads account.
// Required by the Threads API portal — must be a valid URL to save settings.
// We log the event and return 200 OK. In production you'd delete the DB record.
// ----------------------------------------------------------------
router.post('/oauth/threads/deauthorize', (req, res) => {
  // Meta sends a signed_request payload. Log for auditing; no action needed for dev.
  const userId = req.body?.signed_request || '(unknown)';
  console.log('[Publish] Threads deauthorize webhook received for:', userId);
  return res.sendStatus(200);
});

// ----------------------------------------------------------------
// GET  /publish/oauth/threads/data-deletion  (Meta redirects users here)
// POST /publish/oauth/threads/data-deletion  (Meta also calls this as a webhook)
//
// Required by Meta/Threads API for GDPR data deletion requests.
// Meta calls this when a user asks Facebook to delete all their data.
// Must return a JSON body with a confirmation_code and status_url.
// ----------------------------------------------------------------
router.all('/oauth/threads/data-deletion', async (req, res) => {
  // In production: parse signed_request, find user, delete their data, return a tracking code.
  // For now: acknowledge the request with a placeholder confirmation code.
  const confirmationCode = `sb-deletion-${Date.now()}`;
  console.log('[Publish] Threads data deletion request received. Code:', confirmationCode);

  return res.json({
    url:               `${FRONTEND_URL}/data-deleted`,
    confirmation_code: confirmationCode
  });
});

// ----------------------------------------------------------------
// GET /publish/oauth/tiktok/callback
//
// Called by TikTok after the user grants permission.
// Exchanges the authorization code for an access token.
// TikTok tokens expire after 24 hours — refresh_token lasts 365 days.
// ----------------------------------------------------------------
router.get('/oauth/tiktok/callback', authLimiter, async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  const finish = (result) => {
    res.cookie('sb_platform_oauth', JSON.stringify(result), {
      maxAge: 30000, httpOnly: false, sameSite: 'lax'
    });
    return res.redirect(`${FRONTEND_URL}/#settings`);
  };

  if (oauthError || !code || !state) {
    return finish({ status: 'cancelled' });
  }

  try {
    // Verify the OAuth state nonce — same pattern as Meta callback
    const userId = await cacheGet(`oauth_nonce:${state}`);
    if (!userId) throw new Error('Invalid or expired OAuth state. Please try connecting again.');
    await cacheDel(`oauth_nonce:${state}`);

    // Exchange code for access token
    const tokenRes = await axios.post(
      'https://open.tiktokapis.com/v2/oauth/token/',
      new URLSearchParams({
        client_key:    process.env.TIKTOK_CLIENT_KEY,
        client_secret: process.env.TIKTOK_CLIENT_SECRET,
        code,
        grant_type:    'authorization_code',
        redirect_uri:  TIKTOK_REDIRECT_URI
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30_000 }
    );

    const { access_token, refresh_token, expires_in, open_id } = tokenRes.data;
    if (!access_token) throw new Error('TikTok returned no access_token');

    const expiresAt = new Date(Date.now() + (expires_in || 86400) * 1000).toISOString();

    // Fetch user info for display name
    let username = 'TikTok User';
    try {
      const userRes = await axios.get('https://open.tiktokapis.com/v2/user/info/', {
        params: { fields: 'display_name,username' },
        headers: { Authorization: `Bearer ${access_token}` },
        timeout: 30_000
      });
      username = userRes.data?.data?.user?.display_name || userRes.data?.data?.user?.username || username;
    } catch (e) {
      console.warn('[Publish] TikTok user info fetch failed (non-fatal):', e.message);
    }

    // Store connection
    await supabaseAdmin
      .from('platform_connections')
      .upsert({
        user_id:           userId,
        platform:          'tiktok',
        access_token:      encryptToken(access_token),
        refresh_token:     refresh_token ? encryptToken(refresh_token) : null,
        token_expires_at:  expiresAt,
        platform_user_id:  open_id,
        platform_username: username,
        connected_at:      new Date().toISOString()
      }, { onConflict: 'user_id,platform' });

    console.log(`[Publish] TikTok "${username}" connected for user ${userId}`);
    return finish({ status: 'connected', platforms: ['tiktok'] });

  } catch (err) {
    console.error('[Publish] TikTok OAuth callback error:', err.response?.data || err.message);
    return finish({ status: 'error', message: 'TikTok connection failed. Please try again.' });
  }
});

// ----------------------------------------------------------------
// GET /publish/oauth/linkedin/callback
//
// Called by LinkedIn after the user grants permission.
// Exchanges code for access token (60-day lifetime).
// ----------------------------------------------------------------
router.get('/oauth/linkedin/callback', authLimiter, async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  const finish = (result) => {
    res.cookie('sb_platform_oauth', JSON.stringify(result), {
      maxAge: 30000, httpOnly: false, sameSite: 'lax'
    });
    return res.redirect(`${FRONTEND_URL}/#settings`);
  };

  if (oauthError || !code || !state) {
    return finish({ status: 'cancelled' });
  }

  try {
    // Verify the OAuth state nonce — same pattern as Meta callback
    const userId = await cacheGet(`oauth_nonce:${state}`);
    if (!userId) throw new Error('Invalid or expired OAuth state. Please try connecting again.');
    await cacheDel(`oauth_nonce:${state}`);

    // Exchange code for access token
    const tokenRes = await axios.post(
      'https://www.linkedin.com/oauth/v2/accessToken',
      new URLSearchParams({
        grant_type:    'authorization_code',
        code,
        redirect_uri:  LINKEDIN_REDIRECT_URI,
        client_id:     process.env.LINKEDIN_CLIENT_ID,
        client_secret: process.env.LINKEDIN_CLIENT_SECRET
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 30_000 }
    );

    const accessToken = tokenRes.data.access_token;
    const expiresIn   = tokenRes.data.expires_in || 5184000; // 60 days default
    const expiresAt   = new Date(Date.now() + expiresIn * 1000).toISOString();
    if (!accessToken) throw new Error('LinkedIn returned no access_token');

    // Fetch user profile for ID and name
    const meRes = await axios.get('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 30_000
    });
    const linkedinUser = meRes.data;

    await supabaseAdmin
      .from('platform_connections')
      .upsert({
        user_id:           userId,
        platform:          'linkedin',
        access_token:      encryptToken(accessToken),
        refresh_token:     tokenRes.data.refresh_token ? encryptToken(tokenRes.data.refresh_token) : null,
        token_expires_at:  expiresAt,
        platform_user_id:  linkedinUser.sub,
        platform_username: linkedinUser.name || linkedinUser.email || 'LinkedIn User',
        connected_at:      new Date().toISOString()
      }, { onConflict: 'user_id,platform' });

    console.log(`[Publish] LinkedIn "${linkedinUser.name}" connected for user ${userId}`);
    return finish({ status: 'connected', platforms: ['linkedin'] });

  } catch (err) {
    console.error('[Publish] LinkedIn OAuth callback error:', err.response?.data || err.message);
    return finish({ status: 'error', message: 'LinkedIn connection failed. Please try again.' });
  }
});

// ----------------------------------------------------------------
// GET /publish/oauth/x/callback
//
// Called by X (Twitter) after the user grants permission.
// X uses OAuth 2.0 with PKCE — the code_verifier is stored in Redis
// during the start flow and retrieved here for token exchange.
// ----------------------------------------------------------------
router.get('/oauth/x/callback', authLimiter, async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  const finish = (result) => {
    res.cookie('sb_platform_oauth', JSON.stringify(result), {
      maxAge: 30000, httpOnly: false, sameSite: 'lax'
    });
    return res.redirect(`${FRONTEND_URL}/#settings`);
  };

  if (oauthError || !code || !state) {
    return finish({ status: 'cancelled' });
  }

  try {
    // Verify the OAuth state nonce — same pattern as Meta callback.
    // The nonce is cryptographically random, so it's safe to use as the PKCE key too.
    const userId = await cacheGet(`oauth_nonce:${state}`);
    if (!userId) throw new Error('Invalid or expired OAuth state. Please try connecting again.');
    await cacheDel(`oauth_nonce:${state}`);

    // Retrieve the PKCE code_verifier stored during /start (keyed by the same nonce)
    const codeVerifier = await cacheGet(`x_pkce:${state}`);
    if (!codeVerifier) throw new Error('PKCE session expired. Please try connecting again.');
    await cacheDel(`x_pkce:${state}`);

    // Exchange code for access token using Basic auth (client_id:client_secret)
    const basicAuth = Buffer.from(`${process.env.X_CLIENT_ID}:${process.env.X_CLIENT_SECRET}`).toString('base64');

    const tokenRes = await axios.post(
      'https://api.x.com/2/oauth2/token',
      new URLSearchParams({
        code,
        grant_type:     'authorization_code',
        redirect_uri:   X_REDIRECT_URI,
        code_verifier:  codeVerifier
      }),
      {
        headers: {
          'Content-Type':  'application/x-www-form-urlencoded',
          Authorization:   `Basic ${basicAuth}`
        },
        timeout: 30_000
      }
    );

    const accessToken  = tokenRes.data.access_token;
    const refreshToken = tokenRes.data.refresh_token;
    const expiresIn    = tokenRes.data.expires_in || 7200; // 2 hours default
    const expiresAt    = new Date(Date.now() + expiresIn * 1000).toISOString();
    if (!accessToken) throw new Error('X returned no access_token');

    // Fetch user info
    const meRes = await axios.get('https://api.x.com/2/users/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 30_000
    });
    const xUser = meRes.data?.data;

    await supabaseAdmin
      .from('platform_connections')
      .upsert({
        user_id:           userId,
        platform:          'x',
        access_token:      encryptToken(accessToken),
        refresh_token:     refreshToken ? encryptToken(refreshToken) : null,
        token_expires_at:  expiresAt,
        platform_user_id:  xUser?.id || null,
        platform_username: xUser?.username || 'X User',
        connected_at:      new Date().toISOString()
      }, { onConflict: 'user_id,platform' });

    console.log(`[Publish] X "@${xUser?.username}" connected for user ${userId}`);
    return finish({ status: 'connected', platforms: ['x'] });

  } catch (err) {
    console.error('[Publish] X OAuth callback error:', err.response?.data || err.message);
    return finish({ status: 'error', message: 'X connection failed. Please try again.' });
  }
});

// ================================================================
// AUTH MIDDLEWARE — all routes below this line require a logged-in user
// ================================================================
// Apply auth + tenancy to all routes in this file
router.use(requireAuth, enforceTenancy);

// ----------------------------------------------------------------
// GET /publish/oauth/meta/pages?session=<sessionId>
//
// Returns the list of Facebook Pages stored in the Redis page-picker
// session, without exposing any access tokens to the frontend.
// The frontend calls this to populate the page picker modal.
// ----------------------------------------------------------------
router.get('/oauth/meta/pages', standardLimiter, async (req, res) => {
  const { session } = req.query;

  if (!session) {
    return res.status(400).json({ error: 'session is required' });
  }

  const data = await cacheGet(`meta_page_select:${session}`);

  if (!data) {
    return res.status(404).json({ error: 'Session expired or not found. Please connect again.' });
  }

  // Make sure the session belongs to the currently logged-in user
  if (data.userId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Return page names + whether they have a linked Instagram account.
  // Access tokens are NEVER sent to the frontend.
  const pageOptions = data.pages.map(p => ({
    id:            p.id,
    name:          p.name,
    has_instagram: !!(p.instagram_business_account?.id)
  }));

  return res.json({ pages: pageOptions });
});

// ----------------------------------------------------------------
// POST /publish/oauth/meta/select-page
//
// Called by the frontend page picker modal after the user chooses
// which Facebook Page to connect.
//
// Body: { session_id, page_id }
//
// Retrieves the stored page data from Redis, saves the Facebook
// connection (and Instagram if linked), then clears the session.
// ----------------------------------------------------------------
router.post('/oauth/meta/select-page', standardLimiter, async (req, res) => {
  const { session_id, page_id } = req.body;

  if (!session_id || !page_id) {
    return res.status(400).json({ error: 'session_id and page_id are required' });
  }

  const data = await cacheGet(`meta_page_select:${session_id}`);

  if (!data) {
    return res.status(404).json({ error: 'Session expired. Please start the connection again.' });
  }

  if (data.userId !== req.user.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const page = data.pages.find(p => p.id === page_id);
  if (!page) {
    return res.status(404).json({ error: 'Page not found in session.' });
  }

  // Consume the session immediately — prevents reuse
  await cacheDel(`meta_page_select:${session_id}`);

  // Reuse the same helper that the OAuth callback uses
  return saveMetaPageConnection(req.user.id, page, (result) => {
    return res.json(result);
  });
});

// ----------------------------------------------------------------
// GET /publish/queue
// Returns posts in statuses: approved, scheduled, publishing, failed
// plus recently published (last 7 days) so the user can see what went out.
// ----------------------------------------------------------------
router.get('/queue', standardLimiter, async (req, res) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await req.db
      .from('posts')
      .select('id, platform, hook, caption, status, scheduled_at, published_at, error_message, created_at')
      .or(`status.in.(approved,scheduled,publishing,failed,paused),and(status.eq.published,published_at.gte.${sevenDaysAgo})`)
      .order('scheduled_at', { ascending: true, nullsFirst: false })
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);

    return res.json({ posts: data || [] });

  } catch (err) {
    console.error('[Publish] Queue fetch error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch publishing queue' });
  }
});

// ----------------------------------------------------------------
// DELETE /publish/queue/:id
// Cancels a queued post and returns it to draft status so the user
// can edit and re-schedule it. Works for scheduled, failed, or approved posts.
// ----------------------------------------------------------------
router.delete('/queue/:id', standardLimiter, async (req, res) => {
  try {
    const { data: post, error: fetchError } = await req.db
      .from('posts')
      .select('id, status')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    if (!['approved', 'scheduled', 'failed', 'publishing', 'paused'].includes(post.status)) {
      return res.status(400).json({
        error: `Cannot cancel a post with status "${post.status}".`
      });
    }

    const { error } = await req.db
      .from('posts')
      .update({ status: 'draft', scheduled_at: null, error_message: null })
      .eq('id', req.params.id);

    if (error) throw new Error(error.message);

    return res.json({ message: 'Post cancelled and returned to drafts' });

  } catch (err) {
    console.error('[Publish] Queue remove error:', err.message);
    return res.status(500).json({ error: 'Failed to cancel post' });
  }
});

// ----------------------------------------------------------------
// GET /publish/platforms
// Lists all connected social media platforms for the current user.
// Tokens are NOT returned — only metadata.
// ----------------------------------------------------------------
router.get('/platforms', standardLimiter, async (req, res) => {
  try {
    const { data, error } = await req.db
      .from('platform_connections')
      .select('id, platform, platform_username, platform_user_id, token_expires_at, connected_at')
      .order('platform', { ascending: true });

    if (error) throw new Error(error.message);

    return res.json({ connections: data || [] });

  } catch (err) {
    console.error('[Publish] Platforms fetch error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch platform connections' });
  }
});

// ----------------------------------------------------------------
// POST /publish/platforms/connect
// Saves (or updates) OAuth credentials for a social media platform.
//
// Body:
//   platform          — one of: instagram | facebook | tiktok | linkedin | x | threads | whatsapp | telegram
//   access_token      — plain-text OAuth access token (will be AES-encrypted before storage)
//   refresh_token     — optional refresh token
//   token_expires_at  — ISO datetime when access_token expires (optional)
//   platform_user_id  — the user's ID on that platform
//   platform_username — the user's handle/username on that platform
//
// In a full implementation, this endpoint is called at the end of the
// OAuth callback flow, not directly from the frontend.
// ----------------------------------------------------------------
router.post('/platforms/connect', standardLimiter, checkLimit('platforms_connected'), async (req, res) => {
  const VALID_PLATFORMS = ['instagram', 'facebook', 'tiktok', 'linkedin', 'x', 'threads', 'whatsapp', 'telegram'];
  const { platform, access_token, refresh_token, token_expires_at, platform_user_id, platform_username } = req.body;

  if (!platform || !VALID_PLATFORMS.includes(platform)) {
    return res.status(400).json({
      error: `platform must be one of: ${VALID_PLATFORMS.join(', ')}`
    });
  }

  if (!access_token) {
    return res.status(400).json({ error: 'access_token is required' });
  }

  try {
    // Encrypt both tokens before storing
    const encryptedAccess  = encryptToken(access_token);
    const encryptedRefresh = refresh_token ? encryptToken(refresh_token) : null;

    // Upsert — one row per user per platform
    const { data, error } = await supabaseAdmin
      .from('platform_connections')
      .upsert({
        user_id:           req.user.id,
        platform,
        access_token:      encryptedAccess,
        refresh_token:     encryptedRefresh,
        token_expires_at:  token_expires_at || null,
        platform_user_id:  platform_user_id || null,
        platform_username: platform_username || null
      }, { onConflict: 'user_id,platform' })
      .select('id, platform, platform_username, connected_at')
      .single();

    if (error) throw new Error(error.message);

    return res.json({ message: `${platform} connected successfully`, connection: data });

  } catch (err) {
    console.error('[Publish] Platform connect error:', err.message);
    return res.status(500).json({ error: 'Failed to save platform connection' });
  }
});

// ----------------------------------------------------------------
// DELETE /publish/platforms/:platform
// Disconnects a social media platform. Posts already published
// are not affected — only future publishing is disabled.
// ----------------------------------------------------------------
router.delete('/platforms/:platform', standardLimiter, async (req, res) => {
  const VALID_PLATFORMS = ['instagram', 'facebook', 'tiktok', 'linkedin', 'x', 'threads', 'whatsapp', 'telegram'];

  if (!VALID_PLATFORMS.includes(req.params.platform)) {
    return res.status(400).json({ error: 'Unknown platform' });
  }

  try {
    const { error } = await req.db
      .from('platform_connections')
      .delete()
      .eq('platform', req.params.platform);

    if (error) throw new Error(error.message);

    return res.json({ message: `${req.params.platform} disconnected` });

  } catch (err) {
    console.error('[Publish] Platform disconnect error:', err.message);
    return res.status(500).json({ error: 'Failed to disconnect platform' });
  }
});

// ----------------------------------------------------------------
// POST /publish/:postId
// Immediately publishes an approved post (bypasses the scheduler).
// Use this for the "Publish Now" button in the UI.
//
// The post must be in 'approved' status.
// Requires the platform to be connected (POST /publish/platforms/connect).
// ----------------------------------------------------------------
router.post('/:postId', standardLimiter, async (req, res) => {
  try {
    // Verify the post exists and belongs to this user
    const { data: post, error: fetchError } = await req.db
      .from('posts')
      .select('id, platform, hook, caption, hashtags, cta, status, media_id')
      .eq('id', req.params.postId)
      .single();

    if (fetchError || !post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    if (post.status !== 'approved') {
      return res.status(400).json({
        error: `Post must be in "approved" status to publish. Current status: "${post.status}". Use POST /posts/:id/approve first.`
      });
    }

    // Look up the platform connection
    const { data: connection, error: connError } = await supabaseAdmin
      .from('platform_connections')
      .select('*')
      .eq('user_id', req.user.id)
      .eq('platform', post.platform)
      .single();

    if (connError || !connection) {
      return res.status(400).json({
        error: `No ${post.platform} account connected. Go to Settings → Connected Platforms to connect your account.`
      });
    }

    // If the post references a media item, resolve the UUID → cloud URL.
    // Platform APIs need an actual URL, not a DB UUID reference.
    if (post.media_id) {
      const { data: mediaItem } = await supabaseAdmin
        .from('media_items')
        .select('cloud_url')
        .eq('id', post.media_id)
        .single();
      if (mediaItem?.cloud_url) post.media_url = mediaItem.cloud_url;
    }

    // Mark as publishing to prevent duplicate submissions
    await req.db
      .from('posts')
      .update({ status: 'publishing' })
      .eq('id', post.id);

    // Attempt to publish (platform stubs will throw until credentials are configured)
    let platformPostId;
    try {
      const result = await publish(post, connection);
      platformPostId = result.platformPostId;
    } catch (publishErr) {
      // Revert status back to approved so user can try again
      await req.db
        .from('posts')
        .update({ status: 'approved', error_message: publishErr.message })
        .eq('id', post.id);

      return res.status(502).json({ error: publishErr.message });
    }

    // Success — update post record
    await req.db
      .from('posts')
      .update({
        status:           'published',
        platform_post_id: platformPostId,
        published_at:     new Date().toISOString(),
        error_message:    null
      })
      .eq('id', post.id);

    return res.json({
      message:        `Post published to ${post.platform}`,
      platformPostId
    });

  } catch (err) {
    console.error('[Publish] Immediate publish error:', err.message);
    return res.status(500).json({ error: 'Failed to publish post' });
  }
});

// ----------------------------------------------------------------
// POST /publish/oauth/meta/start
//
// Generates the Facebook/Meta OAuth URL and returns it to the frontend.
// The frontend then does window.location.href = authUrl to start the flow.
// On success, Meta redirects to /publish/oauth/meta/callback.
//
// The same OAuth flow connects BOTH Facebook and Instagram because:
//   - Facebook Login grants access to the user's Pages
//   - Instagram Business Accounts are linked to those Pages
//   - The callback fetches both and stores them separately
//
// Required .env: META_APP_ID, META_APP_SECRET
// Required Meta App setup: Facebook Login product added, redirect URI registered
// ----------------------------------------------------------------
router.post('/oauth/meta/start', standardLimiter, checkLimit('platforms_connected'), (req, res) => {
  if (!process.env.META_APP_ID || process.env.META_APP_ID === 'your_meta_app_id') {
    return res.status(501).json({
      error: 'Meta/Facebook is not set up yet. Add META_APP_ID and META_APP_SECRET to your .env file, then rebuild the Docker container.'
    });
  }

  // Generate a cryptographic nonce for the state parameter.
  // The callback looks up the nonce in Redis to get the userId — this prevents
  // state injection attacks where an attacker forges a state with another user's ID.
  const state = crypto.randomBytes(32).toString('hex');
  cacheSet(`oauth_nonce:${state}`, req.user.id, 600); // 10-minute TTL

  // Request scopes directly — no config_id needed.
  // pages_show_list       — list the user's Facebook Pages
  // pages_read_engagement — read page engagement (also enables IG account lookup)
  // pages_manage_posts    — create/publish posts to a Page (text, image, AND video
  //                         via the Uploads API once the app is in Live mode)
  // Note: publish_video does not exist as a use case for Business Apps — pages_manage_posts
  //       covers video publishing once the app is published to Live mode.
  const scopes = [
    'pages_show_list',
    'pages_read_engagement',
    'pages_read_user_content',      // Required to read user comments on Page posts (Private Replies needs this)
    'pages_manage_posts',
    'pages_manage_metadata',        // Required for subscribing Page to app webhooks
    'pages_messaging',              // Facebook + Instagram DM automation
    'instagram_basic',
    'instagram_content_publish',
    'instagram_manage_comments',    // Instagram comment monitoring
    'instagram_manage_messages'     // Instagram DM automation
  ].join(',');

  const authUrl = `https://www.facebook.com/v21.0/dialog/oauth` +
    `?client_id=${encodeURIComponent(process.env.META_APP_ID)}` +
    `&redirect_uri=${encodeURIComponent(META_REDIRECT_URI)}` +
    `&scope=${encodeURIComponent(scopes)}` +
    `&state=${state}` +
    `&response_type=code` +
    // rerequest forces Facebook to show the full permissions + page selection dialog
    // even if the user has previously connected this app. Without this, Facebook shows
    // a quick "Reconnect" shortcut that skips the page selection screen.
    `&auth_type=rerequest`;

  return res.json({ authUrl });
});

// ----------------------------------------------------------------
// POST /publish/oauth/threads/start
//
// Generates the Threads OAuth URL.
// Uses the same META_APP_ID/SECRET but authenticates through threads.net.
//
// Required .env: META_APP_ID, META_APP_SECRET
// Required Meta App setup: Threads API product added, redirect URI registered
// ----------------------------------------------------------------
router.post('/oauth/threads/start', standardLimiter, checkLimit('platforms_connected'), (req, res) => {
  // Threads OAuth uses the Threads-specific App ID (from Threads API settings in Meta portal).
  // The authorize URL must go to www.threads.com directly (threads.net 301-redirects and loses context).
  const threadsAppId = process.env.THREADS_APP_ID || process.env.META_APP_ID;
  if (!threadsAppId) {
    return res.status(501).json({
      error: 'Threads is not set up yet. Add THREADS_APP_ID to your .env file.'
    });
  }

  const state = crypto.randomBytes(32).toString('hex');
  cacheSet(`oauth_nonce:${state}`, req.user.id, 600);

  // URL-encode the scope (comma-separated) to prevent issues during redirects
  const authUrl = `https://www.threads.com/oauth/authorize` +
    `?client_id=${encodeURIComponent(threadsAppId)}` +
    `&redirect_uri=${encodeURIComponent(THREADS_REDIRECT_URI)}` +
    `&scope=${encodeURIComponent('threads_basic,threads_content_publish')}` +
    `&response_type=code` +
    `&state=${state}`;

  return res.json({ authUrl });
});

// ----------------------------------------------------------------
// POST /publish/oauth/tiktok/start
//
// Generates the TikTok OAuth URL.
// Required .env: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET
// Required TikTok setup: Login Kit product enabled, redirect URI registered
// ----------------------------------------------------------------
router.post('/oauth/tiktok/start', standardLimiter, checkLimit('platforms_connected'), (req, res) => {
  if (!process.env.TIKTOK_CLIENT_KEY) {
    return res.status(501).json({
      error: 'TikTok is not set up yet. Add TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET to your .env file.'
    });
  }

  const state = crypto.randomBytes(32).toString('hex');
  cacheSet(`oauth_nonce:${state}`, req.user.id, 600);

  const authUrl = `https://www.tiktok.com/v2/auth/authorize/` +
    `?client_key=${encodeURIComponent(process.env.TIKTOK_CLIENT_KEY)}` +
    `&redirect_uri=${encodeURIComponent(TIKTOK_REDIRECT_URI)}` +
    `&scope=user.info.basic,video.publish` +
    `&response_type=code` +
    `&state=${state}`;

  return res.json({ authUrl });
});

// ----------------------------------------------------------------
// POST /publish/oauth/linkedin/start
//
// Generates the LinkedIn OAuth URL.
// Required .env: LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET
// Required LinkedIn setup: Sign In with LinkedIn + Share on LinkedIn products added
// ----------------------------------------------------------------
router.post('/oauth/linkedin/start', standardLimiter, checkLimit('platforms_connected'), (req, res) => {
  if (!process.env.LINKEDIN_CLIENT_ID) {
    return res.status(501).json({
      error: 'LinkedIn is not set up yet. Add LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET to your .env file.'
    });
  }

  const state = crypto.randomBytes(32).toString('hex');
  cacheSet(`oauth_nonce:${state}`, req.user.id, 600);

  const authUrl = `https://www.linkedin.com/oauth/v2/authorization` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(process.env.LINKEDIN_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(LINKEDIN_REDIRECT_URI)}` +
    `&scope=${encodeURIComponent('openid profile w_member_social')}` +
    `&state=${state}`;

  return res.json({ authUrl });
});

// ----------------------------------------------------------------
// POST /publish/oauth/x/start
//
// Generates the X (Twitter) OAuth 2.0 URL with PKCE.
// X requires PKCE (Proof Key for Code Exchange) — we generate a
// code_verifier, hash it to a code_challenge, and store the verifier
// in Redis so the callback can use it for token exchange.
//
// Required .env: X_CLIENT_ID, X_CLIENT_SECRET
// ----------------------------------------------------------------
router.post('/oauth/x/start', standardLimiter, checkLimit('platforms_connected'), async (req, res) => {
  if (!process.env.X_CLIENT_ID) {
    return res.status(501).json({
      error: 'X (Twitter) is not set up yet. Add X_CLIENT_ID and X_CLIENT_SECRET to your .env file.'
    });
  }

  // Generate cryptographic nonce for state (same pattern as all other platforms)
  const state = crypto.randomBytes(32).toString('hex');
  await cacheSet(`oauth_nonce:${state}`, req.user.id, 600);

  // Generate PKCE code_verifier (43-128 chars, URL-safe)
  const codeVerifier = crypto.randomBytes(32).toString('base64url');

  // Generate code_challenge = base64url(sha256(code_verifier))
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  // Store code_verifier in Redis (5 min TTL) keyed by the nonce (not userId)
  await cacheSet(`x_pkce:${state}`, codeVerifier, 300);

  const authUrl = `https://x.com/i/oauth2/authorize` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(process.env.X_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(X_REDIRECT_URI)}` +
    `&scope=${encodeURIComponent('tweet.read tweet.write users.read offline.access')}` +
    `&state=${state}` +
    `&code_challenge=${codeChallenge}` +
    `&code_challenge_method=S256`;

  return res.json({ authUrl });
});

// ----------------------------------------------------------------
// POST /publish/platforms/connect-token
//
// For platforms that don't use OAuth (WhatsApp, Telegram) — the user
// enters a bot token + channel ID directly in the UI, and the frontend
// sends them here. This is separate from the OAuth /platforms/connect
// endpoint because it's user-initiated with manual credentials.
//
// Body:
//   platform          — 'whatsapp' or 'telegram'
//   access_token      — WhatsApp phone number ID access token or Telegram bot token
//   platform_user_id  — WhatsApp phone number ID or Telegram channel @username / chat_id
//   platform_username — display name for the settings UI
// ----------------------------------------------------------------
router.post('/platforms/connect-token', standardLimiter, checkLimit('platforms_connected'), async (req, res) => {
  const VALID = ['whatsapp', 'telegram'];
  const { platform, access_token, platform_user_id, platform_username } = req.body;

  if (!platform || !VALID.includes(platform)) {
    return res.status(400).json({ error: `platform must be one of: ${VALID.join(', ')}` });
  }
  if (!access_token) {
    return res.status(400).json({ error: 'access_token is required' });
  }
  if (!platform_user_id) {
    return res.status(400).json({
      error: platform === 'telegram'
        ? 'Channel username or chat ID is required (e.g. @mychannel)'
        : 'WhatsApp Phone Number ID is required'
    });
  }

  try {
    // Verify the token works before saving
    if (platform === 'telegram') {
      const verifyRes = await axios.get(
        `https://api.telegram.org/bot${access_token}/getMe`,
        { timeout: 10_000 }
      );
      if (!verifyRes.data?.ok) {
        return res.status(400).json({ error: 'Invalid Telegram bot token. Check your token and try again.' });
      }
    }

    await supabaseAdmin
      .from('platform_connections')
      .upsert({
        user_id:           req.user.id,
        platform,
        access_token:      encryptToken(access_token),
        refresh_token:     null,
        token_expires_at:  null,  // Bot tokens don't expire
        platform_user_id:  platform_user_id,
        platform_username: platform_username || (platform === 'telegram' ? 'Telegram Channel' : 'WhatsApp'),
        connected_at:      new Date().toISOString()
      }, { onConflict: 'user_id,platform' });

    console.log(`[Publish] ${platform} connected for user ${req.user.id}`);
    return res.json({ status: 'connected', platforms: [platform] });

  } catch (err) {
    console.error(`[Publish] ${platform} connect-token error:`, err.response?.data || err.message);
    return res.status(500).json({ error: `Failed to connect ${platform}. Check your credentials and try again.` });
  }
});

module.exports = router;
