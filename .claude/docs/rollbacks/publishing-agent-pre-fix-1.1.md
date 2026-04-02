# Rollback Snapshot — publishingAgent.js + publishWorker.js
**Captured:** 2026-04-02
**Reason:** Pre-fix snapshot before implementing Red Team fix 1.1 (publish_attempts write-ahead intent pattern)
**Branch at capture:** main @ commit 510c09c

If fix 1.1 causes problems, paste the code blocks below back into the respective files.
You will also need to drop the `publish_attempts` table from Supabase if the SQL migration ran:
```sql
DROP TABLE IF EXISTS publish_attempts;
```

---

## backend/agents/publishingAgent.js

```javascript
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
    const twoMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: stale } = await supabaseAdmin
      .from('posts')
      .select('id')
      .eq('status', 'publishing')
      .lte('updated_at', twoMinutesAgo);

    const { data: inProgress } = await supabaseAdmin
      .from('posts')
      .select('id, updated_at, platform')
      .eq('status', 'publishing');
    if (inProgress?.length > 0) {
      inProgress.forEach(p => console.log(`[PublishingAgent] Post ${p.id} stuck in 'publishing' since ${p.updated_at} (${p.platform})`));
    }

    if (stale?.length > 0) {
      const staleIds = stale.map(p => p.id);
      await supabaseAdmin
        .from('posts')
        .update({ status: 'failed', error_message: 'Publish timed out (15 min) — video may be too large or format unsupported. Please retry.' })
        .in('id', staleIds);
      console.warn(`[PublishingAgent] Reset ${staleIds.length} stale publishing post(s) to failed.`);
    }

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

    const byUser = {};
    posts.forEach(post => {
      if (!byUser[post.user_id]) byUser[post.user_id] = [];
      byUser[post.user_id].push(post);
    });

    await Promise.allSettled(
      Object.values(byUser).map(userPosts => limitUser(() => processUserQueue(userPosts)))
    );

  } catch (err) {
    console.error('[PublishingAgent] Unexpected error:', err.message);
    throw err;
  }
}

async function processUserQueue(posts) {
  for (const post of posts) {
    try {
      await publishPost(post);
    } catch (err) {
      console.error(`[PublishingAgent] Unhandled error for post ${post.id}:`, err.message);
    }
  }
}

async function publishPost(post) {
  console.log(`[PublishingAgent] ── START post ${post.id} → ${post.platform} ──`);
  console.log(`[PublishingAgent]    media_id=${post.media_id || 'none'} scheduled_at=${post.scheduled_at}`);

  await supabaseAdmin
    .from('posts')
    .update({ status: 'publishing' })
    .eq('id', post.id)
    .eq('status', 'scheduled');

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

  if (!connection && !connError && effectivePageId &&
      (post.platform === 'instagram' || post.platform === 'threads')) {
    const { data: fallbackRows, error: fallbackError } = await supabaseAdmin
      .from('platform_connections')
      .select('*')
      .eq('user_id', post.user_id)
      .eq('platform', post.platform)
      .order('connected_at', { ascending: false })
      .limit(1);
    if (!fallbackError && fallbackRows?.[0]) {
      connection = fallbackRows[0];
    }
  }

  if (connError || !connection) {
    await markFailed(post.id, `No ${post.platform} account connected for this user.`);
    return;
  }

  let tempFilePaths = [];
  let mediaItem = null;

  if (post.media_id) {
    const { data: fetchedMedia, error: mediaErr } = await supabaseAdmin
      .from('media_items')
      .select('id, processed_url, cloud_url, file_type, filename, duration_seconds, process_status, process_error, cloud_provider')
      .eq('id', post.media_id)
      .single();

    mediaItem = fetchedMedia;

    if (!mediaItem) {
      await markFailed(post.id, `Media item ${post.media_id} not found. Please re-attach the media and try again.`);
      return;
    }

    if (mediaItem.process_status !== 'ready') {
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

    post.media_url       = mediaItem.processed_url;
    post.media_file_type = mediaItem.file_type;

    if (mediaItem.file_type === 'image') {
      try {
        const extension = (mediaItem.filename?.split('.').pop() || 'jpg').toLowerCase();
        const downloadedPath = await downloadToTemp(mediaItem.processed_url, extension);
        tempFilePaths.push(downloadedPath);

        const { cropImageToAspectRange } = require('../services/ffmpegService');
        const croppedPath = await cropImageToAspectRange(downloadedPath, post.platform);
        if (croppedPath !== downloadedPath) {
          tempFilePaths.push(croppedPath);

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
          }
        }

        post.media_local_path = croppedPath;
      } catch (imgErr) {
        console.warn(`[PublishingAgent]    Image download failed, falling back to URL: ${imgErr.message}`);
      }
    }

    if (mediaItem.file_type === 'video' && PLATFORM_LIMITS[post.platform]) {
      try {
        const extension  = (mediaItem.filename?.split('.').pop() || 'mp4').toLowerCase();
        const startTime  = post.trim_start_seconds || 0;
        const endTime    = post.trim_end_seconds   || null;

        let downloadedPath;
        if (mediaItem.cloud_provider === 'google_drive') {
          downloadedPath = await downloadGoogleDriveFile(post.user_id, mediaItem.cloud_url, extension);
        } else {
          downloadedPath = await downloadToTemp(mediaItem.processed_url, extension);
        }
        tempFilePaths.push(downloadedPath);

        const { duration } = await probeVideo(downloadedPath);
        const platformLimit = PLATFORM_LIMITS[post.platform];

        const reEncodedPath = await trimVideo(downloadedPath, post.platform, startTime, true, endTime);
        if (reEncodedPath !== downloadedPath) tempFilePaths.push(reEncodedPath);
        post.media_local_path = reEncodedPath;

        if (post.platform === 'instagram' || post.platform === 'threads') {
          const videoSize = fs.statSync(reEncodedPath).size;
          const storagePath = `${post.user_id}/${uuidv4()}.mp4`;
          const storageUrl = `${process.env.SUPABASE_URL}/storage/v1/object/processed-media/${storagePath}`;

          const uploadRes = await axios.post(storageUrl, fs.createReadStream(reEncodedPath), {
            headers: {
              'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
              'Content-Type': 'video/mp4',
              'Content-Length': videoSize,
              'x-upsert': 'false'
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 120_000,
            validateStatus: () => true
          });

          if (uploadRes.status === 200) {
            const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/processed-media/${storagePath}`;
            post.media_url = publicUrl;
          }
        }

      } catch (videoErr) {
        console.warn(`[PublishingAgent]    Video prep failed, falling back to cloud URL: ${videoErr.message}`);
      }
    }

  } else {
    console.log(`[PublishingAgent]    No media attached — text-only post`);
  }

  let lastError;
  try {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await publish(post, connection);

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

        if (post.media_id && mediaItem) {
          await cleanupProcessedMedia(post.media_id, mediaItem);
        }

        return;

      } catch (err) {
        lastError = err;
        console.warn(`[PublishingAgent]    Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
        if (attempt < MAX_RETRIES) {
          await sleep(5000 * attempt);
        }
      }
    }

    try {
      await markFailed(post.id, lastError.message);
    } catch (markErr) {
      console.error(`[PublishingAgent] markFailed threw for post ${post.id}: ${markErr.message}`);
    }

  } finally {
    tempFilePaths.forEach(p => cleanupTemp(p));
  }
}

async function cleanupProcessedMedia(mediaId, mediaItem) {
  try {
    if (mediaItem.cloud_provider === 'ai_generated') return;
    if (!mediaItem.processed_url || !mediaItem.processed_url.includes(PROCESSED_MEDIA_BUCKET)) return;

    const bucketPrefix = `/storage/v1/object/public/${PROCESSED_MEDIA_BUCKET}/`;
    const pathIndex = mediaItem.processed_url.indexOf(bucketPrefix);
    if (pathIndex === -1) return;
    const storagePath = mediaItem.processed_url.slice(pathIndex + bucketPrefix.length);

    const deleteUrl = `${process.env.SUPABASE_URL}/storage/v1/object/${PROCESSED_MEDIA_BUCKET}/${storagePath}`;
    const deleteResp = await axios.delete(deleteUrl, {
      headers: { 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
      timeout: 15000,
      validateStatus: () => true
    });

    await supabaseAdmin
      .from('media_items')
      .update({ processed_url: null, process_status: 'pending', processed_at: null })
      .eq('id', mediaId);

  } catch (err) {
    console.warn(`[PublishingAgent] Storage cleanup failed (non-fatal): ${err.message}`);
  }
}

async function markFailed(postId, errorMessage) {
  console.error(`[PublishingAgent] FAILED post ${postId}: ${errorMessage}`);
  await supabaseAdmin
    .from('posts')
    .update({ status: 'failed', error_message: String(errorMessage).slice(0, 500) })
    .eq('id', postId);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { processQueue, publishPost };
```

---

## backend/workers/publishWorker.js

```javascript
/**
 * workers/publishWorker.js
 */

const { Worker } = require('bullmq');
const { connection } = require('../queues');
const { processQueue } = require('../agents/publishingAgent');

process.on('unhandledRejection', (err) => {
  console.error('[PublishWorker] UNHANDLED REJECTION:', err);
});

const publishWorker = new Worker(
  'publish',
  async (job) => {
    if (job.name === 'scan-and-publish') {
      await processQueue();
    }
  },
  {
    connection,
    concurrency: 1
  }
);

publishWorker.on('completed', (job) => {
  console.log(`[PublishWorker] Job ${job.id} (${job.name}) completed`);
});

publishWorker.on('failed', (job, err) => {
  console.error(`[PublishWorker] Job ${job?.id} (${job?.name}) failed: ${err.message}`);
});

publishWorker.on('error', (err) => {
  console.error('[PublishWorker] Worker error:', err.message);
});

module.exports = publishWorker;
```

---

## SQL to run if you need to fully undo

```sql
-- Drop the new table added by fix 1.1
DROP TABLE IF EXISTS publish_attempts;
```
