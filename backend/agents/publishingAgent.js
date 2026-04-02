/**
 * agents/publishingAgent.js
 *
 * Background queue processor. Called by workers/publishWorker.js every 60
 * seconds via BullMQ. Finds all scheduled posts that are due and publishes them.
 * Never runs inside a request/response cycle.
 *
 * Retry strategy:
 *   Attempt 1 → immediate
 *   Attempt 2 → 5 seconds later
 *   Attempt 3 → 15 seconds later
 *   After 3 failures → post marked 'failed' with error_message
 *
 * Multi-tenant safety:
 *   Posts from different users are processed concurrently.
 *   Posts from the SAME user are processed sequentially to respect
 *   per-user rate limits on platform APIs.
 *
 * Media handling:
 *   All media has been pre-copied to Supabase Storage by mediaProcessAgent
 *   BEFORE the post is published. This agent only needs to check that
 *   media_items.process_status = 'ready' and use media_items.processed_url.
 *   No Drive API calls, no OAuth, no temp downloads for images.
 *   Videos still need a local download + FFmpeg trim (platform-specific).
 */

const fs                 = require('fs');
const path               = require('path');
const { v4: uuidv4 }    = require('uuid');
const axios              = require('axios');
const { supabaseAdmin }  = require('../services/supabaseService');
const { logActivity }    = require('../services/activityService');
const { publish }        = require('../services/platformAPIs');
const { downloadGoogleDriveFile } = require('../services/googleDriveService');
const {
  downloadToTemp,
  probeVideo,
  trimVideo,
  cleanupTemp,
  PLATFORM_LIMITS
} = require('../services/ffmpegService');

// Supabase Storage bucket where mediaProcessAgent uploads copies.
// AI-generated images live in 'ai-generated-images' — we keep those.
const PROCESSED_MEDIA_BUCKET = 'processed-media';

const MAX_RETRIES = 3;
const BATCH_CAP   = 100;  // Max posts processed per BullMQ job cycle

// Concurrency limiter — prevents too many users publishing simultaneously
// (each user pipeline may run FFmpeg for video processing, which is CPU-heavy)
const MAX_CONCURRENT_USERS = 10;
function createLimiter(concurrency) {
  let active = 0;
  const queue = [];
  const next = () => { if (queue.length > 0 && active < concurrency) queue.shift()(); };
  return (fn) => new Promise((resolve, reject) => {
    const run = () => { active++; fn().then(resolve, reject).finally(() => { active--; next(); }); };
    active < concurrency ? run() : queue.push(run);
  });
}
const limitUser = createLimiter(MAX_CONCURRENT_USERS);

// ----------------------------------------------------------------
// processQueue — finds all posts due for publishing and processes them.
// Called by workers/publishWorker.js on a 60-second repeating job.
// BullMQ handles concurrency control so we don't need an isRunning flag.
// ----------------------------------------------------------------
async function processQueue() {
  try {
    // Recover posts stuck in 'publishing' for more than 15 minutes.
    // Worst-case legitimate publish time for video:
    //   Drive download (5 min) + H.264 re-encode at ultrafast (2-3 min) +
    //   3 attempts × 30s timeout + backoffs ≈ 12-13 minutes total.
    // 15 minutes gives headroom without leaving truly stuck posts waiting too long.
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: stale } = await supabaseAdmin
      .from('posts')
      .select('id, platform')
      .eq('status', 'publishing')
      .lte('updated_at', fifteenMinutesAgo);

    // Also log any in-progress posts (not yet timed out) for debugging
    const { data: inProgress } = await supabaseAdmin
      .from('posts')
      .select('id, updated_at, platform')
      .eq('status', 'publishing');
    if (inProgress?.length > 0) {
      inProgress.forEach(p => console.log(`[PublishingAgent] Post ${p.id} stuck in 'publishing' since ${p.updated_at} (${p.platform})`));
    }

    if (stale?.length > 0) {
      for (const stalePost of stale) {
        // Check if a publish_attempts record shows the API call actually succeeded.
        // This handles the case where the platform API succeeded but the DB update
        // crashed before we could mark the post as 'published'.
        const { data: sentAttempt } = await supabaseAdmin
          .from('publish_attempts')
          .select('id, platform_post_id')
          .eq('post_id', stalePost.id)
          .eq('status', 'sent')
          .limit(1)
          .single();

        if (sentAttempt) {
          // The API call succeeded — the post was published. Mark it as such.
          console.warn(`[PublishingAgent] Stale post ${stalePost.id} has a 'sent' attempt — marking published (platform_post_id=${sentAttempt.platform_post_id})`);
          await supabaseAdmin
            .from('posts')
            .update({
              status:           'published',
              platform_post_id: sentAttempt.platform_post_id,
              published_at:     new Date().toISOString(),
              error_message:    null
            })
            .eq('id', stalePost.id);
        } else {
          // No successful attempt on record — safe to reset for auto-retry.
          // Reset to 'scheduled' (not 'failed') so the next processQueue cycle
          // picks it up automatically without requiring manual user action.
          console.warn(`[PublishingAgent] Stale post ${stalePost.id} — no sent attempt found, resetting to scheduled for auto-retry`);
          await supabaseAdmin
            .from('posts')
            .update({
              status:        'scheduled',
              error_message: 'Publish timed out (15 min) — automatically retrying.'
            })
            .eq('id', stalePost.id);
        }
      }
      console.warn(`[PublishingAgent] Recovered ${stale.length} stale publishing post(s).`);
    }

    // Fetch all posts that are scheduled and overdue
    const { data: posts, error } = await supabaseAdmin
      .from('posts')
      .select('id, user_id, platform, hook, caption, hashtags, cta, media_id, trim_start_seconds, trim_end_seconds, scheduled_at')
      .eq('status', 'scheduled')
      .lte('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(BATCH_CAP);

    if (error) {
      console.error('[PublishingAgent] Failed to fetch queue:', error.message);
      return;
    }

    if (!posts || posts.length === 0) {
      // Debug: check if there ARE scheduled posts but with future dates
      const { data: allScheduled } = await supabaseAdmin
        .from('posts')
        .select('id, status, scheduled_at, platform')
        .eq('status', 'scheduled')
        .limit(5);
      if (allScheduled?.length > 0) {
        const now = new Date().toISOString();
        console.log(`[PublishingAgent] No overdue posts, but ${allScheduled.length} scheduled post(s) exist. Server time: ${now}`);
        allScheduled.forEach(p => console.log(`[PublishingAgent]   → ${p.id} scheduled_at=${p.scheduled_at} platform=${p.platform}`));
      }
      return;
    }

    console.log(`[PublishingAgent] Processing ${posts.length} post(s)...`);

    // Group by user — same-user posts run sequentially, different users concurrently
    const byUser = {};
    posts.forEach(post => {
      if (!byUser[post.user_id]) byUser[post.user_id] = [];
      byUser[post.user_id].push(post);
    });

    await Promise.allSettled(
      Object.values(byUser).map(userPosts => limitUser(() => processUserQueue(userPosts)))
    );

  } catch (err) {
    // Re-throw so BullMQ marks the job as failed and triggers its retry logic
    console.error('[PublishingAgent] Unexpected error:', err.message);
    throw err;
  }
}

// ----------------------------------------------------------------
// processUserQueue — processes one user's due posts sequentially.
// ----------------------------------------------------------------
async function processUserQueue(posts) {
  for (const post of posts) {
    try {
      await publishPost(post);
    } catch (err) {
      // One post failing must not block the rest of this user's queue
      console.error(`[PublishingAgent] Unhandled error for post ${post.id}:`, err.message);
    }
  }
}

// ----------------------------------------------------------------
// publishPost — attempts to publish a single post with retry logic.
// ----------------------------------------------------------------
async function publishPost(post) {
  console.log(`[PublishingAgent] ── START post ${post.id} → ${post.platform} ──`);
  console.log(`[PublishingAgent]    media_id=${post.media_id || 'none'} scheduled_at=${post.scheduled_at}`);

  // Immediately mark as 'publishing' to prevent double-processing
  // if another process picks up the same post before we finish
  await supabaseAdmin
    .from('posts')
    .update({ status: 'publishing' })
    .eq('id', post.id)
    .eq('status', 'scheduled'); // Only update if still scheduled (atomic guard)

  // Look up the platform connection for this user.
  // If the post has a platform_page_id (set when user picks a page), use that
  // to find the exact connection. Fallback: parse from platform_post_id
  // (Facebook format: {page_id}_{post_id}). Last resort: most recent connection.
  const effectivePageId = post.platform_page_id
    || (post.platform_post_id && post.platform_post_id.includes('_')
        ? post.platform_post_id.split('_')[0] : null);

  let connQuery = supabaseAdmin
    .from('platform_connections')
    .select('*')
    .eq('user_id', post.user_id)
    .eq('platform', post.platform);

  if (effectivePageId) {
    connQuery = connQuery.eq('platform_user_id', effectivePageId);
  } else {
    connQuery = connQuery.order('connected_at', { ascending: false }).limit(1);
  }

  let { data: connRows, error: connError } = await connQuery;
  let connection = connRows?.[0] || null;

  // Fallback for Instagram (and Threads): platform_page_id on the post is the Facebook
  // Page ID, but Instagram connections store the Instagram Business Account ID as
  // platform_user_id — a different number. If the filtered lookup returned nothing,
  // retry without the page ID filter to get the user's Instagram connection.
  if (!connection && !connError && effectivePageId &&
      (post.platform === 'instagram' || post.platform === 'threads')) {
    console.log(`[PublishingAgent]    platform_user_id filter returned nothing for ${post.platform} — retrying without page ID filter`);
    const { data: fallbackRows, error: fallbackError } = await supabaseAdmin
      .from('platform_connections')
      .select('*')
      .eq('user_id', post.user_id)
      .eq('platform', post.platform)
      .order('connected_at', { ascending: false })
      .limit(1);
    if (!fallbackError && fallbackRows?.[0]) {
      connection = fallbackRows[0];
      console.log(`[PublishingAgent]    Fallback connection found: platform_user_id=${connection.platform_user_id}`);
    }
  }

  if (connError || !connection) {
    console.error(`[PublishingAgent] No ${post.platform} connection for user ${post.user_id}`);
    await markFailed(post.id, `No ${post.platform} account connected for this user.`);
    return;
  }

  console.log(`[PublishingAgent]    platform_user_id=${connection.platform_user_id}`);

  // ── Media resolution ──────────────────────────────────────────
  // tempFilePaths declared outside try so the finally block always cleans up,
  // even if markFailed() or a DB update throws unexpectedly.
  // mediaItem hoisted here so post-publish cleanup can access it.
  let tempFilePaths = [];
  let mediaItem = null;

  if (post.media_id) {
    console.log(`[PublishingAgent]    Looking up media item ${post.media_id}...`);

    const { data: fetchedMedia, error: mediaErr } = await supabaseAdmin
      .from('media_items')
      .select('id, processed_url, cloud_url, file_type, filename, duration_seconds, process_status, process_error, cloud_provider')
      .eq('id', post.media_id)
      .single();

    mediaItem = fetchedMedia;

    // Log everything we know — this is the single most important diagnostic line
    console.log(`[PublishingAgent]    media lookup: found=${!!mediaItem} err=${mediaErr?.message || 'none'}`);
    if (mediaItem) {
      console.log(`[PublishingAgent]    media: provider=${mediaItem.cloud_provider} type=${mediaItem.file_type} status=${mediaItem.process_status} processedUrl=${mediaItem.processed_url || 'NULL'}`);
    }

    if (!mediaItem) {
      // Media row missing — fail loudly so the user knows to re-attach
      await markFailed(post.id, `Media item ${post.media_id} not found. Please re-attach the media and try again.`);
      return;
    }

    if (mediaItem.process_status !== 'ready') {
      // Media hasn't been copied to Supabase yet.
      // This can happen if the user published too quickly after attaching media
      // (the background processMedia job hasn't finished yet).
      const detail = mediaItem.process_error
        ? `Error: ${mediaItem.process_error}`
        : `Status is '${mediaItem.process_status}' — still processing. Try publishing again in a moment.`;
      await markFailed(post.id, `Media is not ready for publishing. ${detail}`);
      return;
    }

    if (!mediaItem.processed_url) {
      await markFailed(post.id, 'Media processed_url is missing even though status is ready. Please re-attach the media.');
      return;
    }

    // All good — use the pre-copied Supabase URL
    post.media_url       = mediaItem.processed_url;
    post.media_file_type = mediaItem.file_type;

    console.log(`[PublishingAgent]    media ready: ${post.media_file_type} @ ${post.media_url}`);

    // For images: download locally so we can upload via multipart form data.
    // URL-based upload (/photos?url=) is unreliable — Facebook may reject Supabase
    // URLs depending on size, headers, or CDN behaviour. Multipart is always reliable.
    // NOTE: Images are already optimized (resized to < 4 MB) at attach time by
    // mediaProcessAgent — no resize needed here. Just download for multipart upload.
    if (mediaItem.file_type === 'image') {
      try {
        const extension = (mediaItem.filename?.split('.').pop() || 'jpg').toLowerCase();
        console.log(`[PublishingAgent]    Downloading image from Supabase for multipart upload...`);
        const downloadedPath = await downloadToTemp(mediaItem.processed_url, extension);
        tempFilePaths.push(downloadedPath);

        // Crop image to platform's required aspect ratio if needed.
        // This prevents errors like Instagram 36003 (invalid aspect ratio).
        const { cropImageToAspectRange } = require('../services/ffmpegService');
        const croppedPath = await cropImageToAspectRange(downloadedPath, post.platform);
        if (croppedPath !== downloadedPath) {
          tempFilePaths.push(croppedPath);
          console.log(`[PublishingAgent]    Image cropped for ${post.platform} → ${croppedPath}`);

          // Instagram cannot fetch images from Supabase Storage URLs —
          // Meta's CDN is blocked at the network level from reaching Supabase.
          // Instead, serve the cropped image directly from our own server via
          // /temp-media/:filename (public, no auth, UUID filename = unguessable).
          // Instagram CAN reach social-buster.com since it hits our API constantly.
          // The temp file is added to tempFilePaths and deleted in the finally block
          // after Instagram has finished downloading it during container polling.
          if (post.platform === 'instagram' || post.platform === 'threads') {
            const croppedExt = (croppedPath.split('.').pop() || 'jpg').toLowerCase();
            const tempFileName = `${uuidv4()}.${croppedExt}`;
            const tempServeDir = '/tmp/social-buster/instagram-media';
            const tempServePath = path.join(tempServeDir, tempFileName);

            if (!fs.existsSync(tempServeDir)) fs.mkdirSync(tempServeDir, { recursive: true });
            fs.copyFileSync(croppedPath, tempServePath);
            tempFilePaths.push(tempServePath);

            const publicUrl = `${process.env.FRONTEND_URL}/temp-media/${tempFileName}`;
            post.media_url = publicUrl;
            console.log(`[PublishingAgent]    Cropped image served via our server → ${publicUrl}`);
          }
        }

        post.media_local_path = croppedPath;
        console.log(`[PublishingAgent]    Image ready → ${croppedPath}`);
      } catch (imgErr) {
        // Non-fatal: fall back to URL-based upload if download fails.
        console.warn(`[PublishingAgent]    Image download failed, falling back to URL: ${imgErr.message}`);
      }
    }

    // For videos: download locally and trim to the platform's duration limit.
    if (mediaItem.file_type === 'video' && PLATFORM_LIMITS[post.platform]) {
      try {
        const extension  = (mediaItem.filename?.split('.').pop() || 'mp4').toLowerCase();
        const startTime  = post.trim_start_seconds || 0;
        const endTime    = post.trim_end_seconds   || null; // null = trim to platform limit

        // Google Drive videos are never copied to Supabase (file size can exceed
        // Supabase's 50 MB free tier limit). Download via the Drive API instead.
        let downloadedPath;
        if (mediaItem.cloud_provider === 'google_drive') {
          console.log(`[PublishingAgent]    Downloading video from Google Drive via API...`);
          downloadedPath = await downloadGoogleDriveFile(post.user_id, mediaItem.cloud_url, extension);
        } else {
          console.log(`[PublishingAgent]    Downloading video from Supabase for trim check...`);
          downloadedPath = await downloadToTemp(mediaItem.processed_url, extension);
        }
        tempFilePaths.push(downloadedPath);

        const { duration } = await probeVideo(downloadedPath);
        const platformLimit = PLATFORM_LIMITS[post.platform];

        console.log(`[PublishingAgent]    Video: duration=${duration}s limit=${platformLimit}s startTime=${startTime}s`);

        // Always re-encode to H.264/AAC (forceReencode=true).
        // Source videos from phones are often H.265/HEVC — Facebook and other
        // platforms reject those even in an MP4 container (error 351).
        // trimVideo handles both trimming AND codec conversion in one pass.
        const reEncodedPath = await trimVideo(downloadedPath, post.platform, startTime, true, endTime);
        if (reEncodedPath !== downloadedPath) tempFilePaths.push(reEncodedPath);
        post.media_local_path = reEncodedPath;
        console.log(`[PublishingAgent]    Video ready → ${reEncodedPath}`);

        // Instagram only accepts public URLs (no multipart upload for video).
        // Re-upload the trimmed/re-encoded video to Supabase so the API can fetch it.
        if (post.platform === 'instagram' || post.platform === 'threads') {
          const videoSize = fs.statSync(reEncodedPath).size;
          const storagePath = `${post.user_id}/${uuidv4()}.mp4`;
          const storageUrl = `${process.env.SUPABASE_URL}/storage/v1/object/processed-media/${storagePath}`;

          console.log(`[PublishingAgent]    Re-uploading trimmed video (${Math.round(videoSize / 1024)}KB) to Supabase for Instagram...`);
          const uploadRes = await axios.post(storageUrl, fs.createReadStream(reEncodedPath), {
            headers: {
              'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
              'Content-Type': 'video/mp4',
              'Content-Length': videoSize,
              'x-upsert': 'false'
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 120_000,   // Videos can be large — 2 min timeout
            validateStatus: () => true
          });

          if (uploadRes.status === 200) {
            const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/processed-media/${storagePath}`;
            post.media_url = publicUrl;
            console.log(`[PublishingAgent]    Trimmed video uploaded → ${publicUrl}`);
          } else {
            console.warn(`[PublishingAgent]    Trimmed video upload failed (${uploadRes.status}), using original URL`);
          }
        }

      } catch (videoErr) {
        // Non-fatal: fall back to the cloud URL and let the platform API try to
        // fetch it directly. Facebook/TikTok support file_url= for videos.
        console.warn(`[PublishingAgent]    Video prep failed, falling back to cloud URL: ${videoErr.message}`);
      }
    }

  } else {
    console.log(`[PublishingAgent]    No media attached — text-only post`);
  }

  // ── Publish with retries ──────────────────────────────────────
  let lastError;
  let attemptRecordId = null;  // Tracks the current publish_attempts row
  try {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[PublishingAgent]    Attempt ${attempt}/${MAX_RETRIES}: calling publish()...`);

        // Write-ahead intent: record the attempt BEFORE calling the platform API.
        // If the server crashes between API call and DB update, the stale recovery
        // can check this table to see if the post was actually published.
        const { data: attemptRow } = await supabaseAdmin
          .from('publish_attempts')
          .insert({
            post_id:        post.id,
            user_id:        post.user_id,
            platform:       post.platform,
            status:         'attempting',
            attempt_number: attempt
          })
          .select('id')
          .single();
        attemptRecordId = attemptRow?.id || null;

        const result = await publish(post, connection);

        // Platform API succeeded — record it immediately before any other DB work.
        // This is the single source of truth for "did this post go out?".
        if (attemptRecordId) {
          await supabaseAdmin
            .from('publish_attempts')
            .update({
              status:            'sent',
              completed_at:      new Date().toISOString(),
              platform_post_id:  result.platformPostId
            })
            .eq('id', attemptRecordId);
        }

        // Success — store the page ID so DM/comment agents use the correct token
        await supabaseAdmin
          .from('posts')
          .update({
            status:           'published',
            platform_post_id: result.platformPostId,
            platform_page_id: connection.platform_user_id,
            published_at:     new Date().toISOString(),
            error_message:    null
          })
          .eq('id', post.id);

        logActivity(post.user_id, 'post_published', { post_id: post.id, platform: post.platform });

        console.log(`[PublishingAgent] ── DONE post ${post.id} → published (${result.platformPostId}) ──`);

        // ── Post-publish storage cleanup ──────────────────────────────
        // Delete the copy from Supabase Storage to keep storage costs near zero.
        // The platform now has the file, and the original is still in the user's
        // cloud storage (Drive/Dropbox/Box). Analysis data (video_segments, tags)
        // lives in the database and is NOT affected by this delete.
        //
        // Skip cleanup for:
        //   - AI-generated images (user may reuse, different bucket)
        //   - Drive videos (never copied to Supabase in the first place)
        //   - Posts with no media
        if (post.media_id && mediaItem) {
          await cleanupProcessedMedia(post.media_id, mediaItem);
        }

        return;

      } catch (err) {
        lastError = err;
        console.warn(`[PublishingAgent]    Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);

        // Mark this attempt as failed in the log
        if (attemptRecordId) {
          await supabaseAdmin
            .from('publish_attempts')
            .update({
              status:        'failed',
              completed_at:  new Date().toISOString(),
              error_message: String(err.message).slice(0, 500)
            })
            .eq('id', attemptRecordId);
          attemptRecordId = null;  // Reset so next iteration creates a new row
        }

        if (attempt < MAX_RETRIES) {
          // Backoff: 5s after attempt 1, 15s after attempt 2
          await sleep(5000 * attempt);
        }
      }
    }

    // All retries exhausted — mark failed inside its own try/catch.
    // If this update throws (transient Supabase error), the post stays
    // in 'publishing' and the stale recovery will reset it to 'scheduled'
    // for another automatic retry on the next cycle.
    try {
      await markFailed(post.id, lastError.message);
    } catch (markErr) {
      console.error(`[PublishingAgent] markFailed threw for post ${post.id}: ${markErr.message} — stale recovery will catch it`);
    }

  } finally {
    // Always clean up temp files — runs whether we succeed, fail, or throw
    tempFilePaths.forEach(p => cleanupTemp(p));
  }
}

// ----------------------------------------------------------------
// cleanupProcessedMedia — deletes the Supabase Storage copy after
// a post is successfully published. Keeps storage costs near zero.
//
// What gets cleaned up:
//   - Google Drive images that were copied to processed-media bucket
//
// What is NOT cleaned up:
//   - AI-generated images (cloud_provider = 'ai_generated') — user may reuse
//   - Google Drive videos (never copied to Supabase — too large)
//   - Media from other providers using direct URLs
//
// After cleanup, the media_items row stays in the DB with all metadata.
// process_status is reset to 'pending' so if the user attaches the same
// media to a new post, mediaProcessAgent will re-copy it from Drive.
// Video analysis data (video_segments, tags) is NOT affected.
// ----------------------------------------------------------------
async function cleanupProcessedMedia(mediaId, mediaItem) {
  try {
    // Only clean up files we actually uploaded to the processed-media bucket.
    // AI-generated images live in a different bucket and should be kept.
    // Drive videos were never copied (too large for Supabase free tier).
    if (mediaItem.cloud_provider === 'ai_generated') {
      console.log(`[PublishingAgent] Skipping cleanup — AI-generated image (user may reuse)`);
      return;
    }

    if (!mediaItem.processed_url || !mediaItem.processed_url.includes(PROCESSED_MEDIA_BUCKET)) {
      console.log(`[PublishingAgent] Skipping cleanup — processed_url not in ${PROCESSED_MEDIA_BUCKET} bucket`);
      return;
    }

    // Extract the storage path from the full URL.
    // URL format: {SUPABASE_URL}/storage/v1/object/public/processed-media/{userId}/{uuid}.{ext}
    const bucketPrefix = `/storage/v1/object/public/${PROCESSED_MEDIA_BUCKET}/`;
    const pathIndex = mediaItem.processed_url.indexOf(bucketPrefix);
    if (pathIndex === -1) {
      console.warn(`[PublishingAgent] Could not extract storage path from URL: ${mediaItem.processed_url}`);
      return;
    }
    const storagePath = mediaItem.processed_url.slice(pathIndex + bucketPrefix.length);

    console.log(`[PublishingAgent] Cleaning up storage: ${PROCESSED_MEDIA_BUCKET}/${storagePath}`);

    // Delete the file from Supabase Storage via REST API
    const deleteUrl = `${process.env.SUPABASE_URL}/storage/v1/object/${PROCESSED_MEDIA_BUCKET}/${storagePath}`;
    const deleteResp = await axios.delete(deleteUrl, {
      headers: {
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
      },
      timeout: 15000,
      validateStatus: () => true  // Don't throw — cleanup is best-effort
    });

    if (deleteResp.status >= 200 && deleteResp.status < 300) {
      console.log(`[PublishingAgent] Storage file deleted successfully`);
    } else if (deleteResp.status === 404) {
      console.log(`[PublishingAgent] Storage file already gone (404) — nothing to delete`);
    } else {
      console.warn(`[PublishingAgent] Storage delete returned HTTP ${deleteResp.status}: ${JSON.stringify(deleteResp.data)}`);
    }

    // Reset the media item so it can be re-processed if attached to a future post.
    // The media_items row stays in the DB with all metadata (filename, cloud_url,
    // analysis_status, etc.). Only the Supabase copy reference is cleared.
    await supabaseAdmin
      .from('media_items')
      .update({
        processed_url:  null,
        process_status: 'pending',
        processed_at:   null
      })
      .eq('id', mediaId);

    console.log(`[PublishingAgent] Media item ${mediaId} reset to pending (ready for re-processing if reused)`);

  } catch (err) {
    // Cleanup is best-effort — never let it break the publish success flow.
    // The post is already published. If cleanup fails, storage just isn't reclaimed
    // for this file. It will eventually be caught by a periodic cleanup job if we add one.
    console.warn(`[PublishingAgent] Storage cleanup failed (non-fatal): ${err.message}`);
  }
}

// ----------------------------------------------------------------
// markFailed — sets post status to 'failed' with the error message.
// ----------------------------------------------------------------
async function markFailed(postId, errorMessage) {
  console.error(`[PublishingAgent] FAILED post ${postId}: ${errorMessage}`);

  await supabaseAdmin
    .from('posts')
    .update({
      status:        'failed',
      error_message: String(errorMessage).slice(0, 500)
    })
    .eq('id', postId);
}

// ----------------------------------------------------------------
// sleep — simple promise-based delay
// ----------------------------------------------------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { processQueue, publishPost };
