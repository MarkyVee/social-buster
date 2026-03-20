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

// ================================================================
// MAIN ENTRY POINTS
// ================================================================

/**
 * publish — decrypts the token and routes to the correct platform publisher.
 * @returns {{ platformPostId: string }}
 */
async function publish(post, connection) {
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
    case 'instagram': return publishToInstagram(post, accessToken, connection);
    case 'facebook':  return publishToFacebook(post, accessToken, connection);
    case 'tiktok':    return publishToTikTok(post, accessToken, connection);
    case 'linkedin':  return publishToLinkedIn(post, accessToken, connection);
    case 'x':         return publishToX(post, accessToken, connection);
    case 'threads':   return publishToThreads(post, accessToken, connection);
    case 'youtube':   return publishToYoutube(post, accessToken, connection);
    default:
      throw new Error(`Unsupported platform: "${connection.platform}"`);
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
    case 'youtube':   return fetchYouTubeMetrics(platformPostId, accessToken);
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
    case 'youtube':   return fetchYouTubeComments(platformPostId, accessToken, sinceTimestamp);
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

  // ---- Step 2: For video, poll until container is ready ----
  // Instagram processes video asynchronously. The container goes through:
  //   IN_PROGRESS → FINISHED (ready to publish)
  //   IN_PROGRESS → ERROR (upload/encoding failed)
  // Images are ready immediately — skip polling.
  if (isVideo) {
    const MAX_POLLS = 30;         // 30 polls × 10 seconds = 5 minutes max wait
    const POLL_INTERVAL_MS = 10_000;

    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

      const statusRes = await igCall(() => axios.get(
        `${API_BASE}/${containerId}`,
        { params: { fields: 'status_code', access_token: accessToken }, timeout: TIMEOUT }
      ));

      const status = statusRes.data.status_code;
      console.log(`[PlatformAPIs] IG container ${containerId} status: ${status} (poll ${i + 1}/${MAX_POLLS})`);

      if (status === 'FINISHED') break;
      if (status === 'ERROR') {
        throw new Error('Instagram video processing failed. The video may be in an unsupported format or too large.');
      }

      if (i === MAX_POLLS - 1) {
        throw new Error('Instagram video processing timed out after 5 minutes. Try a shorter video.');
      }
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
// post.media_url must be a publicly accessible video URL
//
// async function publishToTikTok(post, accessToken, connection) {
//   const caption = [post.hook, post.hashtags.map(h=>'#'+h).join(' ')]
//     .filter(Boolean).join(' ').slice(0, 2200);
//   const res = await axios.post(
//     'https://open.tiktokapis.com/v2/post/publish/video/init/',
//     {
//       post_info: { title: caption, privacy_level: 'PUBLIC_TO_EVERYONE',
//                    disable_duet: false, disable_comment: false, disable_stitch: false },
//       source_info: { source: 'PULL_FROM_URL', video_url: post.media_url }
//     },
//     { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json; charset=UTF-8' } }
//   );
//   return { platformPostId: res.data.data.publish_id };
// }
// ----------------------------------------------------------------
async function publishToTikTok(post, accessToken, connection) {
  console.warn('[PlatformAPIs] TikTok not configured. Add TIKTOK_CLIENT_KEY/SECRET to .env.');
  throw new Error('TikTok publishing requires OAuth setup. See services/platformAPIs.js.');
}

// ----------------------------------------------------------------
// LINKEDIN — LinkedIn API v2 (UGC Posts)
// Required .env: LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET
// Scopes needed: w_member_social
//
// async function publishToLinkedIn(post, accessToken, connection) {
//   const text = [post.hook, post.caption, post.hashtags.map(h=>'#'+h).join(' '), post.cta]
//     .filter(Boolean).join('\n\n');
//   const body = {
//     author: `urn:li:person:${connection.platform_user_id}`,
//     lifecycleState: 'PUBLISHED',
//     specificContent: {
//       'com.linkedin.ugc.ShareContent': {
//         shareCommentary: { text },
//         shareMediaCategory: 'NONE'
//       }
//     },
//     visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
//   };
//   const res = await axios.post('https://api.linkedin.com/v2/ugcPosts', body, {
//     headers: { Authorization: `Bearer ${accessToken}`, 'X-Restli-Protocol-Version': '2.0.0' }
//   });
//   return { platformPostId: res.headers['x-restli-id'] };
// }
// ----------------------------------------------------------------
async function publishToLinkedIn(post, accessToken, connection) {
  console.warn('[PlatformAPIs] LinkedIn not configured. Add LINKEDIN_CLIENT_ID/SECRET to .env.');
  throw new Error('LinkedIn publishing requires OAuth setup. See services/platformAPIs.js.');
}

// ----------------------------------------------------------------
// X (TWITTER) — Twitter API v2
// Required .env: X_CLIENT_ID, X_CLIENT_SECRET
// Scopes needed: tweet.write (OAuth 2.0 with PKCE)
// Full tweet including hashtags must be ≤ 280 characters
//
// async function publishToX(post, accessToken, connection) {
//   const text = [post.hook, post.hashtags.slice(0,2).map(h=>'#'+h).join(' '), post.cta]
//     .filter(Boolean).join(' ').slice(0, 280).trim();
//   const res = await axios.post(
//     'https://api.twitter.com/2/tweets', { text },
//     { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
//   );
//   return { platformPostId: res.data.data.id };
// }
// ----------------------------------------------------------------
async function publishToX(post, accessToken, connection) {
  console.warn('[PlatformAPIs] X not configured. Add X_CLIENT_ID/SECRET to .env.');
  throw new Error('X publishing requires OAuth setup. See services/platformAPIs.js.');
}

// ----------------------------------------------------------------
// THREADS — Meta Threads API (two-step: create container → publish)
// Required .env: THREADS_APP_ID, THREADS_APP_SECRET
// Scopes needed: threads_basic, threads_content_publish
// Text posts max 500 characters. No hashtags shown in Threads.
//
// async function publishToThreads(post, accessToken, connection) {
//   const text = [post.hook, post.caption, post.cta].filter(Boolean).join('\n\n').slice(0, 500);
//   const step1 = await axios.post(
//     'https://graph.threads.net/v1.0/me/threads', null,
//     { params: { media_type: 'TEXT', text, access_token: accessToken } }
//   );
//   const step2 = await axios.post(
//     'https://graph.threads.net/v1.0/me/threads_publish', null,
//     { params: { creation_id: step1.data.id, access_token: accessToken } }
//   );
//   return { platformPostId: step2.data.id };
// }
// ----------------------------------------------------------------
async function publishToThreads(post, accessToken, connection) {
  console.warn('[PlatformAPIs] Threads not configured. Add THREADS_APP_ID/SECRET to .env.');
  throw new Error('Threads publishing requires OAuth setup. See services/platformAPIs.js.');
}

// ----------------------------------------------------------------
// YOUTUBE — YouTube Data API v3 (video upload)
// Required .env: YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET (Google OAuth)
// Scopes needed: https://www.googleapis.com/auth/youtube.upload
// npm install googleapis
//
// async function publishToYoutube(post, accessToken, connection) {
//   const { google } = require('googleapis');
//   const auth = new google.auth.OAuth2(process.env.YOUTUBE_CLIENT_ID, process.env.YOUTUBE_CLIENT_SECRET);
//   auth.setCredentials({ access_token: accessToken });
//   const youtube = google.youtube({ version: 'v3', auth });
//   const https = require('https');
//   const videoStream = await new Promise((resolve, reject) =>
//     https.get(post.media_url, resolve).on('error', reject)
//   );
//   const res = await youtube.videos.insert({
//     part: ['snippet', 'status'],
//     requestBody: {
//       snippet: { title: post.hook.slice(0,100), description: `${post.caption}\n\n${post.cta}`, tags: post.hashtags },
//       status: { privacyStatus: 'public' }
//     },
//     media: { body: videoStream }
//   });
//   return { platformPostId: res.data.id };
// }
// ----------------------------------------------------------------
async function publishToYoutube(post, accessToken, connection) {
  console.warn('[PlatformAPIs] YouTube not configured. Add YOUTUBE_CLIENT_ID/SECRET to .env.');
  throw new Error('YouTube publishing requires OAuth setup. See services/platformAPIs.js.');
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
//   YouTube:   GET /videos?part=statistics&id={videoId}
// ================================================================

function emptyMetrics() {
  return { likes:0, comments:0, shares:0, saves:0, reach:0, impressions:0, clicks:0, video_views:0 };
}

async function fetchInstagramMetrics(postId, accessToken) { return emptyMetrics(); }
async function fetchFacebookMetrics(postId, accessToken)  { return emptyMetrics(); }
async function fetchTikTokMetrics(postId, accessToken)    { return emptyMetrics(); }
async function fetchLinkedInMetrics(postId, accessToken)  { return emptyMetrics(); }
async function fetchXMetrics(postId, accessToken)         { return emptyMetrics(); }
async function fetchThreadsMetrics(postId, accessToken)   { return emptyMetrics(); }
async function fetchYouTubeMetrics(postId, accessToken)   { return emptyMetrics(); }

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
//   YouTube:   GET /commentThreads?videoId={id}&part=snippet
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
async function fetchTikTokComments(postId, accessToken, since)    { return []; }
async function fetchLinkedInComments(postId, accessToken, since)  { return []; }
async function fetchXComments(postId, accessToken, since)         { return []; }
async function fetchThreadsComments(postId, accessToken, since)   { return []; }
async function fetchYouTubeComments(postId, accessToken, since)   { return []; }

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
