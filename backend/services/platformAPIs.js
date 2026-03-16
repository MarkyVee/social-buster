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
 * @returns {Array<{ platformCommentId, text, authorHandle, timestamp }>}
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
// Required .env: INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET
// Scopes needed: instagram_basic, instagram_content_publish
// Docs: developers.facebook.com/docs/instagram-api/guides/content-publishing
//
// async function publishToInstagram(post, accessToken, connection) {
//   const caption = [post.hook, post.caption, post.hashtags.map(h => '#'+h).join(' '), post.cta]
//     .filter(Boolean).join('\n\n');
//   const isVideo = post.media_url && /\.(mp4|mov)$/i.test(post.media_url);
//   const containerParams = { caption, access_token: accessToken };
//   if (post.media_url) {
//     containerParams[isVideo ? 'video_url' : 'image_url'] = post.media_url;
//     if (isVideo) containerParams.media_type = 'REELS';
//   } else {
//     throw new Error('Instagram requires a media URL (image or video)');
//   }
//   const container = await axios.post(
//     'https://graph.instagram.com/v19.0/me/media', null, { params: containerParams }
//   );
//   const publish = await axios.post(
//     'https://graph.instagram.com/v19.0/me/media_publish', null,
//     { params: { creation_id: container.data.id, access_token: accessToken } }
//   );
//   return { platformPostId: publish.data.id };
// }
// ----------------------------------------------------------------
async function publishToInstagram(post, accessToken, connection) {
  console.warn('[PlatformAPIs] Instagram not configured. Add INSTAGRAM_APP_ID/SECRET to .env.');
  throw new Error('Instagram publishing requires OAuth setup. See services/platformAPIs.js.');
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
  // Google Drive URLs are not publicly fetchable by Facebook's servers.
  const isGoogleDrive = post.media_url && post.media_url.includes('drive.google.com');

  // For actual photo/video uploads the Graph API requires separate upload steps —
  // those are handled below if media_local_path is present (image) or media_url (video).
  if (post.media_local_path && post.media_file_type === 'image') {
    // Image from local temp file — upload via multipart to /{page-id}/photos
    const FormData = require('form-data');
    const fs       = require('fs');
    const form     = new FormData();
    form.append('source',       fs.createReadStream(post.media_local_path));
    form.append('caption',      message);
    form.append('access_token', accessToken);
    form.append('published',    'true');

    const photoRes = await axios.post(
      `https://graph.facebook.com/v19.0/${connection.platform_user_id}/photos`,
      form,
      { headers: form.getHeaders() }
    );
    return { platformPostId: photoRes.data.post_id || photoRes.data.id };

  } else if (post.media_url && post.media_file_type === 'image' && !isGoogleDrive) {
    // Image from a public URL (e.g. AI-generated image in Supabase storage)
    // Facebook can fetch images directly from a URL via the /photos endpoint
    const photoRes = await axios.post(
      `https://graph.facebook.com/v19.0/${connection.platform_user_id}/photos`,
      null,
      { params: { url: post.media_url, caption: message, access_token: accessToken, published: true } }
    );
    return { platformPostId: photoRes.data.post_id || photoRes.data.id };

  } else if (post.media_url && post.media_file_type === 'video') {
    // Facebook can pull a video directly from a URL
    const videoRes = await axios.post(
      `https://graph.facebook.com/v19.0/${connection.platform_user_id}/videos`,
      null,
      { params: { file_url: post.media_url, description: message, access_token: accessToken } }
    );
    return { platformPostId: videoRes.data.id };

  } else {
    // Only attach as link preview if it's a real public URL (not Google Drive)
    if (post.media_url && !isGoogleDrive) params.link = post.media_url;
    const res = await axios.post(
      `https://graph.facebook.com/v19.0/${connection.platform_user_id}/feed`,
      null,
      { params }
    );
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

async function fetchInstagramComments(postId, accessToken, since) { return []; }
async function fetchFacebookComments(postId, accessToken, since)  { return []; }
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
