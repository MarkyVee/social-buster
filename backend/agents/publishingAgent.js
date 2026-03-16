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
 */

const { supabaseAdmin }  = require('../services/supabaseService');
const { publish }        = require('../services/platformAPIs');
const { decryptToken }   = require('../services/tokenEncryption');
const {
  downloadToTemp,
  probeVideo,
  trimVideo,
  cleanupTemp,
  PLATFORM_LIMITS
} = require('../services/ffmpegService');

const MAX_RETRIES = 3;
const BATCH_CAP   = 50;  // Max posts processed per BullMQ job cycle

// ----------------------------------------------------------------
// processQueue — finds all posts due for publishing and processes them.
// Called by workers/publishWorker.js on a 60-second repeating job.
// BullMQ handles concurrency control so we don't need an isRunning flag.
// ----------------------------------------------------------------
async function processQueue() {
  try {
    // Fetch all posts that are scheduled and overdue
    const { data: posts, error } = await supabaseAdmin
      .from('posts')
      .select('id, user_id, platform, hook, caption, hashtags, cta, media_id, ai_image_url, trim_start_seconds, scheduled_at')
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
      Object.entries(byUser).map(([userId, userPosts]) =>
        processUserQueue(userId, userPosts)
      )
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
async function processUserQueue(userId, posts) {
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
  console.log(`[PublishingAgent] Publishing post ${post.id} to ${post.platform}...`);

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
    await markFailed(post.id, `No ${post.platform} account connected for this user.`);
    return;
  }

  // If the post references a media item, resolve the UUID → cloud URL.
  // For videos, download to a temp file and trim if needed before publishing.
  // tempFilePaths is declared outside the try so the finally block can always clean up,
  // even if markFailed() or a DB update throws unexpectedly.
  let tempFilePaths = [];
  if (post.media_id) {
    const { data: mediaItem } = await supabaseAdmin
      .from('media_items')
      .select('cloud_url, file_type, filename, duration_seconds')
      .eq('id', post.media_id)
      .single();

    if (mediaItem?.cloud_url) {
      post.media_url       = mediaItem.cloud_url;
      post.media_file_type = mediaItem.file_type;

      // For videos, download locally and trim if the video exceeds the platform limit
      if (mediaItem.file_type === 'video' && PLATFORM_LIMITS[post.platform]) {
        try {
          const extension  = (mediaItem.filename?.split('.').pop() || 'mp4').toLowerCase();
          const startTime  = post.trim_start_seconds || 0;

          console.log(`[PublishingAgent] Downloading video for post ${post.id}...`);
          const downloadedPath = await downloadToTemp(mediaItem.cloud_url, extension);
          tempFilePaths.push(downloadedPath);

          // Check if trim is needed (video too long, or user set a custom start offset)
          const { duration } = await probeVideo(downloadedPath);
          const platformLimit = PLATFORM_LIMITS[post.platform];
          const needsTrim = (duration - startTime) > platformLimit || startTime > 0;

          if (needsTrim) {
            console.log(`[PublishingAgent] Trimming video (${duration}s → ${platformLimit}s from ${startTime}s)`);
            const trimmedPath = await trimVideo(downloadedPath, post.platform, startTime);
            // trimVideo may return the same path if no trim was needed
            if (trimmedPath !== downloadedPath) {
              tempFilePaths.push(trimmedPath);
            }
            // Pass the local file path so platform publishers can upload the trimmed file
            post.media_local_path = trimmedPath;
          } else {
            // No trim needed — just pass the local downloaded file
            post.media_local_path = downloadedPath;
          }

        } catch (trimErr) {
          // Non-fatal: log the trim failure and fall back to using the cloud URL directly.
          // Some platforms (Facebook, TikTok) can pull from a URL without a local file.
          console.warn(`[PublishingAgent] Video prep failed for post ${post.id}, falling back to cloud URL: ${trimErr.message}`);
        }
      }
    }
  }

  // If no media library item was attached but the post has an AI-generated image,
  // use that URL directly. Facebook fetches it from Supabase Storage — no download needed.
  if (!post.media_url && post.ai_image_url) {
    post.media_url       = post.ai_image_url;
    post.media_file_type = 'image';
  }

  // Attempt publish with retries and exponential backoff.
  // The finally block guarantees temp files are cleaned up no matter what happens —
  // even if markFailed() or a DB update throws an unexpected error.
  let lastError;
  try {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await publish(post, connection);

        // Success — update the post record with the platform's returned post ID
        await supabaseAdmin
          .from('posts')
          .update({
            status:           'published',
            platform_post_id: result.platformPostId,
            published_at:     new Date().toISOString(),
            error_message:    null
          })
          .eq('id', post.id);

        console.log(`[PublishingAgent] Post ${post.id} → published (${result.platformPostId})`);
        return;

      } catch (err) {
        lastError = err;
        console.warn(`[PublishingAgent] Attempt ${attempt}/${MAX_RETRIES} failed for post ${post.id}: ${err.message}`);

        if (attempt < MAX_RETRIES) {
          // Backoff: 5s after attempt 1, 15s after attempt 2
          await sleep(5000 * attempt);
        }
      }
    }

    // All retries exhausted — mark the post as failed
    await markFailed(post.id, lastError.message);

  } finally {
    // Always clean up temp files — runs whether we succeed, fail, or throw
    tempFilePaths.forEach(p => cleanupTemp(p));
  }
}

// ----------------------------------------------------------------
// markFailed — sets post status to 'failed' with the error message.
// ----------------------------------------------------------------
async function markFailed(postId, errorMessage) {
  console.error(`[PublishingAgent] Post ${postId} permanently failed: ${errorMessage}`);

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
