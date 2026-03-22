/**
 * routes/media.js
 *
 * Media library management.
 * Users can catalog their cloud media and add items manually by URL.
 *
 * Routes:
 *   GET    /media                    - List catalogued media (with optional filters)
 *   POST   /media/add                - Manually add a media item by URL
 *   POST   /media/scan               - Trigger a background scan of connected cloud storage
 *   GET    /media/providers          - List cloud storage connections for this user
 *   POST   /media/connect/:provider  - Connect a cloud storage provider
 *   DELETE /media/connect/:provider  - Disconnect a cloud storage provider
 *   POST   /media/match-clips        - Find best pre-analysed segments for a brief (no LLM)
 *   GET    /media/:id                - Get a single media item
 *   GET    /media/:id/segments       - Get all pre-analysed video segments for an item
 *   PUT    /media/:id                - Update tags/metadata on a media item
 *   DELETE /media/:id                - Remove an item from the catalog (not from cloud)
 *
 * Key rules:
 *   - We NEVER store the actual media files — only metadata + the cloud URL.
 *   - All queries are scoped to req.user.id (RLS enforces this at DB level too).
 *   - FFmpeg trimming happens at publish time, not here.
 */

const express = require('express');
const router  = express.Router();

const { requireAuth }    = require('../middleware/auth');
const { enforceTenancy } = require('../middleware/tenancy');
const { standardLimiter, aiLimiter, videoLimiter } = require('../middleware/rateLimit');
const { checkLimit }     = require('../middleware/checkLimit');
const { supabaseAdmin }  = require('../services/supabaseService');
const { encryptToken }   = require('../services/tokenEncryption');
const { cacheSet, cacheGet, cacheDel } = require('../services/redisService');
const { loadPrompt }     = require('../services/promptLoader');
const crypto             = require('crypto');

// Where Google should redirect the user after they log in.
// Must exactly match what is registered in Google Cloud Console.
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3001/media/oauth/google_drive/callback';
const FRONTEND_URL        = process.env.FRONTEND_URL        || 'http://localhost:3001';

// ----------------------------------------------------------------
// GET /media/oauth/google_drive/callback
//
// UNPROTECTED — Google redirects the user's browser here after they
// approve access. This route MUST be declared BEFORE router.use()
// below, otherwise the auth middleware would block it.
//
// Flow:
//   1. Google sends ?code and ?state (state = base64-encoded userId)
//   2. We exchange the code for OAuth tokens
//   3. We store the encrypted tokens in cloud_connections
//   4. We set a short-lived cookie so the frontend knows it worked
//   5. We redirect the user back to the Media Library page
// ----------------------------------------------------------------
router.get('/oauth/google_drive/callback', async (req, res) => {
  const { code, state, error: oauthError } = req.query;

  // Helper to set result cookie and redirect back to frontend
  const finish = (status, email = '') => {
    res.cookie('sb_oauth', JSON.stringify({ provider: 'google_drive', status, email }), {
      maxAge:   30000,   // Cookie expires in 30 seconds — just long enough to read on redirect
      httpOnly: false,   // Must be readable by JavaScript on the frontend
      sameSite: 'lax'
    });
    return res.redirect(`${FRONTEND_URL}/#media`);
  };

  if (oauthError || !code || !state) {
    return finish('cancelled');
  }

  try {
    // Look up the nonce in Redis to get the userId — this validates that the OAuth
    // flow was legitimately started by our server and prevents state injection attacks.
    // A plain base64 userId in state would let anyone connect their Google Drive to
    // another user's account by crafting a malicious state parameter.
    const userId = await cacheGet(`oauth_nonce:${state}`);
    if (!userId) throw new Error('Invalid or expired OAuth state. Please try connecting again.');

    // Delete the nonce immediately — each OAuth flow can only be completed once
    await cacheDel(`oauth_nonce:${state}`);

    // Exchange the one-time code for access + refresh tokens
    const { google } = require('googleapis');
    const client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      GOOGLE_REDIRECT_URI
    );
    const { tokens } = await client.getToken(code);

    // Fetch the user's Google account email so we can show it in the UI
    client.setCredentials(tokens);
    const oauth2Api = google.oauth2({ version: 'v2', auth: client });
    const { data: googleUser } = await oauth2Api.userinfo.get();

    // Store encrypted tokens — upsert so reconnecting replaces the old record
    await supabaseAdmin
      .from('cloud_connections')
      .upsert({
        user_id:          userId,
        provider:         'google_drive',
        access_token:     encryptToken(tokens.access_token),
        refresh_token:    tokens.refresh_token ? encryptToken(tokens.refresh_token) : null,
        token_expires_at: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
        provider_email:   googleUser.email || null,
        connected_at:     new Date().toISOString()
      }, { onConflict: 'user_id,provider' });

    return finish('connected', googleUser.email || '');

  } catch (err) {
    console.error('[Media] Google OAuth callback error:', err.message);
    return finish('error');
  }
});

// ----------------------------------------------------------------
// GET /media/proxy
// UNPROTECTED — proxies Supabase storage images through localhost so
// ad blockers never see a third-party request. Must be declared BEFORE
// router.use(requireAuth) below, otherwise auth middleware blocks it
// (img tags can't send Authorization headers).
//
// Security: only proxies URLs from our own Supabase project hostname.
// Any other domain is rejected 403 — prevents open-proxy abuse.
// ----------------------------------------------------------------
router.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;

  if (!targetUrl) {
    return res.status(400).json({ error: 'url query parameter is required' });
  }

  const supabaseHost = new URL(process.env.SUPABASE_URL).hostname;
  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch (_) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (parsedTarget.hostname !== supabaseHost) {
    return res.status(403).json({ error: 'Proxy only allowed for project storage URLs' });
  }

  try {
    const axios = require('axios');
    const upstream = await axios.get(targetUrl, {
      responseType: 'stream',
      timeout: 15000,
      headers: {
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    });

    res.setHeader('Content-Type', upstream.headers['content-type'] || 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    if (upstream.headers['content-length']) {
      res.setHeader('Content-Length', upstream.headers['content-length']);
    }

    upstream.data.pipe(res);
  } catch (err) {
    const status = err.response?.status || 502;
    return res.status(status).json({ error: `Failed to proxy image: ${err.message}` });
  }
});

// ----------------------------------------------------------------
// GET /media/:id/stream?token=<stream-token>
//
// UNPROTECTED — must be declared BEFORE router.use(requireAuth) below.
// The browser's <video> element makes plain GET requests and cannot
// attach an Authorization header. Auth is handled by the short-lived
// HMAC-signed token in the query string (issued by POST /:id/stream-token).
//
// Streaming proxy for video playback in the browser.
// Forwards byte-range requests to the original source (Google Drive,
// or direct cloud URL) so the HTML5 <video> element can seek and play.
//
// How it works:
//   1. Frontend calls POST /media/:id/stream-token (authenticated)
//   2. Frontend sets  <video src="/media/:id/stream?token=HMAC_TOKEN">
//   3. Browser sends Range: bytes=X-Y headers as the user seeks —
//      each range request carries the same token in the query string.
// ----------------------------------------------------------------
router.get('/:id/stream', standardLimiter, async (req, res) => {
  try {
    // Validate the stateless HMAC stream token (no Redis needed)
    const rawToken = req.query.token;
    if (!rawToken) return res.status(401).json({ error: 'Missing stream token' });

    const tokenData = verifyStreamToken(rawToken);
    if (!tokenData) return res.status(401).json({ error: 'Stream token expired or invalid' });

    const tokenUserId = tokenData.userId;
    const tokenItemId = tokenData.mediaItemId;

    if (tokenItemId !== req.params.id) {
      return res.status(403).json({ error: 'Token does not match this media item' });
    }

    const { data: item, error: fetchError } = await supabaseAdmin
      .from('media_items')
      .select('id, filename, cloud_url, cloud_file_id, cloud_provider, file_type')
      .eq('id', req.params.id)
      .eq('user_id', tokenUserId)
      .single();

    if (fetchError || !item) {
      return res.status(404).json({ error: 'Media item not found' });
    }
    if (item.file_type !== 'video') {
      return res.status(400).json({ error: 'Only video files can be streamed' });
    }

    const axios = require('axios');

    if (item.cloud_provider === 'google_drive') {
      const { getGoogleDriveClient } = require('../services/googleDriveService');

      // Get the user's Google Drive connection (using userId from the stream token)
      const { data: conn } = await supabaseAdmin
        .from('cloud_connections')
        .select('access_token, refresh_token, token_expires_at')
        .eq('user_id', tokenUserId)
        .eq('provider', 'google_drive')
        .single();

      if (!conn?.access_token) {
        return res.status(400).json({ error: 'Google Drive is not connected for this account.' });
      }

      // Shared helper — refreshes token if expired, saves fresh token to DB
      const { drive, oauth2Client } = await getGoogleDriveClient(tokenUserId, conn);

      // Get the file's total size and MIME type from Drive metadata.
      // We need the size to produce a valid Content-Range header so the
      // browser knows where to seek within the file.
      const fileMeta = await drive.files.get({
        fileId: item.cloud_file_id,
        fields: 'size,mimeType'
      });

      const fileSize = parseInt(fileMeta.data.size, 10);
      const mimeType = fileMeta.data.mimeType || 'video/mp4';

      // Parse the Range header sent by the browser's video element.
      // Format: "bytes=start-end" or "bytes=start-" (open-ended means to EOF).
      const rangeHeader = req.headers['range'];
      let start = 0;
      let end   = fileSize - 1;

      if (rangeHeader) {
        const parts = rangeHeader.replace(/bytes=/, '').split('-');
        start = parseInt(parts[0], 10);
        end   = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        // Clamp to actual file bounds
        if (end >= fileSize) end = fileSize - 1;
      }

      const chunkSize  = end - start + 1;
      const statusCode = rangeHeader ? 206 : 200;

      res.status(statusCode).set({
        'Content-Type':   mimeType,
        'Content-Length': chunkSize,
        'Accept-Ranges':  'bytes',
        'Cache-Control':  'no-cache, private',  // Don't cache — auth token is ephemeral
        ...(rangeHeader ? { 'Content-Range': `bytes ${start}-${end}/${fileSize}` } : {})
      });

      // Make an authenticated HTTP range request directly to the Drive REST API.
      // The googleapis library doesn't expose byte ranges, but the REST API does.
      const accessToken = oauth2Client.credentials.access_token;

      const driveResponse = await axios.get(
        `https://www.googleapis.com/drive/v3/files/${item.cloud_file_id}?alt=media`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Range: `bytes=${start}-${end}`
          },
          responseType: 'stream',
          timeout: 120000  // 2 minutes — enough for large chunks
        }
      );

      // Pipe the Drive stream to the client
      driveResponse.data.pipe(res);

      // If the client disconnects mid-stream (e.g. user closes tab), stop the Drive request
      req.on('close', () => driveResponse.data.destroy());

    } else if (item.cloud_url) {
      // For direct cloud URLs (Dropbox, Box, AI-generated, etc.)
      // simply proxy the request with the Range header forwarded.
      const rangeHeader = req.headers['range'];

      const cloudResponse = await axios.get(item.cloud_url, {
        headers: rangeHeader ? { Range: rangeHeader } : {},
        responseType: 'stream',
        timeout: 120000
      });

      // Forward the status and relevant headers from the cloud source
      res.status(cloudResponse.status);
      const forwardHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges'];
      forwardHeaders.forEach(h => {
        if (cloudResponse.headers[h]) res.set(h, cloudResponse.headers[h]);
      });

      cloudResponse.data.pipe(res);
      req.on('close', () => cloudResponse.data.destroy());

    } else {
      return res.status(400).json({ error: 'This media item has no streamable source' });
    }

  } catch (err) {
    console.error('[Media] Stream error:', err.message);
    // Only send a JSON error if we haven't started streaming yet
    if (!res.headersSent) {
      res.status(500).json({ error: `Streaming failed: ${err.message}` });
    }
  }
});

// ----------------------------------------------------------------
// All routes below this line require the user to be logged in.
// ----------------------------------------------------------------
router.use(requireAuth, enforceTenancy);

// Valid values for validation
const VALID_PROVIDERS  = ['google_drive', 'dropbox', 'box', 'manual'];
const VALID_FILE_TYPES = ['video', 'image'];
const VALID_PLATFORMS  = ['instagram', 'facebook', 'tiktok', 'linkedin', 'x', 'threads', 'youtube'];

// ----------------------------------------------------------------
// GET /media
// Returns all catalogued media items for this user.
// Optional query params:
//   ?file_type=video              filter by video or image
//   ?provider=google_drive        filter by cloud provider
//   ?platform=instagram           filter by platform fit (contains)
//   ?q=keyword                    search filename
// ----------------------------------------------------------------
router.get('/', standardLimiter, async (req, res) => {
  try {
    let query = req.db
      .from('media_items')
      .select('*')
      .order('catalogued_at', { ascending: false });

    if (req.query.file_type && VALID_FILE_TYPES.includes(req.query.file_type)) {
      query = query.eq('file_type', req.query.file_type);
    }

    if (req.query.provider && VALID_PROVIDERS.includes(req.query.provider)) {
      query = query.eq('cloud_provider', req.query.provider);
    }

    if (req.query.platform && VALID_PLATFORMS.includes(req.query.platform)) {
      // Use Postgres array containment: platform_fit @> ARRAY[platform]
      query = query.contains('platform_fit', [req.query.platform]);
    }

    if (req.query.q) {
      // Case-insensitive filename search
      query = query.ilike('filename', `%${req.query.q}%`);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    // Prevent browser caching so new items appear immediately after a scan
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');

    return res.json({ media: data || [] });

  } catch (err) {
    console.error('[Media] List error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch media library' });
  }
});

// ----------------------------------------------------------------
// POST /media/ranked
// Returns the user's full media library sorted by relevance to a
// brief context. Used by the media picker when attaching media to
// a post — so the best-matching files appear at the top of the grid
// instead of the most recently catalogued.
//
// Body (all optional — falls back to chronological sort if omitted):
//   post_type   string  — 'educational', 'promotional', etc.
//   objective   string  — 'engagement', 'conversions', etc.
//   tone        string  — 'bold', 'inspirational', etc.
//   platform    string  — 'instagram', 'tiktok', etc.
//
// Scoring is done in JS (not SQL) using the same brief semantics
// tables as the clip matcher — so the two ranking systems are consistent.
// ----------------------------------------------------------------
router.post('/ranked', standardLimiter, async (req, res) => {
  const { post_type, objective, tone, platform } = req.body;

  try {
    // Fetch all media items for this user, newest first as tiebreaker
    const { data: items, error } = await req.db
      .from('media_items')
      .select('*')
      .order('catalogued_at', { ascending: false });

    if (error) throw new Error(error.message);
    if (!items || items.length === 0) {
      return res.json({ media: [] });
    }

    // If no brief context was supplied, just return chronological order
    // (same as GET /media) — caller passed no context to score against.
    const hasBriefContext = post_type || objective || tone || platform;
    if (!hasBriefContext) {
      return res.json({ media: items });
    }

    // Score each item and attach the score for the frontend to use
    const { scoreMediaForBrief } = require('../data/briefSemantics');
    const scored = items.map(item => ({
      ...item,
      _match_score: scoreMediaForBrief(item, { postType: post_type, objective, tone, platform })
    }));

    // Sort: highest score first, then by catalogued_at (already ordered above)
    scored.sort((a, b) => b._match_score - a._match_score);

    return res.json({ media: scored });

  } catch (err) {
    console.error('[Media] Ranked error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch ranked media' });
  }
});

// ----------------------------------------------------------------
// POST /media/add
// Manually add a media item by pasting a URL.
// This is the primary way to add media in Phase 4.
// (Automated cloud scanning requires OAuth — available after connecting.)
//
// Body:
//   filename       string   required  - "My product demo.mp4"
//   cloud_url      string   required  - Direct or shareable URL to the file
//   file_type      string   required  - "video" | "image"
//   cloud_provider string   optional  - "google_drive" | "dropbox" | "box" | "manual"
//   duration_seconds int    optional  - Video length in seconds
//   resolution     string   optional  - "1920x1080"
//   themes         array    optional  - ["fitness", "motivation"]
//   emotional_tone string   optional  - "inspiring", "educational", etc.
//   pacing         string   optional  - "fast", "slow", "moderate"
//   platform_fit   array    optional  - ["instagram", "tiktok"]
// ----------------------------------------------------------------
router.post('/add', standardLimiter, async (req, res) => {
  const {
    filename, cloud_url, file_type, cloud_provider,
    duration_seconds, resolution, themes, emotional_tone, pacing, platform_fit
  } = req.body;

  // Validate required fields
  if (!filename?.trim()) {
    return res.status(400).json({ error: 'filename is required' });
  }
  if (!cloud_url?.trim()) {
    return res.status(400).json({ error: 'cloud_url is required' });
  }
  if (!file_type || !VALID_FILE_TYPES.includes(file_type)) {
    return res.status(400).json({ error: 'file_type must be "video" or "image"' });
  }

  // Validate URL format
  try {
    new URL(cloud_url);
  } catch {
    return res.status(400).json({ error: 'cloud_url must be a valid URL' });
  }

  // Validate optional arrays
  if (platform_fit && Array.isArray(platform_fit)) {
    const invalid = platform_fit.filter(p => !VALID_PLATFORMS.includes(p));
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Invalid platforms: ${invalid.join(', ')}` });
    }
  }

  try {
    const { data, error } = await req.db
      .from('media_items')
      .insert({
        user_id:          req.userId,
        cloud_provider:   VALID_PROVIDERS.includes(cloud_provider) ? cloud_provider : 'manual',
        // For manual items, use the URL itself as the cloud_file_id
        cloud_file_id:    cloud_url,
        cloud_url:        cloud_url.trim(),
        filename:         filename.trim(),
        file_type,
        duration_seconds: file_type === 'video' && duration_seconds
                            ? parseInt(duration_seconds, 10)
                            : null,
        resolution:       resolution?.trim() || null,
        themes:           Array.isArray(themes)       ? themes       : [],
        emotional_tone:   emotional_tone?.trim()      || null,
        pacing:           pacing?.trim()              || null,
        platform_fit:     Array.isArray(platform_fit) ? platform_fit : []
      })
      .select()
      .single();

    if (error) {
      if (error.message.includes('unique') || error.message.includes('duplicate')) {
        return res.status(409).json({ error: 'This media URL has already been added to your library' });
      }
      throw new Error(error.message);
    }

    // Queue video analysis for manually added videos — same as cloud-scanned videos.
    // Non-fatal: if the queue call fails, the item is still in the library.
    if (data.file_type === 'video') {
      try {
        const { mediaAnalysisQueue } = require('../queues');
        await mediaAnalysisQueue.add(
          'analyze-video',
          { mediaItemId: data.id },
          { jobId: `analyze-video-${data.id}` }
        );
      } catch (queueErr) {
        console.warn(`[Media] Could not queue analysis for manually added video ${data.id}: ${queueErr.message}`);
      }
    }

    return res.status(201).json({
      message: 'Media item added to library',
      media: data
    });

  } catch (err) {
    console.error('[Media] Add error:', err.message);
    return res.status(500).json({ error: 'Failed to add media item' });
  }
});

// ----------------------------------------------------------------
// POST /media/scan
// Triggers a background scan of all connected cloud storage providers
// for this user. The scan runs asynchronously — this endpoint returns
// immediately with a "scan started" message.
// The mediaAgent handles the actual scanning.
// ----------------------------------------------------------------
router.post('/scan', standardLimiter, async (req, res) => {
  try {
    // Check if the user has any connected providers
    const { data: connections } = await supabaseAdmin
      .from('cloud_connections')
      .select('provider, last_scanned_at')
      .eq('user_id', req.userId);

    if (!connections || connections.length === 0) {
      return res.status(400).json({
        error: 'No cloud storage connected. Connect Google Drive, Dropbox, or Box first.'
      });
    }

    // Queue a BullMQ scan job — respects the worker's concurrency limit (3)
    // and retries on failure, rather than firing-and-forgetting a raw function call.
    const { mediaScanQueue } = require('../queues');

    // Remove any stuck existing job with this ID before re-adding.
    // BullMQ deduplicates by jobId in ALL states (waiting, active, completed, failed).
    // Without this, a completed job sitting in Redis silently blocks every future add().
    const jobId = `scan-user-${req.userId}`;
    try {
      const existingJob = await mediaScanQueue.getJob(jobId);
      if (existingJob) await existingJob.remove();
    } catch (e) { /* non-fatal — proceed with add even if removal fails */ }

    await mediaScanQueue.add('scan-user', { userId: req.userId }, {
      jobId,
      removeOnComplete: true,   // Belt-and-suspenders: auto-remove on completion too
      removeOnFail:     true
    });

    return res.json({
      message: 'Scan started. New media items will appear in your library within a few minutes.',
      providers: connections.map(c => c.provider)
    });

  } catch (err) {
    console.error('[Media] Scan trigger error:', err.message);
    return res.status(500).json({ error: 'Failed to start scan' });
  }
});

// ----------------------------------------------------------------
// GET /media/providers
// Lists which cloud storage providers are connected for this user.
// ----------------------------------------------------------------
router.get('/providers', standardLimiter, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('cloud_connections')
      .select('id, provider, provider_email, provider_user_id, last_scanned_at, connected_at')
      .eq('user_id', req.userId);

    if (error) throw new Error(error.message);

    return res.json({ providers: data || [] });

  } catch (err) {
    console.error('[Media] Providers error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch connected providers' });
  }
});

// ----------------------------------------------------------------
// POST /media/connect/:provider
// Stores OAuth credentials for a cloud storage provider.
//
// In production, this is called as the final step of the OAuth flow
// after the user authorises the app in the provider's UI.
//
// Body: { access_token, refresh_token, expires_at, provider_email }
// ----------------------------------------------------------------
router.post('/connect/:provider', standardLimiter, async (req, res) => {
  const { provider } = req.params;
  const validCloudProviders = ['google_drive', 'dropbox', 'box'];

  if (!validCloudProviders.includes(provider)) {
    return res.status(400).json({ error: `Invalid provider. Must be one of: ${validCloudProviders.join(', ')}` });
  }

  const { access_token, refresh_token, expires_at, provider_email } = req.body;

  if (!access_token) {
    return res.status(400).json({ error: 'access_token is required' });
  }

  // Encrypt tokens before storing
  const { encryptToken, decryptToken } = require('../services/tokenEncryption');

  try {
    const { data, error } = await supabaseAdmin
      .from('cloud_connections')
      .upsert({
        user_id:           req.userId,
        provider,
        access_token:      encryptToken(access_token),
        refresh_token:     refresh_token ? encryptToken(refresh_token) : null,
        token_expires_at:  expires_at ? new Date(expires_at).toISOString() : null,
        provider_email:    provider_email || null,
        connected_at:      new Date().toISOString()
      }, { onConflict: 'user_id,provider' })
      .select('id, provider, provider_email, connected_at')
      .single();

    if (error) throw new Error(error.message);

    return res.json({
      message: `${provider.replace('_', ' ')} connected successfully`,
      connection: data
    });

  } catch (err) {
    console.error('[Media] Connect error:', err.message);
    return res.status(500).json({ error: 'Failed to connect cloud storage' });
  }
});

// ----------------------------------------------------------------
// DELETE /media/connect/:provider
// Removes a cloud storage connection and its stored tokens.
// Does NOT delete any catalogued media items (they stay in the library).
// ----------------------------------------------------------------
router.delete('/connect/:provider', standardLimiter, async (req, res) => {
  const { provider } = req.params;

  try {
    const { error } = await supabaseAdmin
      .from('cloud_connections')
      .delete()
      .eq('user_id', req.userId)
      .eq('provider', provider);

    if (error) throw new Error(error.message);

    return res.json({
      message: `${provider.replace('_', ' ')} disconnected. Your catalogued media items have been kept.`
    });

  } catch (err) {
    console.error('[Media] Disconnect error:', err.message);
    return res.status(500).json({ error: 'Failed to disconnect provider' });
  }
});

// (proxy route moved above router.use(requireAuth) — see top of auth-protected section)

// ----------------------------------------------------------------
// GET /media/:id — fetch a single media item
// ----------------------------------------------------------------
router.get('/:id', standardLimiter, async (req, res) => {
  try {
    const { data, error } = await req.db
      .from('media_items')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Media item not found' });
    }

    return res.json({ media: data });

  } catch (err) {
    console.error('[Media] Get error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch media item' });
  }
});

// ----------------------------------------------------------------
// PUT /media/:id
// Update the user-editable metadata on a media item:
// themes, emotional_tone, pacing, platform_fit.
// filename and cloud_url cannot be changed after creation.
// ----------------------------------------------------------------
router.put('/:id', standardLimiter, async (req, res) => {
  const { themes, emotional_tone, pacing, platform_fit } = req.body;

  const updates = {};
  if (themes        !== undefined) updates.themes        = Array.isArray(themes)       ? themes       : [];
  if (emotional_tone !== undefined) updates.emotional_tone = emotional_tone;
  if (pacing        !== undefined) updates.pacing        = pacing;
  if (platform_fit  !== undefined) updates.platform_fit  = Array.isArray(platform_fit) ? platform_fit : [];

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields provided to update' });
  }

  try {
    const { data, error } = await req.db
      .from('media_items')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Media item not found' });
    }

    return res.json({ message: 'Media item updated', media: data });

  } catch (err) {
    console.error('[Media] Update error:', err.message);
    return res.status(500).json({ error: 'Failed to update media item' });
  }
});

// ----------------------------------------------------------------
// DELETE /media/all
// Removes ALL media items for the current user from the catalog.
// AI-generated images are also deleted from Supabase Storage.
// Original files in Google Drive / Dropbox / Box are NOT touched.
// ----------------------------------------------------------------
router.delete('/all', standardLimiter, async (req, res) => {
  try {
    // Fetch all items first so we know which ones need storage cleanup
    const { data: items, error: fetchErr } = await req.db
      .from('media_items')
      .select('id, cloud_provider, cloud_file_id');

    if (fetchErr) throw new Error(fetchErr.message);

    // Delete AI-generated images from Supabase Storage.
    // AI-generated items store the Supabase storage path in cloud_file_id.
    const aiItems = (items || []).filter(
      i => i.cloud_provider === 'ai_generated' && i.cloud_file_id
    );

    if (aiItems.length > 0) {
      const paths = aiItems.map(i => i.cloud_file_id);
      // Supabase Storage bulk delete — ignores paths that don't exist
      const storageUrl = `${process.env.SUPABASE_URL}/storage/v1/object/ai-generated-images`;
      const axios = require('axios');
      await axios.delete(storageUrl, {
        headers: {
          'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json'
        },
        data: { prefixes: paths }
      }).catch(e => {
        // Non-fatal: catalog rows are still deleted even if storage cleanup fails
        console.error('[Media] Storage cleanup partial failure:', e.message);
      });
    }

    // Delete all catalog rows for this user
    const { error: deleteErr } = await req.db
      .from('media_items')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000'); // delete all (RLS scopes to user)

    if (deleteErr) throw new Error(deleteErr.message);

    return res.json({ deleted: (items || []).length });

  } catch (err) {
    console.error('[Media] Delete all error:', err.message);
    return res.status(500).json({ error: 'Failed to delete all media items' });
  }
});

// ----------------------------------------------------------------
// DELETE /media/:id
// Removes the item from the catalog. Does NOT touch the actual file
// in the user's cloud storage — it just removes our metadata record.
// ----------------------------------------------------------------
router.delete('/:id', standardLimiter, async (req, res) => {
  try {
    const { error } = await req.db
      .from('media_items')
      .delete()
      .eq('id', req.params.id);

    if (error) throw new Error(error.message);

    return res.json({ message: 'Removed from library (your source file is unchanged)' });

  } catch (err) {
    console.error('[Media] Delete error:', err.message);
    return res.status(500).json({ error: 'Failed to remove media item' });
  }
});

// ----------------------------------------------------------------
// POST /media/oauth/google_drive/start
//
// Generates the Google OAuth URL and returns it to the frontend.
// The frontend then does window.location.href = authUrl to kick
// off the login flow. The user logs in with Google, approves access,
// and Google redirects them back to /media/oauth/google_drive/callback.
// ----------------------------------------------------------------
router.post('/oauth/google_drive/start', standardLimiter, async (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID === 'your_google_client_id') {
    return res.status(501).json({
      error: 'Google Drive is not set up yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the .env file.'
    });
  }

  const { google } = require('googleapis');
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );

  // Generate a cryptographic nonce and store userId → nonce in Redis (10-min TTL).
  // The callback looks up the nonce to get the userId — this prevents state injection
  // attacks where an attacker could forge a state with another user's ID.
  const nonce = crypto.randomBytes(32).toString('hex');
  await cacheSet(`oauth_nonce:${nonce}`, req.user.id, 600); // 10 minutes
  const state = nonce;

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',  // Request a refresh token so we can scan later without re-auth
    scope:       ['https://www.googleapis.com/auth/drive.readonly',
                  'https://www.googleapis.com/auth/userinfo.email'],
    state,
    prompt: 'consent'       // Always show the consent screen so we always get a refresh token
  });

  return res.json({ authUrl });
});

// ----------------------------------------------------------------
// POST /media/oauth/google_drive/folder
//
// After connecting Google Drive, the user pastes a folder URL.
// We extract the folder ID and save it, then trigger a background scan.
//
// Body: { folder_url: "https://drive.google.com/drive/folders/ABC123..." }
// ----------------------------------------------------------------
router.post('/oauth/google_drive/folder', standardLimiter, async (req, res) => {
  const { folder_url } = req.body;

  if (!folder_url?.trim()) {
    return res.status(400).json({ error: 'folder_url is required' });
  }

  // Extract the folder ID from any Google Drive folder URL format:
  //   https://drive.google.com/drive/folders/FOLDER_ID
  //   https://drive.google.com/drive/u/0/folders/FOLDER_ID
  const match = folder_url.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (!match) {
    return res.status(400).json({
      error: "That doesn't look like a Google Drive folder link. Open the folder in Google Drive, click Share → Copy link, and paste it here."
    });
  }

  const folderId = match[1];

  // Save the folder ID — we store it in provider_user_id since that field is available
  const { error } = await supabaseAdmin
    .from('cloud_connections')
    .update({ provider_user_id: folderId })
    .eq('user_id', req.user.id)
    .eq('provider', 'google_drive');

  if (error) {
    return res.status(500).json({ error: 'Failed to save folder selection. Please try again.' });
  }

  // Queue a BullMQ scan job for this user — respects concurrency limits and retries
  const { mediaScanQueue } = require('../queues');

  // Remove any stuck existing job before re-adding (see POST /media/scan for explanation)
  const scanJobId = `scan-user-${req.user.id}`;
  try {
    const existingJob = await mediaScanQueue.getJob(scanJobId);
    if (existingJob) await existingJob.remove();
  } catch (e) { /* non-fatal */ }

  await mediaScanQueue.add('scan-user', { userId: req.user.id }, {
    jobId:            scanJobId,
    removeOnComplete: true,
    removeOnFail:     true
  });

  return res.json({
    message: 'Folder saved! Scanning your media now — new items will appear in your library within a minute.'
  });
});

// ----------------------------------------------------------------
// POST /media/generate-image
// Generates an AI image from a text prompt using fal.ai Flux Schnell.
//
// The image is stored permanently in Supabase Storage and a media_items
// record is created, so the user can see it in their library and attach
// it to posts just like any other media.
//
// Uses the AI rate limiter (same budget as post generation) since this
// also costs money per call. Tied to subscription tiers in future.
//
// Body:
//   prompt     (required) - Text description of the image to generate
//   image_size (optional) - 'square_hd' | 'landscape_4_3' | 'landscape_16_9'
//                           | 'portrait_4_3' | 'portrait_16_9'
//                           Default: 'square_hd' (1024×1024, safe for all platforms)
// ----------------------------------------------------------------
// requireAuth MUST come before aiLimiter so the rate limit is per-user, not per-IP.
// Per-IP limiting lets one user behind a shared NAT exhaust the limit for everyone.
router.post('/generate-image', requireAuth, enforceTenancy, aiLimiter, checkLimit('ai_images_per_month'), async (req, res) => {
  const { prompt, image_size = 'square_hd' } = req.body;

  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: 'A prompt is required to generate an image.' });
  }

  const cleanPrompt = prompt.trim().slice(0, 1000); // Cap prompt length

  // Validate image_size to only allow known values
  const validSizes = ['square_hd', 'square', 'landscape_4_3', 'landscape_16_9', 'portrait_4_3', 'portrait_16_9'];
  if (!validSizes.includes(image_size)) {
    return res.status(400).json({ error: `image_size must be one of: ${validSizes.join(', ')}` });
  }

  try {
    const { generateAndStore } = require('../services/imageGenerationService');

    // Generate the image and upload it to Supabase Storage.
    // This takes ~3–8 seconds total (generation + download + upload).
    const { publicUrl, storagePath, width, height } = await generateAndStore(
      cleanPrompt,
      req.user.id,
      image_size
    );

    // Build a short filename from the prompt (truncated + sanitised)
    const shortPrompt = cleanPrompt.slice(0, 40).replace(/[^a-z0-9 ]/gi, '').trim().replace(/\s+/g, '-');
    const filename    = `ai-${shortPrompt || 'generated'}-${Date.now()}.jpg`;

    // Create a media_items record so the image appears in the user's library
    const { data: mediaItem, error: insertError } = await req.db
      .from('media_items')
      .insert({
        user_id:        req.user.id,
        cloud_provider: 'ai_generated',
        cloud_file_id:  storagePath,   // Supabase storage path acts as the unique file ID
        cloud_url:      publicUrl,
        filename,
        file_type:      'image',
        resolution:     `${width}x${height}`
      })
      .select()
      .single();

    if (insertError) {
      throw new Error(`Failed to save generated image to library: ${insertError.message}`);
    }

    return res.status(201).json({
      message:    'Image generated and added to your media library.',
      media_item: mediaItem
    });

  } catch (err) {
    console.error('[Media] Image generation error:', err.message);

    // Give the user a friendly message for the most common failures
    if (err.message === 'NSFW_PROMPT') {
      return res.status(400).json({ error: 'Your prompt was flagged as inappropriate content. Please rephrase your description and try again.' });
    }
    if (err.message.includes('CLOUDFLARE_ACCOUNT_ID') || err.message.includes('CLOUDFLARE_API_TOKEN')) {
      return res.status(503).json({ error: 'Image generation is not configured. Contact support.' });
    }
    if (err.message.includes('invalid or does not have') || err.message.includes('Workers AI permission')) {
      return res.status(503).json({ error: 'Image generation is temporarily unavailable. Please try again later or contact support.' });
    }
    if (err.message.includes('rate limit')) {
      return res.status(429).json({ error: 'Too many image generation requests. Please wait a moment and try again.' });
    }
    if (err.message.includes('storage bucket') || err.message.includes('store generated')) {
      return res.status(500).json({ error: 'Image was generated but could not be saved. Check that the Supabase storage bucket exists.' });
    }

    return res.status(500).json({ error: `Image generation failed: ${err.message}` });
  }
});

// ----------------------------------------------------------------
// POST /media/:id/probe
// Fetches video duration and resolution WITHOUT downloading the file.
//
// Strategy by provider:
//   google_drive — calls Drive API files.get?fields=videoMediaMetadata
//                  which returns durationMillis + width/height directly.
//                  This is instant (one metadata API call, ~50ms).
//   others       — falls back to ffprobe on the cloud URL with a 5MB
//                  probesize limit so only the container header is read.
//
// Returns: { duration, resolution }
// ----------------------------------------------------------------
router.post('/:id/probe', standardLimiter, requireAuth, enforceTenancy, async (req, res) => {
  try {
    // Fetch the media item — scoped to this user for tenant safety
    const { data: item, error: fetchError } = await req.db
      .from('media_items')
      .select('id, filename, cloud_url, cloud_file_id, cloud_provider, file_type, analysis_status')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !item) {
      return res.status(404).json({ error: 'Media item not found' });
    }

    if (item.file_type !== 'video') {
      return res.status(400).json({ error: 'Probe is only supported for video files' });
    }

    let duration   = null;
    let resolution = null;

    // ---- Google Drive: use the Drive API metadata (no download at all) ----
    if (item.cloud_provider === 'google_drive') {
      const { supabaseAdmin }        = require('../services/supabaseService');
      const { getGoogleDriveClient } = require('../services/googleDriveService');

      const { data: conn } = await supabaseAdmin
        .from('cloud_connections')
        .select('access_token, refresh_token, token_expires_at')
        .eq('user_id', req.user.id)
        .eq('provider', 'google_drive')
        .single();

      if (!conn?.access_token) {
        return res.status(400).json({ error: 'Google Drive is not connected for this account.' });
      }

      // Shared helper — handles token refresh + saves updated token to DB automatically
      const { drive } = await getGoogleDriveClient(req.user.id, conn);

      const response = await drive.files.get({
        fileId: item.cloud_file_id,
        fields: 'videoMediaMetadata'
      });

      const meta = response.data?.videoMediaMetadata;
      if (meta?.durationMillis) {
        duration   = Math.round(parseInt(meta.durationMillis) / 1000);
        resolution = (meta.width && meta.height) ? `${meta.width}x${meta.height}` : null;
      }

    } else {
      // ---- Other providers: ffprobe on the URL with a probesize cap ----
      // Only the container header (first ~5MB) is fetched — not the full file.
      if (!item.cloud_url) {
        return res.status(400).json({ error: 'This media item has no cloud URL to probe' });
      }

      const { execFile } = require('child_process');
      const ffprobePath  = process.env.FFPROBE_PATH || '/usr/bin/ffprobe';

      const stdout = await new Promise((resolve, reject) => {
        execFile(ffprobePath, [
          '-v',              'quiet',
          '-print_format',   'json',
          '-show_streams',
          '-show_format',
          '-probesize',      '5000000',    // Read at most 5MB of the stream
          '-analyzeduration','5000000',    // Analyse at most 5 seconds
          item.cloud_url
        ], { timeout: 30000 }, (err, out) => {
          if (err) return reject(new Error(`ffprobe failed: ${err.message}`));
          resolve(out);
        });
      });

      const data     = JSON.parse(stdout);
      const stream   = data.streams?.find(s => s.codec_type === 'video');
      duration       = Math.round(parseFloat(data.format?.duration || stream?.duration || 0));
      resolution     = (stream?.width && stream?.height) ? `${stream.width}x${stream.height}` : null;
    }

    if (!duration) {
      return res.status(422).json({ error: 'Could not determine video duration. Try again or check the file.' });
    }

    // Save the discovered metadata back to the database
    await req.db
      .from('media_items')
      .update({ duration_seconds: duration, resolution })
      .eq('id', item.id);

    return res.json({ duration, resolution, analysis_status: item.analysis_status || 'pending' });

  } catch (err) {
    console.error('[Media] Probe error:', err.message);
    return res.status(500).json({ error: `Probe failed: ${err.message}` });
  }
});

// ----------------------------------------------------------------
// Platform video duration limits in seconds — used by suggest-clip.
// Mirrors PLATFORM_VIDEO_LIMITS in frontend/public/js/preview.js.
// ----------------------------------------------------------------
const PLATFORM_CLIP_LIMITS = {
  tiktok: 60, instagram: 90, youtube: 60,
  facebook: 180, linkedin: 600, x: 140, threads: 300
};

// ----------------------------------------------------------------
// Helpers for stateless HMAC stream tokens.
// Format: base64url(userId:mediaItemId:expiryUnixSec).hmacHex
//
// Why HMAC instead of Redis?
//   Redis uses enableOfflineQueue:false — if the client is momentarily
//   reconnecting, redis.get() returns null even when the key exists.
//   HMAC tokens are verified entirely in memory: no Redis, no network,
//   no failure modes. They also survive server restarts and work across
//   multiple instances without any shared state.
// ----------------------------------------------------------------
function createStreamToken(userId, mediaItemId, ttlSeconds = 120) {
  const secret = process.env.STREAM_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error('STREAM_TOKEN_SECRET is not set — add it to .env');
  const expiry     = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payloadStr = `${userId}:${mediaItemId}:${expiry}`;
  const payloadB64 = Buffer.from(payloadStr).toString('base64url');
  const hmac       = crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
  return `${payloadB64}.${hmac}`;
}

function verifyStreamToken(token) {
  const secret = process.env.STREAM_TOKEN_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error('STREAM_TOKEN_SECRET is not set — add it to .env');

  const dotIdx = token.lastIndexOf('.');
  if (dotIdx === -1) return null; // malformed

  const payloadB64 = token.slice(0, dotIdx);
  const tokenHmac  = token.slice(dotIdx + 1);

  // Constant-time comparison prevents timing attacks
  const expectedHmac = crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(tokenHmac, 'hex'), Buffer.from(expectedHmac, 'hex'))) {
      return null; // signature mismatch
    }
  } catch {
    return null; // invalid hex
  }

  // Decode payload: "userId:mediaItemId:expiry"
  // UUIDs use hyphens not colons, so splitting on ':' gives exactly 3 parts.
  const parts = Buffer.from(payloadB64, 'base64url').toString().split(':');
  if (parts.length !== 3) return null;

  const [userId, mediaItemId, expiryStr] = parts;
  if (Math.floor(Date.now() / 1000) > parseInt(expiryStr, 10)) return null; // expired

  return { userId, mediaItemId };
}

// ----------------------------------------------------------------
// POST /media/:id/suggest-clip
//
// Uses the LLM to recommend the best clip segment from a video
// for a specific social media post.
//
// The LLM receives:
//   - Video filename and total duration
//   - Post content (hook, caption, platform, media_recommendation)
//   - Platform video duration limit
//
// It returns a start/end time window that best matches the post.
// If the LLM response cannot be parsed, we fall back to a smart
// default (skip first 10% intro, take the platform-limit worth of content).
//
// Body: { post_id } (optional — provides post context for better results)
//
// Returns:
//   { suggested_start, suggested_end, reason, platform_limit, total_duration }
// ----------------------------------------------------------------
router.post('/:id/suggest-clip', aiLimiter, requireAuth, enforceTenancy, async (req, res) => {
  const { post_id } = req.body;

  try {
    // Get the media item — needs duration_seconds to suggest a clip
    const { data: item, error: fetchError } = await req.db
      .from('media_items')
      .select('id, filename, duration_seconds, file_type')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !item) {
      return res.status(404).json({ error: 'Media item not found' });
    }
    if (item.file_type !== 'video') {
      return res.status(400).json({ error: 'Clip suggestion is only available for video files' });
    }
    if (!item.duration_seconds) {
      return res.status(400).json({
        error: 'Video duration is not yet known. Please wait for the probe to complete, then try again.'
      });
    }

    const totalDuration = item.duration_seconds;

    // Optionally load the post for context (hook, caption, platform, etc.)
    let postContext = null;
    if (post_id) {
      const { data: post } = await req.db
        .from('posts')
        .select('hook, caption, platform, post_type, media_recommendation')
        .eq('id', post_id)
        .single();
      postContext = post;
    }

    const platform      = postContext?.platform || 'instagram';
    const platformLimit = PLATFORM_CLIP_LIMITS[platform] || 60;

    // Default fallback: skip first 10% (intro/logos) and last 5% (outro/credits),
    // then take the first platform-limit worth of content from the middle region.
    const introSkip  = Math.floor(totalDuration * 0.10);
    const outroStart = Math.floor(totalDuration * 0.95);
    const fallbackStart = Math.min(introSkip, Math.max(0, totalDuration - platformLimit));
    const fallbackEnd   = Math.min(fallbackStart + platformLimit, outroStart);

    // Build the LLM prompt for clip selection.
    // System prompt is loaded from prompts/clip-selection.md — edit that file to tune behavior.
    const systemPrompt = loadPrompt('clip-selection', {
      platformLimit: String(platformLimit),
      totalDuration: String(totalDuration)
    });

    const userPrompt = `Select the best ${platformLimit}-second clip from this video for the post below.

VIDEO:
- Filename: "${item.filename}"
- Total duration: ${totalDuration} seconds (${Math.floor(totalDuration / 60)}:${String(totalDuration % 60).padStart(2, '0')})

POST CONTEXT:
- Platform: ${platform} (max ${platformLimit} seconds)
- Post type: ${postContext?.post_type || 'general'}
- Hook: "${postContext?.hook || 'N/A'}"
- Caption: "${(postContext?.caption || 'N/A').slice(0, 300)}"
- Media recommendation: "${postContext?.media_recommendation || 'N/A'}"

Pick the ${platformLimit}-second segment that best visually matches the post message. Respond with JSON only.`;

    // Call the LLM with a low temperature for structured output
    const axios  = require('axios');
    const baseUrl = process.env.LLM_BASE_URL || 'http://localhost:8000/v1';

    const llmResponse = await axios.post(
      `${baseUrl}/chat/completions`,
      {
        model:       process.env.LLM_MODEL || 'mistralai/Mistral-7B-Instruct-v0.3',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt }
        ],
        temperature: 0.3,   // Low temp — we want consistent, structured output
        max_tokens:  256,   // We only need a small JSON object
        stream:      false
      },
      {
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.LLM_API_KEY && process.env.LLM_API_KEY !== 'none'
            ? { Authorization: `Bearer ${process.env.LLM_API_KEY}` }
            : {})
        },
        timeout: 30000  // 30 seconds — small prompt, should be fast
      }
    );

    const llmContent = llmResponse.data?.choices?.[0]?.message?.content || '';

    // Parse the LLM's JSON response. Strip markdown code fences if present.
    let suggestion = null;
    try {
      const cleaned   = llmContent.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      const jsonStart = cleaned.indexOf('{');
      const jsonEnd   = cleaned.lastIndexOf('}');
      if (jsonStart !== -1 && jsonEnd !== -1) {
        suggestion = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
      }
    } catch (_) {
      // Fall through to the default below
    }

    // Validate and clamp the LLM's suggestion. If anything looks wrong, use our fallback.
    let suggestedStart, suggestedEnd, reason;

    if (suggestion && typeof suggestion.start_seconds === 'number' && typeof suggestion.end_seconds === 'number') {
      suggestedStart = Math.max(0, Math.floor(suggestion.start_seconds));
      suggestedEnd   = Math.min(totalDuration, Math.floor(suggestion.end_seconds));
      reason         = suggestion.reason || 'AI-selected segment based on post content.';

      // Ensure the clip doesn't exceed the platform limit
      if (suggestedEnd - suggestedStart > platformLimit) {
        suggestedEnd = suggestedStart + platformLimit;
      }
      // Ensure the clip has at least 1 second
      if (suggestedEnd <= suggestedStart) {
        suggestedEnd = Math.min(suggestedStart + platformLimit, totalDuration);
      }
    } else {
      // LLM response was unparseable — use the smart default
      suggestedStart = fallbackStart;
      suggestedEnd   = fallbackEnd;
      reason         = `Suggested starting at ${Math.floor(fallbackStart / 60)}:${String(fallbackStart % 60).padStart(2, '0')} to skip the intro and focus on the main content.`;
    }

    return res.json({
      suggested_start: suggestedStart,
      suggested_end:   suggestedEnd,
      reason,
      platform_limit:  platformLimit,
      total_duration:  totalDuration
    });

  } catch (err) {
    console.error('[Media] Suggest-clip error:', err.message);
    return res.status(500).json({ error: `Clip suggestion failed: ${err.message}` });
  }
});

// ----------------------------------------------------------------
// POST /media/:id/stream-token
//
// Issues a short-lived token (60 seconds) that authorises one video
// stream without requiring an Authorization header.
//
// Why this is needed:
//   HTML5 <video src="..."> requests are made by the browser's media
//   engine, which does NOT attach the JWT Authorization header. So we
//   can't use requireAuth on the stream route directly.
//
// Flow:
//   1. Frontend calls POST /media/:id/stream-token (authenticated as normal)
//   2. Backend creates an HMAC-signed token encoding userId:mediaItemId:expiry
//   3. Backend returns { token }
//   4. Frontend sets  video.src = /media/:id/stream?token={hmac_token}
//   5. Browser requests the stream — backend verifies the signature + expiry in memory
// ----------------------------------------------------------------
router.post('/:id/stream-token', requireAuth, enforceTenancy, standardLimiter, async (req, res) => {
  try {
    // Verify the media item belongs to this user before issuing a token
    const { data: item, error } = await req.db
      .from('media_items')
      .select('id, file_type, duration_seconds')
      .eq('id', req.params.id)
      .single();

    if (error || !item) return res.status(404).json({ error: 'Media item not found' });
    if (item.file_type !== 'video') return res.status(400).json({ error: 'Not a video item' });

    // TTL = video duration + 2 minutes buffer, minimum 2 minutes.
    // This ensures the token stays valid for the entire playback session.
    const ttlSeconds = Math.max(120, (item.duration_seconds || 0) + 120);

    // Create a stateless HMAC-signed token — no Redis needed.
    // The token encodes userId + mediaItemId + expiry and is verified
    // by checking the HMAC signature in the stream route.
    const token = createStreamToken(req.user.id, item.id, ttlSeconds);

    return res.json({ token });

  } catch (err) {
    console.error('[Media] stream-token error:', err.message);
    return res.status(500).json({ error: 'Could not issue stream token' });
  }
});




// ----------------------------------------------------------------
// GET /media/:id/segments
//
// Returns all pre-analysed video segments for a media item.
// Segments are created by videoAnalysisService.js in the background
// after a video is catalogued. The frontend uses these to show a
// visual clip picker with thumbnails instead of a blank scrubber.
//
// If analysis_status is 'pending' or 'analyzing', the client should
// poll until status is 'ready'. If 'failed', the LLM suggest-clip
// fallback should be used instead.
// ----------------------------------------------------------------
router.get('/:id/segments', standardLimiter, async (req, res) => {
  try {
    // Verify the media item belongs to this user
    const { data: item, error: itemError } = await req.db
      .from('media_items')
      .select('id, filename, file_type, duration_seconds, analysis_status, cloud_url')
      .eq('id', req.params.id)
      .single();

    if (itemError || !item) {
      return res.status(404).json({ error: 'Media item not found' });
    }

    if (item.file_type !== 'video') {
      return res.status(400).json({ error: 'Segment analysis is only available for video items' });
    }

    // Fetch all segments for this item, ordered chronologically
    const { data: segments, error: segError } = await req.db
      .from('video_segments')
      .select('*')
      .eq('media_item_id', req.params.id)
      .order('start_seconds');

    if (segError) throw new Error(segError.message);

    return res.json({
      media_item: item,
      segments:   segments || [],
      count:      (segments || []).length
    });

  } catch (err) {
    console.error('[Media] Get segments error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch video segments' });
  }
});


// ----------------------------------------------------------------
// POST /media/match-clips
//
// Finds the best pre-analysed video segments for a given brief.
// Returns up to 5 matching segments ranked by energy and pacing fit.
//
// This is the fast alternative to the LLM suggest-clip route.
// It queries the video_segments table directly — no FFmpeg, no LLM.
//
// Body:
//   mediaItemId  — UUID of the video to search within
//   platform     — target platform (filters by platform_fit array)
//   postType     — brief post type (drives energy/pacing scoring)
//   objective    — brief objective (adjusts energy target)
//   tone         — brief tone (adjusts energy target)
//   maxResults   — optional, default 5
// ----------------------------------------------------------------
router.post('/match-clips', standardLimiter, requireAuth, enforceTenancy, async (req, res) => {
  const { mediaItemId, platform, postType, objective, tone, maxResults = 5 } = req.body;

  if (!mediaItemId) {
    return res.status(400).json({ error: 'mediaItemId is required' });
  }

  try {
    // Verify the media item belongs to this user
    const { data: item, error: itemError } = await req.db
      .from('media_items')
      .select('id, analysis_status, file_type')
      .eq('id', mediaItemId)
      .single();

    if (itemError || !item) {
      return res.status(404).json({ error: 'Media item not found' });
    }

    if (item.file_type !== 'video') {
      return res.status(400).json({ error: 'Clip matching is only available for video items' });
    }

    if (item.analysis_status !== 'ready') {
      return res.status(202).json({
        message: `Video analysis is ${item.analysis_status}. Segments not yet available.`,
        analysis_status: item.analysis_status
      });
    }

    // Build the ideal energy and pacing profile for this brief
    const { getClipMatchProfile } = require('../data/briefSemantics');
    const profile = getClipMatchProfile(postType, objective, tone);

    // Fetch all segments for this video
    // We fetch all and score in JS rather than trying to rank in SQL,
    // since the scoring formula involves multiple weighted factors.
    let query = req.db
      .from('video_segments')
      .select('*')
      .eq('media_item_id', mediaItemId);

    // Filter by platform fit if a platform was specified
    if (platform) {
      query = query.contains('platform_fit', [platform]);
    }

    const { data: segments, error: segError } = await query.order('start_seconds');

    if (segError) throw new Error(segError.message);

    if (!segments || segments.length === 0) {
      return res.json({ matches: [], message: 'No segments found for this video' });
    }

    // Score each segment against the brief profile
    const scored = segments.map(seg => {
      let score = 0;

      // Energy score: full points if within ideal range, partial if close
      const energy = seg.energy_level || 5;
      if (energy >= profile.energyMin && energy <= profile.energyMax) {
        score += 50; // Perfect energy match
      } else {
        const distanceFromRange = energy < profile.energyMin
          ? profile.energyMin - energy
          : energy - profile.energyMax;
        score += Math.max(0, 30 - distanceFromRange * 5); // Diminishing partial credit
      }

      // Pacing score: bonus for matching preferred pacing
      if (profile.pacing.includes(seg.pacing)) {
        score += 30;
      }

      // Duration score: slightly prefer segments that fill more of the platform limit
      // (avoids returning 3-second clips when 30-second clips are available)
      const duration = (seg.end_seconds || 0) - (seg.start_seconds || 0);
      if (duration >= 10) score += 10;
      if (duration >= 20) score += 10;

      return { ...seg, match_score: score };
    });

    // Sort by score descending, return top N
    scored.sort((a, b) => b.match_score - a.match_score);
    const topMatches = scored.slice(0, Math.min(maxResults, 10));

    return res.json({
      matches:   topMatches,
      profile,   // Echo back the profile used so the UI can explain the match
      count:     topMatches.length
    });

  } catch (err) {
    console.error('[Media] Match-clips error:', err.message);
    return res.status(500).json({ error: 'Failed to match clips' });
  }
});


module.exports = router;
