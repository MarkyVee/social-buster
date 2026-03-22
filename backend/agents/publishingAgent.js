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

const axios              = require('axios');
const { supabaseAdmin }  = require('../services/supabaseService');
const { publish }        = require('../services/platformAPIs');
const { downloadGoogleDriveFile } = require('../services/googleDriveService');
const {
  downloadToTemp,
  probeVideo,
  trimVideo,
  resizeImageIfNeeded,
  cleanupTemp,
  PLATFORM_LIMITS
} = require('../services/ffmpegService');

// Supabase Storage bucket where mediaProcessAgent uploads copies.
// AI-generated images live in 'ai-generated-images' — we keep those.
const PROCESSED_MEDIA_BUCKET = 'processed-media';

const MAX_RETRIES = 3;
const BATCH_CAP   = 50;  // Max posts processed per BullMQ job cycle

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
    const twoMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: stale } = await supabaseAdmin
      .from('posts')
      .select('id')
      .eq('status', 'publishing')
      .lte('updated_at', twoMinutesAgo);

    if (stale?.length > 0) {
      const staleIds = stale.map(p => p.id);
      await supabaseAdmin
        .from('posts')
        .update({ status: 'failed', error_message: 'Publish timed out (2 min) — please retry.' })
        .in('id', staleIds);
      console.warn(`[PublishingAgent] Reset ${staleIds.length} stale publishing post(s) to failed.`);
    }

    // Fetch all posts that are scheduled and overdue
    const { data: posts, error } = await supabaseAdmin
      .from('posts')
      .select('id, user_id, platform, hook, caption, hashtags, cta, media_id, trim_start_seconds, scheduled_at')
      .eq('status', 'scheduled')
      .lte('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(BATCH_CAP);

    if (error) {
      console.error('[PublishingAgent] Failed to fetch queue:', error.message);
      return;
    }

    if (!posts || posts.length === 0) return;

    console.log(`[PublishingAgent] Processing ${posts.length} post(s)...`);

    // Group by user — same-user posts run sequentially, different users concurrently
    const byUser = {};
    posts.forEach(post => {
      if (!byUser[post.user_id]) byUser[post.user_id] = [];
      byUser[post.user_id].push(post);
    });

    await Promise.allSettled(
      Object.values(byUser).map(userPosts => processUserQueue(userPosts))
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

  // Look up the platform connection for this user
  const { data: connection, error: connError } = await supabaseAdmin
    .from('platform_connections')
    .select('*')
    .eq('user_id', post.user_id)
    .eq('platform', post.platform)
    .single();

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
    if (mediaItem.file_type === 'image') {
      try {
        const extension = (mediaItem.filename?.split('.').pop() || 'jpg').toLowerCase();
        console.log(`[PublishingAgent]    Downloading image from Supabase for multipart upload...`);
        const downloadedPath = await downloadToTemp(mediaItem.processed_url, extension);
        tempFilePaths.push(downloadedPath);

        // Resize if the image exceeds the platform's size limit
        const resizedPath = await resizeImageIfNeeded(downloadedPath, post.platform);
        if (resizedPath !== downloadedPath) tempFilePaths.push(resizedPath);

        post.media_local_path = resizedPath;
        console.log(`[PublishingAgent]    Image ready → ${resizedPath}`);
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
        const reEncodedPath = await trimVideo(downloadedPath, post.platform, startTime, true);
        if (reEncodedPath !== downloadedPath) tempFilePaths.push(reEncodedPath);
        post.media_local_path = reEncodedPath;
        console.log(`[PublishingAgent]    Video ready → ${reEncodedPath}`);

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
  try {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`[PublishingAgent]    Attempt ${attempt}/${MAX_RETRIES}: calling publish()...`);
        const result = await publish(post, connection);

        // Success
        await supabaseAdmin
          .from('posts')
          .update({
            status:           'published',
            platform_post_id: result.platformPostId,
            published_at:     new Date().toISOString(),
            error_message:    null
          })
          .eq('id', post.id);

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

        if (attempt < MAX_RETRIES) {
          // Backoff: 5s after attempt 1, 15s after attempt 2
          await sleep(5000 * attempt);
        }
      }
    }

    // All retries exhausted — mark failed inside its own try/catch.
    // If this update throws (transient Supabase error), the post would
    // stay in 'publishing' forever. The catch logs it and the 2-minute
    // stale recovery acts as the fallback safety net.
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
