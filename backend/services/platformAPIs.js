/**
 * services/platformAPIs.js
 *
 * Unified service layer for publishing to all 7 platforms,
 * fetching performance metrics, and fetching comments.
 *
 * IMPLEMENTATION STATUS
 * ---------------------
 * The framework (routing, error handling, token decryption) is fully built.
 * Each platform's actual API call is a documented stub. To activate a platform:
 *   1. Add OAuth credentials to .env (see comment above each function).
 *   2. Complete the user-facing OAuth flow to get an access_token.
 *   3. Store the encrypted token via POST /publish/platforms/connect.
 *   4. Uncomment the platform implementation below.
 *
 * Three exported functions:
 *   publish(post, connection)                     → { platformPostId }
 *   fetchMetrics(postId, platform, token)          → { likes, comments, ... }
 *   fetchComments(postId, platform, token, since)  → [{ platformCommentId, ... }]
 */

const axios = require('axios');
const { decryptToken } = require('./tokenEncryption');
const { getRedisClient } = require('./redisService');

// ================================================================
// PER-ACCOUNT RATE LIMITING (ISSUE-012)
//
// Prevents multiple BullMQ jobs from hitting the same user's platform
// account simultaneously (risks 24-hour lockouts from platforms).
//
// Two layers:
//   1. Mutex lock — only one API call at a time per userId+platform
//   2. Daily counter — hard cap on API calls per account per day
//
// Daily limits are conservative to stay well within platform ToS:
//   Facebook:  200 publish calls/day (official limit: much higher)
//   Instagram: 50 publishes/day (official limit: 50)
//   TikTok:    50 publishes/day
//   Others:    100 calls/day (safe default)
// ================================================================
const DAILY_LIMITS = {
  facebook:  200,
  instagram: 50,
  tiktok:    50,
  linkedin:  100,
  x:         100,
  threads:   100,
  youtube:   100,
  whatsapp:  100,
  telegram:  100
};

const LOCK_TTL = 120; // seconds — auto-expire lock if process crashes

/**
 * acquireAccountLock — acquires a per-account mutex.
 * Returns true if lock acquired, false if another job holds it.
 * Retries up to 5 times with 2s delay.
 */
async function acquireAccountLock(userId, platform) {
  const key = `platform_lock:${userId}:${platform}`;
  try {
    const redis = getRedisClient();
    for (let attempt = 0; attempt < 5; attempt++) {
      const acquired = await redis.set(key, '1', 'EX', LOCK_TTL, 'NX');
      if (acquired) return true;
      // Wait 2s before retrying
      await new Promise(r => setTimeout(r, 2000));
    }
    return false; // Could not acquire after retries
  } catch (err) {
    // Redis down — allow the call to proceed (don't block publishing entirely)
    console.warn(`[PlatformAPIs] Lock acquire failed (Redis): ${err.message}`);
    return true;
  }
}

/**
 * releaseAccountLock — releases the per-account mutex.
 */
async function releaseAccountLock(userId, platform) {
  const key = `platform_lock:${userId}:${platform}`;
  try {
    const redis = getRedisClient();
    await redis.del(key);
  } catch (err) {
    console.warn(`[PlatformAPIs] Lock release failed: ${err.message}`);
  }
}

/**
 * checkDailyLimit — checks and increments the daily API call counter.
 * Returns true if under limit, false if limit exceeded.
 */
async function checkDailyLimit(userId, platform) {
  const key = `platform_daily:${userId}:${platform}`;
  const limit = DAILY_LIMITS[platform] || 100;
  try {
    const redis = getRedisClient();
    const current = parseInt(await redis.get(key) || '0', 10);
    if (current >= limit) return false;
    // Increment. If this is the first call today, set TTL to expire at midnight UTC.
    const newCount = await redis.incr(key);
    if (newCount === 1) {
      // Expire at end of day UTC
      const now = new Date();
      const endOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
      const ttl = Math.ceil((endOfDay - now) / 1000);
      await redis.expire(key, ttl);
    }
    return true;
  } catch (err) {
    // Redis down — allow the call (don't block publishing)
    console.warn(`[PlatformAPIs] Daily limit check failed (Redis): ${err.message}`);
    return true;
  }
}

// ================================================================
// MAIN ENTRY POINTS
// ================================================================

/**
 * publish — decrypts the token and routes to the correct platform publisher.
 * @returns {{ platformPostId: string }}
 */
async function publish(post, connection) {
  const userId = post.user_id;
  const platform = connection.platform;

  // Per-account daily limit check (ISSUE-012)
  const underLimit = await checkDailyLimit(userId, platform);
  if (!underLimit) {
    throw new Error(`Daily ${platform} API limit reached for this account. Try again tomorrow.`);
  }

  // Per-account mutex — prevent simultaneous API calls to the same account
  const locked = await acquireAccountLock(userId, platform);
  if (!locked) {
    throw new Error(`Another ${platform} publish job is running for this account. Will retry.`);
  }

  try {
    let accessToken;
    try {
      accessToken = decryptToken(connection.access_token);
    } catch (err) {
      throw new Error(`Failed to decrypt ${connection.platform} token: ${err.message}`);
    }

    // Proactively refresh if the token has already expired
    if (connection.token_expires_at && new Date(connection.token_expires_at) <= new Date()) {
      accessToken = await refreshAccessToken(connection);
    }

    switch (connection.platform) {
      case 'instagram': return await publishToInstagram(post, accessToken, connection);
      case 'facebook':  return await publishToFacebook(post, accessToken, connection);
      case 'tiktok':    return await publishToTikTok(post, accessToken, connection);
      case 'linkedin':  return await publishToLinkedIn(post, accessToken, connection);
      case 'x':         return await publishToX(post, accessToken, connection);
      case 'threads':   return await publishToThreads(post, accessToken, connection);
      case 'whatsapp':  return await publishToWhatsApp(post, accessToken, connection);
      case 'telegram':  return await publishToTelegram(post, accessToken, connection);
      default:
        throw new Error(`Unsupported platform: "${connection.platform}"`);
    }
  } finally {
    // Always release the lock, even on error
    await releaseAccountLock(userId, platform);
  }
}

/**
 * fetchMetrics — pulls engagement data for a published post.
 * @returns {{ likes, comments, shares, saves, reach, impressions, clicks, video_views }}
 */
async function fetchMetrics(platformPostId, platform, accessToken) {
  switch (platform) {
    case 'instagram': return fetchInstagramMetrics(platformPostId, accessToken);
    case 'facebook':  return fetchFacebookMetrics(platformPostId, accessToken);
    case 'tiktok':    return fetchTikTokMetrics(platformPostId, accessToken);
    case 'linkedin':  return fetchLinkedInMetrics(platformPostId, accessToken);
    case 'x':         return fetchXMetrics(platformPostId, accessToken);
    case 'threads':   return fetchThreadsMetrics(platformPostId, accessToken);
    case 'whatsapp':  return fetchWhatsAppMetrics(platformPostId, accessToken);
    case 'telegram':  return fetchTelegramMetrics(platformPostId, accessToken);
    default:
      return emptyMetrics();
  }
}

/**
 * fetchComments — returns new comments on a published post since sinceTimestamp.
 * @returns {Array<{ platformCommentId, text, authorHandle, authorPlatformId, timestamp }>}
 */
async function fetchComments(platformPostId, platform, accessToken, sinceTimestamp = null) {
  switch (platform) {
    case 'instagram': return fetchInstagramComments(platformPostId, accessToken, sinceTimestamp);
    case 'facebook':  return fetchFacebookComments(platformPostId, accessToken, sinceTimestamp);
    case 'tiktok':    return fetchTikTokComments(platformPostId, accessToken, sinceTimestamp);
    case 'linkedin':  return fetchLinkedInComments(platformPostId, accessToken, sinceTimestamp);
    case 'x':         return fetchXComments(platformPostId, accessToken, sinceTimestamp);
    case 'threads':   return fetchThreadsComments(platformPostId, accessToken, sinceTimestamp);
    case 'whatsapp':  return fetchWhatsAppComments(platformPostId, accessToken, sinceTimestamp);
    case 'telegram':  return fetchTelegramComments(platformPostId, accessToken, sinceTimestamp);
    default:
      return [];
  }
}

// ================================================================
// PLATFORM PUBLISHERS
// Each returns: { platformPostId: string }
// ================================================================

// ----------------------------------------------------------------
// INSTAGRAM — Meta Graph API (two-step: create container → publish)
// Scopes needed: instagram_basic, instagram_content_publish
// Docs: developers.facebook.com/docs/instagram-api/guides/content-publishing
//
// Instagram does NOT accept multipart file uploads. All media must be provided
// as a public URL that Instagram's servers can fetch. Our processed_url from
// Supabase Storage (processed-media bucket, set to PUBLIC) works for this.
//
// connection.platform_user_id = the Instagram Business Account ID
//   (NOT the Facebook Page ID — stored separately during Facebook OAuth)
//
// Flow:
//   1. POST /{ig-user-id}/media → create a media container (returns container ID)
//   2. For video: poll GET /{container-id}?fields=status_code until FINISHED
//   3. POST /{ig-user-id}/media_publish → publish the container (returns media ID)
// ----------------------------------------------------------------
async function publishToInstagram(post, accessToken, connection) {
  const igUserId = connection.platform_user_id;

  // Build caption — Instagram combines everything into one caption field
  const hashtags = Array.isArray(post.hashtags)
    ? post.hashtags.map(h => (h.startsWith('#') ? h : `#${h}`)).join(' ')
    : '';
  const caption = [post.hook, post.caption, hashtags, post.cta].filter(Boolean).join('\n\n');

  const TIMEOUT = 30_000;
  const API_BASE = 'https://graph.facebook.com/v21.0';

  // Reuse the same error-extractor pattern as Facebook
  const igCall = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err.response) {
        console.log('[PlatformAPIs] IG raw error response:', JSON.stringify(err.response.data));
      } else {
        console.log('[PlatformAPIs] IG network error (no response):', err.message);
      }
      const fb = err.response?.data?.error;
      if (fb) {
        const sub = fb.error_subcode ? ` subcode=${fb.error_subcode}` : '';
        const msg = fb.error_user_msg || fb.message;
        throw new Error(`Instagram error ${fb.code}${sub}: ${msg} (type: ${fb.type})`);
      }
      throw err;
    }
  };

  // Instagram requires a public media URL — no text-only posts allowed
  if (!post.media_url) {
    throw new Error('Instagram requires media (image or video). Text-only posts are not supported.');
  }

  const isVideo = post.media_file_type === 'video';

  console.log(`[PlatformAPIs] Instagram publish — igUserId=${igUserId} mediaType=${post.media_file_type} mediaUrl=${post.media_url}`);

  // ---- Step 1: Create media container ----
  const containerParams = {
    caption,
    access_token: accessToken
  };

  if (isVideo) {
    containerParams.media_type = 'REELS';
    containerParams.video_url  = post.media_url;
  } else {
    containerParams.image_url = post.media_url;
  }

  const containerRes = await igCall(() => axios.post(
    `${API_BASE}/${igUserId}/media`,
    null,
    { params: containerParams, timeout: TIMEOUT }
  ));

  const containerId = containerRes.data.id;
  console.log(`[PlatformAPIs] IG container created — id=${containerId}`);

  // ---- Step 2: Poll until container is ready ----
  // Instagram processes media asynchronously. The container goes through:
  //   IN_PROGRESS → FINISHED (ready to publish)
  //   IN_PROGRESS → ERROR (upload/encoding failed)
  // Images fetched from URLs also need processing time — Instagram must
  // download and validate the image before it's publishable. Skipping this
  // poll causes error 9007/2207027 "media is not ready for publishing".
  const MAX_POLLS = isVideo ? 30 : 10;   // Video: 5 min, Image: 30 sec
  const POLL_INTERVAL_MS = isVideo ? 10_000 : 3_000;

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

    const statusRes = await igCall(() => axios.get(
      `${API_BASE}/${containerId}`,
      { params: { fields: 'status_code,status', access_token: accessToken }, timeout: TIMEOUT }
    ));

    const status = statusRes.data.status_code;
    const statusDetail = statusRes.data.status;
    console.log(`[PlatformAPIs] IG container ${containerId} status: ${status} (poll ${i + 1}/${MAX_POLLS})${statusDetail ? ' detail: ' + JSON.stringify(statusDetail) : ''}`);

    if (status === 'FINISHED') break;
    if (status === 'ERROR') {
      const reason = statusDetail?.error_message || statusDetail?.error?.message || 'unknown reason';
      throw new Error(`Instagram ${isVideo ? 'video' : 'image'} processing failed: ${reason}`);
    }

    if (i === MAX_POLLS - 1) {
      throw new Error(`Instagram ${isVideo ? 'video' : 'image'} processing timed out. Try ${isVideo ? 'a shorter video' : 'a smaller image'}.`);
    }
  }

  // ---- Step 3: Publish the container ----
  const publishRes = await igCall(() => axios.post(
    `${API_BASE}/${igUserId}/media_publish`,
    null,
    { params: { creation_id: containerId, access_token: accessToken }, timeout: TIMEOUT }
  ));

  console.log(`[PlatformAPIs] IG publish OK — mediaId=${publishRes.data.id}`);
  return { platformPostId: publishRes.data.id };
}

// ----------------------------------------------------------------
// FACEBOOK — Meta Graph API (post to Page feed)
// Scopes needed: pages_manage_posts, pages_read_engagement
// connection.platform_user_id must be the Page ID (stored during OAuth)
// ----------------------------------------------------------------
async function publishToFacebook(post, accessToken, connection) {
  // Build the post text — hook, caption, hashtags, cta
  const hashtags = Array.isArray(post.hashtags)
    ? post.hashtags.map(h => (h.startsWith('#') ? h : `#${h}`)).join(' ')
    : '';
  const message = [post.hook, post.caption, hashtags, post.cta].filter(Boolean).join('\n\n');

  const params = { message, access_token: accessToken };

  // Only attach media_url as a link if it's a real public URL (not Google Drive).
  const isGoogleDrive = post.media_url && post.media_url.includes('drive.google.com');

  // 30-second hard timeout on every Facebook API call.
  const TIMEOUT = 30_000;

  // Wrap every axios call so Facebook's actual error message is surfaced.
  // Without this, axios throws "Request failed with status code 400" and the
  // real reason (e.g. "Duplicate post", "Invalid token") is silently discarded.
  // error_subcode gives more specific info than error code alone — always log it.
  const fbCall = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      // Log the full raw response for diagnostics — helps identify permission errors
      // vs. file errors vs. API configuration errors.
      if (err.response) {
        console.log('[PlatformAPIs] FB raw error response:', JSON.stringify(err.response.data));
      } else {
        console.log('[PlatformAPIs] FB network error (no response):', err.message);
      }
      const fb = err.response?.data?.error;
      if (fb) {
        const sub = fb.error_subcode ? ` subcode=${fb.error_subcode}` : '';
        const msg = fb.error_user_msg || fb.message;
        throw new Error(`Facebook error ${fb.code}${sub}: ${msg} (type: ${fb.type})`);
      }
      throw err;
    }
  };

  console.log(`[PlatformAPIs] Facebook publish — pageId=${connection.platform_user_id} mediaType=${post.media_file_type || 'text'} mediaLocalPath=${post.media_local_path || 'none'} mediaUrl=${post.media_url || 'none'}`);

  if (post.media_local_path && post.media_file_type === 'image') {
    // Image from local temp file — upload via multipart to /{page-id}/photos
    const FormData = require('form-data');
    const fs       = require('fs');
    const form     = new FormData();
    form.append('source',       fs.createReadStream(post.media_local_path));
    form.append('caption',      message);
    form.append('access_token', accessToken);
    form.append('published',    'true');

    const photoRes = await fbCall(() => axios.post(
      `https://graph.facebook.com/v21.0/${connection.platform_user_id}/photos`,
      form,
      { headers: form.getHeaders(), timeout: TIMEOUT }
    ));
    return { platformPostId: photoRes.data.post_id || photoRes.data.id };

  } else if (post.media_url && post.media_file_type === 'image' && !isGoogleDrive) {
    // Image from a public URL — Facebook fetches it directly, no server upload needed.
    const photoRes = await fbCall(() => axios.post(
      `https://graph.facebook.com/v21.0/${connection.platform_user_id}/photos`,
      null,
      { params: { url: post.media_url, caption: message, access_token: accessToken, published: true }, timeout: TIMEOUT }
    ));
    return { platformPostId: photoRes.data.post_id || photoRes.data.id };

  } else if (post.media_local_path && post.media_file_type === 'video') {
    // Video from local temp file (re-encoded to H.264/AAC by publishingAgent).
    //
    // Simple multipart upload directly to /{page-id}/videos on graph-video.facebook.com.
    // This is the primary documented approach for Page video publishing.
    // Requires: pages_manage_posts on the Page token + app must be in Live mode.
    const FormData = require('form-data');
    const fs       = require('fs');
    const fileSize = fs.statSync(post.media_local_path).size;
    const title    = post.hook ? String(post.hook).slice(0, 100) : 'Video';

    console.log(`[PlatformAPIs] FB video upload: multipart to graph-video.facebook.com — fileSize=${fileSize} bytes`);

    const form = new FormData();
    // knownLength is required — without it form-data can't set Content-Length for the file
    // part, and Facebook rejects the upload immediately with error 351.
    form.append('source',      fs.createReadStream(post.media_local_path), { filename: 'video.mp4', contentType: 'video/mp4', knownLength: fileSize });
    form.append('description', message);
    form.append('title',       title);
    form.append('published',   'true');
    // access_token goes in URL params, not form body — more reliable for large multipart uploads

    const videoRes = await fbCall(() => axios.post(
      `https://graph-video.facebook.com/v21.0/${connection.platform_user_id}/videos`,
      form,
      {
        params:           { access_token: accessToken },
        headers:          form.getHeaders(),
        maxBodyLength:    Infinity,
        maxContentLength: Infinity,
        timeout:          120_000  // 2-minute timeout — large video uploads can take a while
      }
    ));

    console.log(`[PlatformAPIs] FB video upload OK — id=${videoRes.data.id}`);
    return { platformPostId: videoRes.data.id };

  } else if (post.media_url && post.media_file_type === 'video') {
    // Fallback: Facebook pulls the video from a public URL (e.g. Supabase CDN).
    // Only used when no local file is available.
    const videoRes = await fbCall(() => axios.post(
      `https://graph.facebook.com/v21.0/${connection.platform_user_id}/videos`,
      null,
      { params: { file_url: post.media_url, description: message, access_token: accessToken }, timeout: TIMEOUT }
    ));
    return { platformPostId: videoRes.data.id };

  } else {
    // Text-only post — optionally attach a link preview
    if (post.media_url && !isGoogleDrive) params.link = post.media_url;
    const res = await fbCall(() => axios.post(
      `https://graph.facebook.com/v21.0/${connection.platform_user_id}/feed`,
      null,
      { params, timeout: TIMEOUT }
    ));
    return { platformPostId: res.data.id };
  }
}

// ----------------------------------------------------------------
// TIKTOK — TikTok Content Posting API (Direct Post, pull from URL)
// Required .env: TIKTOK_CLIENT_KEY, TIKTOK_CLIENT_SECRET
// Scopes needed: video.publish
// TikTok is video-only — no image or text posts.
// post.media_url must be a publicly accessible video URL.
// ----------------------------------------------------------------
async function publishToTikTok(post, accessToken, connection) {
  if (!post.media_url || post.media_file_type !== 'video') {
    throw new Error('TikTok only supports video posts. Attach a video before publishing.');
  }

  const hashtags = Array.isArray(post.hashtags)
    ? post.hashtags.map(h => (h.startsWith('#') ? h : `#${h}`)).join(' ')
    : '';
  const rawCaption = [post.hook, hashtags].filter(Boolean).join(' ');
  if (rawCaption.length > 2200) {
    console.warn(`[PlatformAPIs] TikTok caption is ${rawCaption.length}/2200 chars — truncating. User should shorten content.`);
  }
  const caption = rawCaption.slice(0, 2200);

  const TIMEOUT = 30_000;

  console.log(`[PlatformAPIs] TikTok publish — userId=${connection.platform_user_id} mediaUrl=${post.media_url}`);

  try {
    const res = await axios.post(
      'https://open.tiktokapis.com/v2/post/publish/video/init/',
      {
        post_info: {
          title:            caption,
          privacy_level:    'PUBLIC_TO_EVERYONE',
          disable_duet:     false,
          disable_comment:  false,
          disable_stitch:   false
        },
        source_info: {
          source:    'PULL_FROM_URL',
          video_url: post.media_url
        }
      },
      {
        headers: {
          Authorization:  `Bearer ${accessToken}`,
          'Content-Type': 'application/json; charset=UTF-8'
        },
        timeout: TIMEOUT
      }
    );

    const publishId = res.data?.data?.publish_id;
    if (!publishId) {
      throw new Error(`TikTok returned no publish_id: ${JSON.stringify(res.data)}`);
    }

    console.log(`[PlatformAPIs] TikTok publish OK — publishId=${publishId}`);
    return { platformPostId: publishId };

  } catch (err) {
    const tkErr = err.response?.data?.error;
    if (tkErr) {
      console.log('[PlatformAPIs] TikTok raw error:', JSON.stringify(err.response.data));
      throw new Error(`TikTok error ${tkErr.code}: ${tkErr.message}`);
    }
    throw err;
  }
}

// ----------------------------------------------------------------
// LINKEDIN — LinkedIn API v2 (UGC Posts)
// Required .env: LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET
// Scopes needed: w_member_social
//
// connection.platform_user_id = LinkedIn member URN ID (the part after urn:li:person:)
//
// Text posts: single-step POST to /ugcPosts
// Image posts: 2-step — register upload → upload binary → create post with asset
// Video posts: multi-step — initialize upload → upload chunks → create post with asset
//
// LinkedIn requires the X-Restli-Protocol-Version: 2.0.0 header on ALL API calls.
// ----------------------------------------------------------------
async function publishToLinkedIn(post, accessToken, connection) {
  const personUrn = `urn:li:person:${connection.platform_user_id}`;
  const TIMEOUT = 30_000;

  // Build post text
  const hashtags = Array.isArray(post.hashtags)
    ? post.hashtags.map(h => (h.startsWith('#') ? h : `#${h}`)).join(' ')
    : '';
  const text = [post.hook, post.caption, hashtags, post.cta].filter(Boolean).join('\n\n');

  // LinkedIn error extractor
  const liCall = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err.response) {
        console.log('[PlatformAPIs] LinkedIn raw error response:', JSON.stringify(err.response.data));
      } else {
        console.log('[PlatformAPIs] LinkedIn network error (no response):', err.message);
      }
      const liErr = err.response?.data;
      if (liErr?.message) {
        throw new Error(`LinkedIn error ${liErr.status || err.response?.status}: ${liErr.message}`);
      }
      throw err;
    }
  };

  const headers = {
    Authorization:                `Bearer ${accessToken}`,
    'Content-Type':               'application/json',
    'X-Restli-Protocol-Version':  '2.0.0'
  };

  console.log(`[PlatformAPIs] LinkedIn publish — personUrn=${personUrn} mediaType=${post.media_file_type || 'text'}`);

  // Determine media category and handle media upload if needed
  let shareMediaCategory = 'NONE';
  let mediaContent = [];

  if (post.media_url && post.media_file_type === 'image') {
    // Image post — register upload asset, upload the image, then create post
    shareMediaCategory = 'IMAGE';

    // Step 1: Register image upload
    const registerRes = await liCall(() => axios.post(
      'https://api.linkedin.com/v2/assets?action=registerUpload',
      {
        registerUploadRequest: {
          recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
          owner: personUrn,
          serviceRelationships: [{
            relationshipType: 'OWNER',
            identifier: 'urn:li:userGeneratedContent'
          }]
        }
      },
      { headers, timeout: TIMEOUT }
    ));

    const uploadUrl = registerRes.data.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
    const asset = registerRes.data.value.asset;

    // Step 2: Upload image binary from URL
    const imageRes = await axios.get(post.media_url, { responseType: 'arraybuffer', timeout: 60_000 });
    await liCall(() => axios.put(uploadUrl, imageRes.data, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/octet-stream'
      },
      timeout: 60_000
    }));

    mediaContent = [{
      status: 'READY',
      media: asset,
      description: { text: post.hook || 'Image' },
      title: { text: post.hook ? post.hook.slice(0, 100) : 'Image' }
    }];

  } else if (post.media_url && post.media_file_type === 'video') {
    // Video post — register upload asset, upload the video, then create post
    shareMediaCategory = 'VIDEO';

    // Step 1: Register video upload
    const registerRes = await liCall(() => axios.post(
      'https://api.linkedin.com/v2/assets?action=registerUpload',
      {
        registerUploadRequest: {
          recipes: ['urn:li:digitalmediaRecipe:feedshare-video'],
          owner: personUrn,
          serviceRelationships: [{
            relationshipType: 'OWNER',
            identifier: 'urn:li:userGeneratedContent'
          }]
        }
      },
      { headers, timeout: TIMEOUT }
    ));

    const uploadUrl = registerRes.data.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
    const asset = registerRes.data.value.asset;

    // Step 2: Upload video binary from URL
    const videoRes = await axios.get(post.media_url, { responseType: 'arraybuffer', timeout: 120_000 });
    await liCall(() => axios.put(uploadUrl, videoRes.data, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/octet-stream'
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 120_000
    }));

    mediaContent = [{
      status: 'READY',
      media: asset,
      description: { text: post.hook || 'Video' },
      title: { text: post.hook ? post.hook.slice(0, 100) : 'Video' }
    }];
  }

  // Create the UGC post
  const body = {
    author: personUrn,
    lifecycleState: 'PUBLISHED',
    specificContent: {
      'com.linkedin.ugc.ShareContent': {
        shareCommentary: { text },
        shareMediaCategory,
        ...(mediaContent.length > 0 && { media: mediaContent })
      }
    },
    visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
  };

  const res = await liCall(() => axios.post(
    'https://api.linkedin.com/v2/ugcPosts',
    body,
    { headers, timeout: TIMEOUT }
  ));

  const postId = res.headers['x-restli-id'] || res.data.id;
  console.log(`[PlatformAPIs] LinkedIn publish OK — postId=${postId}`);
  return { platformPostId: postId };
}

// ----------------------------------------------------------------
// X (TWITTER) — Twitter API v2
// Required .env: X_CLIENT_ID, X_CLIENT_SECRET
// Scopes needed: tweet.write, users.read (OAuth 2.0 with PKCE)
//
// Text tweets: single POST to /2/tweets — 280 char limit TOTAL (including hashtags)
// Image tweets: upload media via v1.1 media/upload → attach media_id to tweet
// Video tweets: chunked upload via v1.1 media/upload (INIT→APPEND→FINALIZE) → attach
//
// X uses OAuth 2.0 with PKCE for user auth but media upload still uses v1.1 endpoint.
// ----------------------------------------------------------------
async function publishToX(post, accessToken, connection) {
  const TIMEOUT = 30_000;

  // X error extractor
  const xCall = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err.response) {
        console.log('[PlatformAPIs] X raw error response:', JSON.stringify(err.response.data));
      } else {
        console.log('[PlatformAPIs] X network error (no response):', err.message);
      }
      const xErr = err.response?.data;
      // Twitter API v2 error format
      if (xErr?.detail) {
        throw new Error(`X error ${xErr.status || err.response?.status}: ${xErr.detail}`);
      }
      // Twitter API v2 errors array format
      if (xErr?.errors?.[0]) {
        throw new Error(`X error: ${xErr.errors[0].message}`);
      }
      throw err;
    }
  };

  // Build tweet text — must stay within 280 characters
  const hashtags = Array.isArray(post.hashtags)
    ? post.hashtags.slice(0, 3).map(h => (h.startsWith('#') ? h : `#${h}`)).join(' ')
    : '';
  const parts = [post.hook, hashtags, post.cta].filter(Boolean);
  const rawText = parts.join(' ').trim();
  if (rawText.length > 280) {
    console.warn(`[PlatformAPIs] X post is ${rawText.length}/280 chars — truncating. User should shorten content.`);
  }
  const text = rawText.slice(0, 280).trim();

  if (!text) {
    throw new Error('X requires text content. The post has no hook, hashtags, or CTA.');
  }

  console.log(`[PlatformAPIs] X publish — mediaType=${post.media_file_type || 'text'} textLen=${text.length}`);

  const tweetBody = { text };

  // If there's media, upload it first via v1.1 media/upload endpoint
  if (post.media_url && (post.media_file_type === 'image' || post.media_file_type === 'video')) {
    // Download the media file
    const mediaRes = await axios.get(post.media_url, { responseType: 'arraybuffer', timeout: 60_000 });
    const mediaBuffer = Buffer.from(mediaRes.data);

    if (post.media_file_type === 'image') {
      // Simple media upload for images
      const FormData = require('form-data');
      const form = new FormData();
      form.append('media_data', mediaBuffer.toString('base64'));

      const uploadRes = await xCall(() => axios.post(
        'https://upload.twitter.com/1.1/media/upload.json',
        form,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            ...form.getHeaders()
          },
          timeout: TIMEOUT
        }
      ));

      tweetBody.media = { media_ids: [uploadRes.data.media_id_string] };

    } else {
      // Chunked upload for video (INIT → APPEND → FINALIZE)
      const totalBytes = mediaBuffer.length;
      const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks

      // INIT
      const initRes = await xCall(() => axios.post(
        'https://upload.twitter.com/1.1/media/upload.json',
        null,
        {
          params: {
            command:          'INIT',
            total_bytes:      totalBytes,
            media_type:       'video/mp4',
            media_category:   'tweet_video'
          },
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: TIMEOUT
        }
      ));

      const mediaId = initRes.data.media_id_string;

      // APPEND — upload in chunks
      for (let i = 0; i * CHUNK_SIZE < totalBytes; i++) {
        const chunk = mediaBuffer.subarray(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const FormData = require('form-data');
        const form = new FormData();
        form.append('command', 'APPEND');
        form.append('media_id', mediaId);
        form.append('segment_index', String(i));
        form.append('media_data', chunk.toString('base64'));

        await xCall(() => axios.post(
          'https://upload.twitter.com/1.1/media/upload.json',
          form,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              ...form.getHeaders()
            },
            timeout: 60_000
          }
        ));
      }

      // FINALIZE
      const finalRes = await xCall(() => axios.post(
        'https://upload.twitter.com/1.1/media/upload.json',
        null,
        {
          params: { command: 'FINALIZE', media_id: mediaId },
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: TIMEOUT
        }
      ));

      // Poll for processing completion if needed
      if (finalRes.data.processing_info) {
        let processingInfo = finalRes.data.processing_info;
        while (processingInfo && processingInfo.state !== 'succeeded') {
          if (processingInfo.state === 'failed') {
            throw new Error(`X video processing failed: ${processingInfo.error?.message || 'unknown error'}`);
          }
          const waitSecs = processingInfo.check_after_secs || 5;
          await new Promise(resolve => setTimeout(resolve, waitSecs * 1000));

          const statusRes = await xCall(() => axios.get(
            'https://upload.twitter.com/1.1/media/upload.json',
            {
              params: { command: 'STATUS', media_id: mediaId },
              headers: { Authorization: `Bearer ${accessToken}` },
              timeout: TIMEOUT
            }
          ));
          processingInfo = statusRes.data.processing_info;
          console.log(`[PlatformAPIs] X video processing: ${processingInfo?.state || 'unknown'}`);
        }
      }

      tweetBody.media = { media_ids: [mediaId] };
    }
  }

  // Create the tweet
  const res = await xCall(() => axios.post(
    'https://api.twitter.com/2/tweets',
    tweetBody,
    {
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      timeout: TIMEOUT
    }
  ));

  const tweetId = res.data?.data?.id;
  if (!tweetId) {
    throw new Error(`X returned no tweet ID: ${JSON.stringify(res.data)}`);
  }

  console.log(`[PlatformAPIs] X publish OK — tweetId=${tweetId}`);
  return { platformPostId: tweetId };
}

// ----------------------------------------------------------------
// THREADS — Meta Threads API (two-step: create container → publish)
// Required .env: THREADS_APP_ID, THREADS_APP_SECRET
// Scopes needed: threads_basic, threads_content_publish
//
// Text posts: max 500 characters. No hashtags shown on Threads — don't append them.
// Image posts: media_type=IMAGE + image_url (public URL required)
// Video posts: media_type=VIDEO + video_url (public URL required)
//
// Flow: POST /me/threads (create container) → POST /me/threads_publish (publish)
// For video: poll container status until FINISHED before publishing.
// ----------------------------------------------------------------
async function publishToThreads(post, accessToken, connection) {
  const TIMEOUT = 30_000;
  const API_BASE = 'https://graph.threads.net/v1.0';

  // Threads error extractor (same Meta Graph API format)
  const thCall = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err.response) {
        console.log('[PlatformAPIs] Threads raw error response:', JSON.stringify(err.response.data));
      } else {
        console.log('[PlatformAPIs] Threads network error (no response):', err.message);
      }
      const fb = err.response?.data?.error;
      if (fb) {
        const sub = fb.error_subcode ? ` subcode=${fb.error_subcode}` : '';
        const msg = fb.error_user_msg || fb.message;
        throw new Error(`Threads error ${fb.code}${sub}: ${msg} (type: ${fb.type})`);
      }
      throw err;
    }
  };

  // Build text — no hashtags on Threads (they don't render), max 500 chars
  const rawText = [post.hook, post.caption, post.cta].filter(Boolean).join('\n\n');
  if (rawText.length > 500) {
    console.warn(`[PlatformAPIs] Threads post is ${rawText.length}/500 chars — truncating. User should shorten content.`);
  }
  const text = rawText.slice(0, 500);

  if (!text && !post.media_url) {
    throw new Error('Threads requires either text or media content.');
  }

  // Determine media type
  const isVideo = post.media_url && post.media_file_type === 'video';
  const isImage = post.media_url && post.media_file_type === 'image';

  console.log(`[PlatformAPIs] Threads publish — mediaType=${post.media_file_type || 'text'} textLen=${text.length}`);

  // ---- Step 1: Create media container ----
  const containerParams = { access_token: accessToken };

  if (isVideo) {
    containerParams.media_type = 'VIDEO';
    containerParams.video_url  = post.media_url;
    if (text) containerParams.text = text;
  } else if (isImage) {
    containerParams.media_type = 'IMAGE';
    containerParams.image_url  = post.media_url;
    if (text) containerParams.text = text;
  } else {
    containerParams.media_type = 'TEXT';
    containerParams.text       = text;
  }

  const containerRes = await thCall(() => axios.post(
    `${API_BASE}/me/threads`,
    null,
    { params: containerParams, timeout: TIMEOUT }
  ));

  const containerId = containerRes.data.id;
  console.log(`[PlatformAPIs] Threads container created — id=${containerId}`);

  // ---- Step 2: For video, poll until container is ready ----
  if (isVideo) {
    const MAX_POLLS = 30;
    const POLL_INTERVAL_MS = 10_000;

    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

      const statusRes = await thCall(() => axios.get(
        `${API_BASE}/${containerId}`,
        { params: { fields: 'status', access_token: accessToken }, timeout: TIMEOUT }
      ));

      const status = statusRes.data.status;
      console.log(`[PlatformAPIs] Threads container ${containerId} status: ${status} (poll ${i + 1}/${MAX_POLLS})`);

      if (status === 'FINISHED') break;
      if (status === 'ERROR') {
        throw new Error('Threads video processing failed. The video may be unsupported or too large.');
      }

      if (i === MAX_POLLS - 1) {
        throw new Error('Threads video processing timed out after 5 minutes.');
      }
    }
  }

  // ---- Step 3: Publish the container ----
  const publishRes = await thCall(() => axios.post(
    `${API_BASE}/me/threads_publish`,
    null,
    { params: { creation_id: containerId, access_token: accessToken }, timeout: TIMEOUT }
  ));

  console.log(`[PlatformAPIs] Threads publish OK — mediaId=${publishRes.data.id}`);
  return { platformPostId: publishRes.data.id };
}

// ----------------------------------------------------------------
// WHATSAPP — WhatsApp Business API (Cloud API via Meta)
// Required .env: WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN
//   (or use the same META_APP_ID token with whatsapp_business_messaging scope)
//
// WhatsApp Business API sends messages to opted-in contacts via templates
// or within a 24-hour customer service window. For "publishing" a post,
// we broadcast it as a message to the user's WhatsApp Channel (Channels API)
// or as a status update.
//
// WhatsApp Channels: POST /{phone-number-id}/messages with type=text/image/video
// Status updates: POST /{phone-number-id}/messages to status broadcast list
//
// Note: WhatsApp is messaging-first, not feed-based. "Publishing" here means
// sending a broadcast message to the user's WhatsApp Channel or status.
// ----------------------------------------------------------------
async function publishToWhatsApp(post, accessToken, connection) {
  const TIMEOUT = 30_000;
  const phoneNumberId = connection.platform_user_id;

  // Build message text
  const hashtags = Array.isArray(post.hashtags)
    ? post.hashtags.map(h => (h.startsWith('#') ? h : `#${h}`)).join(' ')
    : '';
  const text = [post.hook, post.caption, hashtags, post.cta].filter(Boolean).join('\n\n');

  if (!text && !post.media_url) {
    throw new Error('WhatsApp requires either text or media content.');
  }

  // WhatsApp error extractor (Meta Graph API format)
  const waCall = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err.response) {
        console.log('[PlatformAPIs] WhatsApp raw error response:', JSON.stringify(err.response.data));
      } else {
        console.log('[PlatformAPIs] WhatsApp network error (no response):', err.message);
      }
      const waErr = err.response?.data?.error;
      if (waErr) {
        throw new Error(`WhatsApp error ${waErr.code}: ${waErr.message} (type: ${waErr.type})`);
      }
      throw err;
    }
  };

  console.log(`[PlatformAPIs] WhatsApp publish — phoneNumberId=${phoneNumberId} mediaType=${post.media_file_type || 'text'}`);

  let messageBody;

  if (post.media_url && post.media_file_type === 'image') {
    // Image message
    messageBody = {
      messaging_product: 'whatsapp',
      recipient_type:    'broadcast',
      type:              'image',
      image: {
        link:    post.media_url,
        caption: text.slice(0, 1024)  // WhatsApp caption limit
      }
    };
  } else if (post.media_url && post.media_file_type === 'video') {
    // Video message
    messageBody = {
      messaging_product: 'whatsapp',
      recipient_type:    'broadcast',
      type:              'video',
      video: {
        link:    post.media_url,
        caption: text.slice(0, 1024)
      }
    };
  } else {
    // Text-only message
    messageBody = {
      messaging_product: 'whatsapp',
      recipient_type:    'broadcast',
      type:              'text',
      text: { body: text.slice(0, 4096) }  // WhatsApp text limit
    };
  }

  const res = await waCall(() => axios.post(
    `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
    messageBody,
    {
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      timeout: TIMEOUT
    }
  ));

  const messageId = res.data?.messages?.[0]?.id || res.data?.id;
  if (!messageId) {
    throw new Error(`WhatsApp returned no message ID: ${JSON.stringify(res.data)}`);
  }

  console.log(`[PlatformAPIs] WhatsApp publish OK — messageId=${messageId}`);
  return { platformPostId: messageId };
}

// ----------------------------------------------------------------
// TELEGRAM — Telegram Bot API
// Required .env: TELEGRAM_BOT_TOKEN
//
// Telegram uses a Bot Token (not OAuth). The "access_token" stored in
// platform_connections is the bot token. connection.platform_user_id is
// the channel username (e.g. @mychannel) or chat_id.
//
// Text posts:  POST /sendMessage with chat_id + text (Markdown supported)
// Image posts: POST /sendPhoto with chat_id + photo URL + caption
// Video posts: POST /sendVideo with chat_id + video URL + caption
//
// No OAuth flow needed — user enters bot token + channel ID in settings.
// ----------------------------------------------------------------
async function publishToTelegram(post, accessToken, connection) {
  const TIMEOUT = 30_000;
  const botToken = accessToken;
  const chatId   = connection.platform_user_id;  // @channelname or numeric chat_id

  // Build message text
  const hashtags = Array.isArray(post.hashtags)
    ? post.hashtags.map(h => (h.startsWith('#') ? h : `#${h}`)).join(' ')
    : '';
  const text = [post.hook, post.caption, hashtags, post.cta].filter(Boolean).join('\n\n');

  if (!text && !post.media_url) {
    throw new Error('Telegram requires either text or media content.');
  }

  // Telegram error extractor
  const tgCall = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err.response) {
        console.log('[PlatformAPIs] Telegram raw error response:', JSON.stringify(err.response.data));
      } else {
        console.log('[PlatformAPIs] Telegram network error (no response):', err.message);
      }
      const tgErr = err.response?.data;
      if (tgErr?.description) {
        throw new Error(`Telegram error ${tgErr.error_code}: ${tgErr.description}`);
      }
      throw err;
    }
  };

  console.log(`[PlatformAPIs] Telegram publish — chatId=${chatId} mediaType=${post.media_file_type || 'text'}`);

  const API_BASE = `https://api.telegram.org/bot${botToken}`;
  let res;

  if (post.media_url && post.media_file_type === 'image') {
    // Send photo with caption
    res = await tgCall(() => axios.post(`${API_BASE}/sendPhoto`, {
      chat_id:    chatId,
      photo:      post.media_url,
      caption:    text.slice(0, 1024),  // Telegram caption limit
      parse_mode: 'Markdown'
    }, { timeout: TIMEOUT }));

  } else if (post.media_url && post.media_file_type === 'video') {
    // Send video with caption
    res = await tgCall(() => axios.post(`${API_BASE}/sendVideo`, {
      chat_id:    chatId,
      video:      post.media_url,
      caption:    text.slice(0, 1024),
      parse_mode: 'Markdown'
    }, { timeout: TIMEOUT }));

  } else {
    // Text-only message
    res = await tgCall(() => axios.post(`${API_BASE}/sendMessage`, {
      chat_id:    chatId,
      text:       text.slice(0, 4096),  // Telegram message limit
      parse_mode: 'Markdown'
    }, { timeout: TIMEOUT }));
  }

  const messageId = res.data?.result?.message_id;
  if (!messageId) {
    throw new Error(`Telegram returned no message_id: ${JSON.stringify(res.data)}`);
  }

  console.log(`[PlatformAPIs] Telegram publish OK — messageId=${messageId}`);
  return { platformPostId: String(messageId) };
}

// ================================================================
// METRICS FETCHERS — return zero data until credentials are wired up.
//
// Quick implementation reference:
//   Instagram: GET /{media-id}/insights?metric=impressions,reach,likes,comments,shares,saved&access_token=
//   Facebook:  GET /{post-id}/insights?metric=post_impressions,post_reactions_by_type_total
//   TikTok:    POST /video/query/ { filters: { video_ids: [postId] } }
//   LinkedIn:  GET /socialActions/{ugcPostUrn} for reactions/comments
//   X:         GET /tweets/{id}?tweet.fields=public_metrics
//   Threads:   GET /{media_id}/insights?metric=likes,replies,reposts,views
//   WhatsApp:  No public metrics API — message status only (sent/delivered/read)
//   Telegram:  No public metrics API for channels yet
// ================================================================

function emptyMetrics() {
  return { likes:0, comments:0, shares:0, saves:0, reach:0, impressions:0, clicks:0, video_views:0 };
}

// ----------------------------------------------------------------
// fetchFacebookMetrics — Page post insights via Graph API.
//
// API: GET /{post-id}?fields=shares
//      GET /{post-id}/insights?metric=post_impressions,post_impressions_unique,
//            post_clicks,post_reactions_by_type_total,post_video_views_organic
//
// Note: Page Insights require 'pages_read_engagement' scope.
// Video metrics only returned for video posts (otherwise 0).
// ----------------------------------------------------------------
async function fetchFacebookMetrics(postId, accessToken) {
  try {
    // Fetch basic engagement counts + shares from the post object itself
    const [postRes, insightsRes] = await Promise.all([
      axios.get(`https://graph.facebook.com/v21.0/${postId}`, {
        params: { fields: 'shares,likes.summary(true),comments.summary(true)', access_token: accessToken },
        timeout: 30_000
      }).catch(() => null),
      axios.get(`https://graph.facebook.com/v21.0/${postId}/insights`, {
        params: {
          metric: 'post_impressions,post_impressions_unique,post_clicks,post_video_views_organic',
          access_token: accessToken
        },
        timeout: 30_000
      }).catch(() => null)
    ]);

    // Parse the insights response — each metric is an object in data[]
    const insights = {};
    (insightsRes?.data?.data || []).forEach(m => {
      insights[m.name] = m.values?.[0]?.value || 0;
    });

    return {
      likes:       postRes?.data?.likes?.summary?.total_count || 0,
      comments:    postRes?.data?.comments?.summary?.total_count || 0,
      shares:      postRes?.data?.shares?.count || 0,
      saves:       0, // Facebook doesn't expose saves count via API
      reach:       insights.post_impressions_unique || 0,
      impressions: insights.post_impressions || 0,
      clicks:      insights.post_clicks || 0,
      video_views: insights.post_video_views_organic || 0
    };
  } catch (err) {
    console.error('[PlatformAPIs] Facebook metrics error:', err.message);
    return emptyMetrics();
  }
}

// ----------------------------------------------------------------
// fetchInstagramMetrics — Media insights via Graph API.
//
// API: GET /{media-id}/insights?metric=impressions,reach,likes,comments,shares,saved
//
// Note: Requires 'instagram_basic' scope. Insights have a 24–48hr delay.
// Some metrics may not be available for very old posts.
// ----------------------------------------------------------------
async function fetchInstagramMetrics(postId, accessToken) {
  try {
    const res = await axios.get(
      `https://graph.facebook.com/v21.0/${postId}/insights`,
      {
        params: {
          metric: 'impressions,reach,likes,comments,shares,saved,video_views',
          access_token: accessToken
        },
        timeout: 30_000
      }
    );

    // Parse insights — each metric is an object in data[]
    const insights = {};
    (res.data?.data || []).forEach(m => {
      insights[m.name] = m.values?.[0]?.value || 0;
    });

    return {
      likes:       insights.likes || 0,
      comments:    insights.comments || 0,
      shares:      insights.shares || 0,
      saves:       insights.saved || 0,
      reach:       insights.reach || 0,
      impressions: insights.impressions || 0,
      clicks:      0, // Instagram doesn't expose link clicks for feed posts
      video_views: insights.video_views || 0
    };
  } catch (err) {
    // Instagram returns an error for metrics not available on the post type
    // (e.g. video_views on a photo). This is expected — return what we got.
    console.error('[PlatformAPIs] Instagram metrics error:', err.message);
    return emptyMetrics();
  }
}

// ----------------------------------------------------------------
// fetchTikTokMetrics — Video query via TikTok Content Posting API.
//
// API: POST https://open.tiktokapis.com/v2/video/query/
//      Body: { filters: { video_ids: [postId] } }
//
// Note: Only returns metrics for videos posted via the API (which we do).
// Requires 'video.publish' scope.
// ----------------------------------------------------------------
async function fetchTikTokMetrics(postId, accessToken) {
  try {
    const res = await axios.post(
      'https://open.tiktokapis.com/v2/video/query/',
      { filters: { video_ids: [postId] } },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 30_000
      }
    );

    const video = res.data?.data?.videos?.[0];
    if (!video) return emptyMetrics();

    return {
      likes:       video.like_count || 0,
      comments:    video.comment_count || 0,
      shares:      video.share_count || 0,
      saves:       0, // TikTok API doesn't expose saves
      reach:       0, // TikTok API doesn't expose reach
      impressions: video.view_count || 0, // view_count is the closest to impressions
      clicks:      0,
      video_views: video.view_count || 0
    };
  } catch (err) {
    console.error('[PlatformAPIs] TikTok metrics error:', err.message);
    return emptyMetrics();
  }
}

// ----------------------------------------------------------------
// fetchLinkedInMetrics — UGC post social actions via LinkedIn API.
//
// API: GET /socialActions/{ugcPostUrn}
//
// Note: Requires 'w_member_social' scope. The postId stored in our DB
// is the UGC post URN (e.g. "urn:li:ugcPost:12345").
// ----------------------------------------------------------------
async function fetchLinkedInMetrics(postId, accessToken) {
  try {
    // URL-encode the URN since it contains colons
    const encodedUrn = encodeURIComponent(postId);
    const res = await axios.get(
      `https://api.linkedin.com/v2/socialActions/${encodedUrn}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-Restli-Protocol-Version': '2.0.0'
        },
        timeout: 30_000
      }
    );

    const data = res.data || {};
    return {
      likes:       data.likesSummary?.totalLikes || 0,
      comments:    data.commentsSummary?.totalFirstLevelComments || 0,
      shares:      data.sharesSummary?.totalShares || 0,
      saves:       0,
      reach:       0, // LinkedIn doesn't expose reach via this endpoint
      impressions: 0, // Requires separate analytics endpoint with partner access
      clicks:      0,
      video_views: 0
    };
  } catch (err) {
    console.error('[PlatformAPIs] LinkedIn metrics error:', err.message);
    return emptyMetrics();
  }
}

// ----------------------------------------------------------------
// fetchXMetrics — Tweet public metrics via X API v2.
//
// API: GET /tweets/{id}?tweet.fields=public_metrics
//
// Note: Requires OAuth 2.0 user context. Rate limit: 450 req / 15 min.
// ----------------------------------------------------------------
async function fetchXMetrics(postId, accessToken) {
  try {
    const res = await axios.get(
      `https://api.x.com/2/tweets/${postId}`,
      {
        params: { 'tweet.fields': 'public_metrics' },
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 30_000
      }
    );

    const m = res.data?.data?.public_metrics || {};
    return {
      likes:       m.like_count || 0,
      comments:    m.reply_count || 0,
      shares:      (m.retweet_count || 0) + (m.quote_count || 0),
      saves:       m.bookmark_count || 0,
      reach:       0, // Not available via public_metrics
      impressions: m.impression_count || 0,
      clicks:      0,
      video_views: 0
    };
  } catch (err) {
    console.error('[PlatformAPIs] X metrics error:', err.message);
    return emptyMetrics();
  }
}

// ----------------------------------------------------------------
// fetchThreadsMetrics — Media insights via Threads API.
//
// API: GET /{media_id}/insights?metric=likes,replies,reposts,views
//
// Note: Requires 'threads_basic' scope. API is relatively new —
// some metrics may not be available for all post types.
// ----------------------------------------------------------------
async function fetchThreadsMetrics(postId, accessToken) {
  try {
    const res = await axios.get(
      `https://graph.threads.net/v1.0/${postId}/insights`,
      {
        params: {
          metric: 'likes,replies,reposts,views',
          access_token: accessToken
        },
        timeout: 30_000
      }
    );

    const insights = {};
    (res.data?.data || []).forEach(m => {
      insights[m.name] = m.values?.[0]?.value || 0;
    });

    return {
      likes:       insights.likes || 0,
      comments:    insights.replies || 0,
      shares:      insights.reposts || 0,
      saves:       0,
      reach:       0,
      impressions: insights.views || 0,
      clicks:      0,
      video_views: 0
    };
  } catch (err) {
    console.error('[PlatformAPIs] Threads metrics error:', err.message);
    return emptyMetrics();
  }
}

// WhatsApp and Telegram are messaging platforms — no public post metrics API
async function fetchWhatsAppMetrics(postId, accessToken) { return emptyMetrics(); }
async function fetchTelegramMetrics(postId, accessToken) { return emptyMetrics(); }

// ================================================================
// COMMENT FETCHERS — return empty arrays until credentials are wired up.
//
// Quick implementation reference:
//   Instagram: GET /{media-id}/comments?fields=id,text,username,timestamp
//   Facebook:  GET /{post-id}/comments?fields=id,message,from,created_time
//   TikTok:    GET /video/comment/list/?video_id={id}
//   LinkedIn:  GET /socialActions/{ugcPostUrn}/comments
//   X:         GET /tweets/search/recent?query=conversation_id:{id}
//   Threads:   GET /{media_id}/replies?fields=id,text,username,timestamp
//   WhatsApp:  No comment concept — messaging platform
//   Telegram:  No comment API for channel posts yet
// ================================================================

// ----------------------------------------------------------------
// fetchFacebookComments — fetches comments on a Facebook Page post.
//
// API: GET /{post-id}/comments?fields=id,message,from,created_time
// The 'from' field contains { name, id } where 'id' is the commenter's
// Page-Scoped User ID (PSID) — this is what we need to send DMs.
//
// Note: 'from' is only returned if the user has granted 'pages_read_engagement'.
// ----------------------------------------------------------------
async function fetchFacebookComments(postId, accessToken, since) {
  try {
    const params = {
      fields:       'id,message,from,created_time',
      access_token: accessToken,
      limit:        100
    };
    if (since) params.since = since;

    const res = await axios.get(
      `https://graph.facebook.com/v21.0/${postId}/comments`,
      { params, timeout: 30_000 }
    );

    const comments = (res.data?.data || []).map(c => ({
      platformCommentId: c.id,
      text:              c.message || '',
      authorHandle:      c.from?.name || 'Unknown',
      authorPlatformId:  c.from?.id || null,    // PSID — needed for DM sending
      timestamp:         c.created_time
    }));

    // Filter by timestamp if a 'since' cursor was provided
    if (since) {
      const sinceDate = new Date(since);
      return comments.filter(c => new Date(c.timestamp) > sinceDate);
    }

    return comments;
  } catch (err) {
    const fbErr = err.response?.data?.error;
    if (fbErr) {
      console.error(`[PlatformAPIs] Facebook comments error ${fbErr.code}: ${fbErr.message}`);
    } else {
      console.error('[PlatformAPIs] Facebook comments error:', err.message);
    }
    return [];
  }
}

// ----------------------------------------------------------------
// fetchInstagramComments — fetches comments on an Instagram media post.
//
// API: GET /{media-id}/comments?fields=id,text,username,timestamp,from
// The 'from' field contains { id } which is the commenter's Instagram-Scoped
// User ID (IGSID) — this is what we need to send DMs via Instagram Messaging API.
//
// Note: 'from' requires 'instagram_manage_comments' or 'instagram_basic' scope.
// ----------------------------------------------------------------
async function fetchInstagramComments(postId, accessToken, since) {
  try {
    const params = {
      fields:       'id,text,username,timestamp,from',
      access_token: accessToken,
      limit:        100
    };

    const res = await axios.get(
      `https://graph.facebook.com/v21.0/${postId}/comments`,
      { params, timeout: 30_000 }
    );

    const comments = (res.data?.data || []).map(c => ({
      platformCommentId: c.id,
      text:              c.text || '',
      authorHandle:      c.username || 'Unknown',
      authorPlatformId:  c.from?.id || null,    // IGSID — needed for DM sending
      timestamp:         c.timestamp
    }));

    // Filter by timestamp if a 'since' cursor was provided
    if (since) {
      const sinceDate = new Date(since);
      return comments.filter(c => new Date(c.timestamp) > sinceDate);
    }

    return comments;
  } catch (err) {
    const fbErr = err.response?.data?.error;
    if (fbErr) {
      console.error(`[PlatformAPIs] Instagram comments error ${fbErr.code}: ${fbErr.message}`);
    } else {
      console.error('[PlatformAPIs] Instagram comments error:', err.message);
    }
    return [];
  }
}
// ----------------------------------------------------------------
// fetchTikTokComments — fetches comments on a TikTok video.
//
// API: POST https://open.tiktokapis.com/v2/comment/list/
//      Body: { video_id, max_count: 50 }
//
// Note: TikTok's comment API has limited access. Returns comment text
// and basic author info but author IDs are not usable for DMs.
// ----------------------------------------------------------------
async function fetchTikTokComments(postId, accessToken, since) {
  try {
    const res = await axios.post(
      'https://open.tiktokapis.com/v2/comment/list/',
      { video_id: postId, max_count: 50 },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 30_000
      }
    );

    let comments = (res.data?.data?.comments || []).map(c => ({
      platformCommentId: c.id,
      text:              c.text || '',
      authorHandle:      c.user?.display_name || c.user?.username || 'Unknown',
      authorPlatformId:  c.user?.user_id || null,
      timestamp:         c.create_time ? new Date(c.create_time * 1000).toISOString() : new Date().toISOString()
    }));

    if (since) {
      const sinceDate = new Date(since);
      comments = comments.filter(c => new Date(c.timestamp) > sinceDate);
    }

    return comments;
  } catch (err) {
    console.error('[PlatformAPIs] TikTok comments error:', err.message);
    return [];
  }
}

// ----------------------------------------------------------------
// fetchLinkedInComments — fetches comments on a LinkedIn UGC post.
//
// API: GET /socialActions/{ugcPostUrn}/comments
//
// Note: Requires 'w_member_social' scope. Author is returned as a
// LinkedIn URN (e.g. "urn:li:person:XXXXXXX"), not a username.
// ----------------------------------------------------------------
async function fetchLinkedInComments(postId, accessToken, since) {
  try {
    const encodedUrn = encodeURIComponent(postId);
    const res = await axios.get(
      `https://api.linkedin.com/v2/socialActions/${encodedUrn}/comments`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'X-Restli-Protocol-Version': '2.0.0'
        },
        timeout: 30_000
      }
    );

    let comments = (res.data?.elements || []).map(c => ({
      platformCommentId: c.$URN || c.id || '',
      text:              c.message?.text || '',
      authorHandle:      c.actor || 'Unknown',       // LinkedIn returns actor URN
      authorPlatformId:  c.actor || null,             // URN like urn:li:person:XXXXX
      timestamp:         c.created?.time ? new Date(c.created.time).toISOString() : new Date().toISOString()
    }));

    if (since) {
      const sinceDate = new Date(since);
      comments = comments.filter(c => new Date(c.timestamp) > sinceDate);
    }

    return comments;
  } catch (err) {
    console.error('[PlatformAPIs] LinkedIn comments error:', err.message);
    return [];
  }
}

// ----------------------------------------------------------------
// fetchXComments — fetches replies to a tweet via X API v2 search.
//
// API: GET /tweets/search/recent?query=conversation_id:{tweetId}
//      &tweet.fields=created_at,author_id
//      &expansions=author_id
//      &user.fields=username
//
// Note: Rate limit 450 req / 15 min. Only returns replies from the
// last 7 days (Twitter API limitation for recent search).
// ----------------------------------------------------------------
async function fetchXComments(postId, accessToken, since) {
  try {
    const params = {
      query:          `conversation_id:${postId}`,
      'tweet.fields': 'created_at,author_id',
      expansions:     'author_id',
      'user.fields':  'username',
      max_results:    100
    };
    if (since) params.start_time = new Date(since).toISOString();

    const res = await axios.get(
      'https://api.x.com/2/tweets/search/recent',
      {
        params,
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 30_000
      }
    );

    // Build a map of author_id → username from the includes.users expansion
    const userMap = {};
    (res.data?.includes?.users || []).forEach(u => {
      userMap[u.id] = u.username;
    });

    let comments = (res.data?.data || []).map(t => ({
      platformCommentId: t.id,
      text:              t.text || '',
      authorHandle:      userMap[t.author_id] || 'Unknown',
      authorPlatformId:  t.author_id || null,
      timestamp:         t.created_at
    }));

    if (since && !params.start_time) {
      const sinceDate = new Date(since);
      comments = comments.filter(c => new Date(c.timestamp) > sinceDate);
    }

    return comments;
  } catch (err) {
    console.error('[PlatformAPIs] X comments error:', err.message);
    return [];
  }
}

// ----------------------------------------------------------------
// fetchThreadsComments — fetches replies on a Threads post.
//
// API: GET /{media_id}/replies?fields=id,text,username,timestamp
//
// Note: Requires 'threads_basic' scope. API is relatively new.
// ----------------------------------------------------------------
async function fetchThreadsComments(postId, accessToken, since) {
  try {
    const res = await axios.get(
      `https://graph.threads.net/v1.0/${postId}/replies`,
      {
        params: {
          fields:       'id,text,username,timestamp',
          access_token: accessToken
        },
        timeout: 30_000
      }
    );

    let comments = (res.data?.data || []).map(c => ({
      platformCommentId: c.id,
      text:              c.text || '',
      authorHandle:      c.username || 'Unknown',
      authorPlatformId:  null, // Threads doesn't expose user IDs for DMs yet
      timestamp:         c.timestamp
    }));

    if (since) {
      const sinceDate = new Date(since);
      comments = comments.filter(c => new Date(c.timestamp) > sinceDate);
    }

    return comments;
  } catch (err) {
    console.error('[PlatformAPIs] Threads comments error:', err.message);
    return [];
  }
}

// WhatsApp and Telegram are messaging platforms — no comment concept
async function fetchWhatsAppComments(postId, accessToken, since) { return []; }
async function fetchTelegramComments(postId, accessToken, since) { return []; }

// ================================================================
// TOKEN REFRESH
// After refreshing, the caller should update the DB record.
// Standard OAuth2 refresh_token grant:
//   POST {tokenEndpoint} { grant_type: 'refresh_token', refresh_token, client_id, client_secret }
// ================================================================
async function refreshAccessToken(connection) {
  console.warn(`[PlatformAPIs] Token refresh for ${connection.platform} not yet implemented. Using existing token.`);
  return decryptToken(connection.access_token);
}

module.exports = { publish, fetchMetrics, fetchComments };
