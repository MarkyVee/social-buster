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

const { requireAuth }    = require('../middleware/auth');
const { enforceTenancy } = require('../middleware/tenancy');
const { standardLimiter } = require('../middleware/rateLimit');
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
const META_REDIRECT_URI    = process.env.META_REDIRECT_URI    || 'http://localhost:3001/publish/oauth/meta/callback';
const THREADS_REDIRECT_URI = process.env.THREADS_REDIRECT_URI || 'http://localhost:3001/publish/oauth/threads/callback';
const FRONTEND_URL         = process.env.FRONTEND_URL         || 'http://localhost:3001';

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
router.get('/oauth/meta/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  // Helper: set result cookie and redirect back to the Settings page
  const finish = (result) => {
    res.cookie('sb_platform_oauth', JSON.stringify(result), {
      maxAge:   30000,   // 30 seconds — just long enough to read on redirect
      httpOnly: false,   // Frontend JS must be able to read it
      sameSite: 'lax'
    });
    return res.redirect(`${FRONTEND_URL}/#settings`);
  };

  if (oauthError || !code || !state) {
    return finish({ status: 'cancelled' });
  }

  try {
    // Decode the userId we embedded in the state parameter when the flow started
    const userId = Buffer.from(state, 'base64').toString('utf8');
    if (!userId || userId.length < 10) throw new Error('Invalid state parameter');

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
router.get('/oauth/threads/callback', async (req, res) => {
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
    const userId = Buffer.from(state, 'base64').toString('utf8');
    if (!userId || userId.length < 10) throw new Error('Invalid state parameter');

    // Step 1: Exchange code for short-lived Threads access token
    const tokenRes = await axios.post(
      'https://graph.threads.net/oauth/access_token',
      new URLSearchParams({
        client_id:     process.env.META_APP_ID,
        client_secret: process.env.META_APP_SECRET,
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
        client_secret: process.env.META_APP_SECRET,
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
      .or(`status.in.(approved,scheduled,publishing,failed),and(status.eq.published,published_at.gte.${sevenDaysAgo})`)
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

    if (!['approved', 'scheduled', 'failed'].includes(post.status)) {
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
//   platform          — one of: instagram | facebook | tiktok | linkedin | x | threads | youtube
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
  const VALID_PLATFORMS = ['instagram', 'facebook', 'tiktok', 'linkedin', 'x', 'threads', 'youtube'];
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
  const VALID_PLATFORMS = ['instagram', 'facebook', 'tiktok', 'linkedin', 'x', 'threads', 'youtube'];

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
router.post('/oauth/meta/start', standardLimiter, (req, res) => {
  if (!process.env.META_APP_ID || process.env.META_APP_ID === 'your_meta_app_id') {
    return res.status(501).json({
      error: 'Meta/Facebook is not set up yet. Add META_APP_ID and META_APP_SECRET to your .env file, then rebuild the Docker container.'
    });
  }

  // Embed the userId in state so the callback knows which user is connecting
  const state = Buffer.from(req.user.id).toString('base64');

  // Request scopes directly — no config_id needed.
  // pages_show_list       — list the user's Facebook Pages
  // pages_read_engagement — read page engagement (also enables IG account lookup)
  // pages_manage_posts    — create/publish posts to a Page (text, image, AND video
  //                         via the Uploads API once the app is in Live mode)
  // Note: publish_video does not exist as a use case for Business Apps — pages_manage_posts
  //       covers video publishing once the app is published to Live mode.
  const scopes = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'].join(',');

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
router.post('/oauth/threads/start', standardLimiter, (req, res) => {
  if (!process.env.META_APP_ID || process.env.META_APP_ID === 'your_meta_app_id') {
    return res.status(501).json({
      error: 'Threads is not set up yet. Add META_APP_ID and META_APP_SECRET to your .env file, then rebuild the Docker container.'
    });
  }

  const state = Buffer.from(req.user.id).toString('base64');

  const authUrl = `https://threads.net/oauth/authorize` +
    `?client_id=${encodeURIComponent(process.env.META_APP_ID)}` +
    `&redirect_uri=${encodeURIComponent(THREADS_REDIRECT_URI)}` +
    `&scope=threads_basic,threads_content_publish` +
    `&response_type=code` +
    `&state=${state}`;

  return res.json({ authUrl });
});

module.exports = router;
