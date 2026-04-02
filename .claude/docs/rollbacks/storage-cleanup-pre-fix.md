# Rollback Snapshot — Storage Cleanup Refactor
**Captured:** 2026-04-02
**Reason:** Pre-fix snapshot before implementing storage reference-counted cleanup
**Branch at capture:** main @ commit 8aa9c46
**Files changed by this fix:**
  - backend/agents/publishingAgent.js
  - backend/workers/activityCleanupWorker.js

## What this fix does (full change list)

1. **publishingAgent.js** — Remove `cleanupProcessedMedia()` function and its call from the
   success path. Media files are NO LONGER deleted immediately after publish.

2. **publishingAgent.js** — Track `instagramVideoStoragePath` as a local variable for the
   re-encoded video copy uploaded to Supabase for Instagram/Threads. Delete it immediately
   after `publish()` succeeds (before DB updates). Non-fatal if delete fails.

3. **activityCleanupWorker.js** — Add `cleanupOrphanedStorage()` function that runs nightly
   alongside the existing activity log cleanup. Two sweeps:
   - **Reference-counted sweep**: find `media_items` where `process_status = 'ready'` AND
     every `posts` row using that `media_id` has `status NOT IN (draft, approved, scheduled,
     publishing)`. Reset `process_status = 'pending'` first, then delete the Supabase file.
   - **Orphan sweep**: find `media_items` where `process_status = 'ready'` AND
     `processed_url` contains 'processed-media' AND `processed_at` is older than 24 hours
     AND no `posts` row references the `media_id` at all. Same delete pattern.

## Why the cleanup moved from publish-time to nightly

The old approach deleted the Supabase file immediately after the FIRST post published.
On a 7-platform campaign, all 7 posts share the same `media_id`. Post 1 publishes,
deletes the file, resets `process_status = 'pending'`. Posts 2–7 fail with
"Media is not ready for publishing." This fix keeps the file alive until ALL posts
using it have finished.

## To roll back

Restore the two code blocks below to their respective files.
No SQL migrations were run — no DB rollback needed.

---

## backend/agents/publishingAgent.js — FULL FILE AT ROLLBACK POINT

Restore from git:
```
git checkout 8aa9c46 -- backend/agents/publishingAgent.js
```

Or paste the complete file content below:

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

const PROCESSED_MEDIA_BUCKET = 'processed-media';
const MAX_RETRIES = 3;
const BATCH_CAP   = 100;
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

async function processQueue() {
  try {
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: stale } = await supabaseAdmin
      .from('posts')
      .select('id, platform')
      .eq('status', 'publishing')
      .lte('updated_at', fifteenMinutesAgo);

    const { data: inProgress } = await supabaseAdmin
      .from('posts')
      .select('id, updated_at, platform')
      .eq('status', 'publishing');
    if (inProgress?.length > 0) {
      inProgress.forEach(p => console.log(`[PublishingAgent] Post ${p.id} stuck in 'publishing' since ${p.updated_at} (${p.platform})`));
    }

    if (stale?.length > 0) {
      for (const stalePost of stale) {
        const { data: sentAttempt } = await supabaseAdmin
          .from('publish_attempts')
          .select('id, platform_post_id')
          .eq('post_id', stalePost.id)
          .eq('status', 'sent')
          .limit(1)
          .single();

        if (sentAttempt) {
          console.warn(`[PublishingAgent] Stale post ${stalePost.id} has a 'sent' attempt — marking published`);
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
          console.warn(`[PublishingAgent] Stale post ${stalePost.id} — resetting to scheduled for auto-retry`);
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

    const { data: posts, error } = await supabaseAdmin
      .from('posts')
      .select('id, user_id, platform, hook, caption, hashtags, cta, media_id, trim_start_seconds, trim_end_seconds, scheduled_at')
      .eq('status', 'scheduled')
      .lte('scheduled_at', new Date().toISOString())
      .order('scheduled_at', { ascending: true })
      .limit(BATCH_CAP);

    if (error) { console.error('[PublishingAgent] Failed to fetch queue:', error.message); return; }
    if (!posts || posts.length === 0) {
      const { data: allScheduled } = await supabaseAdmin
        .from('posts').select('id, status, scheduled_at, platform').eq('status', 'scheduled').limit(5);
      if (allScheduled?.length > 0) {
        const now = new Date().toISOString();
        console.log(`[PublishingAgent] No overdue posts, but ${allScheduled.length} scheduled post(s) exist. Server time: ${now}`);
        allScheduled.forEach(p => console.log(`[PublishingAgent]   → ${p.id} scheduled_at=${p.scheduled_at} platform=${p.platform}`));
      }
      return;
    }

    console.log(`[PublishingAgent] Processing ${posts.length} post(s)...`);
    const byUser = {};
    posts.forEach(post => { if (!byUser[post.user_id]) byUser[post.user_id] = []; byUser[post.user_id].push(post); });
    await Promise.allSettled(Object.values(byUser).map(userPosts => limitUser(() => processUserQueue(userPosts))));

  } catch (err) {
    console.error('[PublishingAgent] Unexpected error:', err.message);
    throw err;
  }
}

async function processUserQueue(posts) {
  for (const post of posts) {
    try { await publishPost(post); }
    catch (err) { console.error(`[PublishingAgent] Unhandled error for post ${post.id}:`, err.message); }
  }
}

async function publishPost(post) {
  console.log(`[PublishingAgent] ── START post ${post.id} → ${post.platform} ──`);

  await supabaseAdmin.from('posts').update({ status: 'publishing' })
    .eq('id', post.id).eq('status', 'scheduled');

  const effectivePageId = post.platform_page_id
    || (post.platform_post_id && post.platform_post_id.includes('_') ? post.platform_post_id.split('_')[0] : null);

  let connQuery = supabaseAdmin.from('platform_connections').select('*').eq('user_id', post.user_id).eq('platform', post.platform);
  if (effectivePageId) { connQuery = connQuery.eq('platform_user_id', effectivePageId); }
  else { connQuery = connQuery.order('connected_at', { ascending: false }).limit(1); }

  let { data: connRows, error: connError } = await connQuery;
  let connection = connRows?.[0] || null;

  if (!connection && !connError && effectivePageId && (post.platform === 'instagram' || post.platform === 'threads')) {
    const { data: fallbackRows, error: fallbackError } = await supabaseAdmin
      .from('platform_connections').select('*').eq('user_id', post.user_id).eq('platform', post.platform)
      .order('connected_at', { ascending: false }).limit(1);
    if (!fallbackError && fallbackRows?.[0]) connection = fallbackRows[0];
  }

  if (connError || !connection) {
    await markFailed(post.id, `No ${post.platform} account connected for this user.`);
    return;
  }

  let tempFilePaths = [];
  let mediaItem = null;

  if (post.media_id) {
    const { data: fetchedMedia } = await supabaseAdmin
      .from('media_items')
      .select('id, processed_url, cloud_url, file_type, filename, duration_seconds, process_status, process_error, cloud_provider')
      .eq('id', post.media_id).single();
    mediaItem = fetchedMedia;

    if (!mediaItem) { await markFailed(post.id, `Media item ${post.media_id} not found.`); return; }
    if (mediaItem.process_status !== 'ready') {
      const detail = mediaItem.process_error ? `Error: ${mediaItem.process_error}` : `Status is '${mediaItem.process_status}'`;
      await markFailed(post.id, `Media is not ready for publishing. ${detail}`); return;
    }
    if (!mediaItem.processed_url) { await markFailed(post.id, 'Media processed_url is missing.'); return; }

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
            post.media_url = `${process.env.FRONTEND_URL}/temp-media/${tempFileName}`;
          }
        }
        post.media_local_path = croppedPath;
      } catch (imgErr) {
        console.warn(`[PublishingAgent]    Image download failed: ${imgErr.message}`);
      }
    }

    if (mediaItem.file_type === 'video' && PLATFORM_LIMITS[post.platform]) {
      try {
        const extension = (mediaItem.filename?.split('.').pop() || 'mp4').toLowerCase();
        const startTime = post.trim_start_seconds || 0;
        const endTime   = post.trim_end_seconds   || null;
        let downloadedPath;
        if (mediaItem.cloud_provider === 'google_drive') {
          downloadedPath = await downloadGoogleDriveFile(post.user_id, mediaItem.cloud_url, extension);
        } else {
          downloadedPath = await downloadToTemp(mediaItem.processed_url, extension);
        }
        tempFilePaths.push(downloadedPath);
        const reEncodedPath = await trimVideo(downloadedPath, post.platform, startTime, true, endTime);
        if (reEncodedPath !== downloadedPath) tempFilePaths.push(reEncodedPath);
        post.media_local_path = reEncodedPath;

        if (post.platform === 'instagram' || post.platform === 'threads') {
          const videoSize   = fs.statSync(reEncodedPath).size;
          const storagePath = `${post.user_id}/${uuidv4()}.mp4`;
          const storageUrl  = `${process.env.SUPABASE_URL}/storage/v1/object/processed-media/${storagePath}`;
          const uploadRes   = await axios.post(storageUrl, fs.createReadStream(reEncodedPath), {
            headers: { 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'video/mp4', 'Content-Length': videoSize, 'x-upsert': 'false' },
            maxBodyLength: Infinity, maxContentLength: Infinity, timeout: 120_000, validateStatus: () => true
          });
          if (uploadRes.status === 200) {
            post.media_url = `${process.env.SUPABASE_URL}/storage/v1/object/public/processed-media/${storagePath}`;
          }
        }
      } catch (videoErr) {
        console.warn(`[PublishingAgent]    Video prep failed: ${videoErr.message}`);
      }
    }
  }

  let lastError;
  let attemptRecordId = null;
  try {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { data: attemptRow } = await supabaseAdmin.from('publish_attempts')
          .insert({ post_id: post.id, user_id: post.user_id, platform: post.platform, status: 'attempting', attempt_number: attempt })
          .select('id').single();
        attemptRecordId = attemptRow?.id || null;

        const result = await publish(post, connection);

        if (attemptRecordId) {
          await supabaseAdmin.from('publish_attempts')
            .update({ status: 'sent', completed_at: new Date().toISOString(), platform_post_id: result.platformPostId })
            .eq('id', attemptRecordId);
        }

        await supabaseAdmin.from('posts').update({
          status: 'published', platform_post_id: result.platformPostId,
          platform_page_id: connection.platform_user_id, published_at: new Date().toISOString(), error_message: null
        }).eq('id', post.id);

        logActivity(post.user_id, 'post_published', { post_id: post.id, platform: post.platform });
        console.log(`[PublishingAgent] ── DONE post ${post.id} → published (${result.platformPostId}) ──`);

        if (post.media_id && mediaItem) {
          await cleanupProcessedMedia(post.media_id, mediaItem);
        }
        return;

      } catch (err) {
        lastError = err;
        if (attemptRecordId) {
          await supabaseAdmin.from('publish_attempts')
            .update({ status: 'failed', completed_at: new Date().toISOString(), error_message: String(err.message).slice(0, 500) })
            .eq('id', attemptRecordId);
          attemptRecordId = null;
        }
        if (attempt < MAX_RETRIES) await sleep(5000 * attempt);
      }
    }
    try { await markFailed(post.id, lastError.message); }
    catch (markErr) { console.error(`[PublishingAgent] markFailed threw for post ${post.id}: ${markErr.message}`); }
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
    const deleteUrl   = `${process.env.SUPABASE_URL}/storage/v1/object/${PROCESSED_MEDIA_BUCKET}/${storagePath}`;
    const deleteResp  = await axios.delete(deleteUrl, {
      headers: { 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
      timeout: 15000, validateStatus: () => true
    });
    if (deleteResp.status >= 200 && deleteResp.status < 300) console.log(`[PublishingAgent] Storage file deleted`);
    await supabaseAdmin.from('media_items')
      .update({ processed_url: null, process_status: 'pending', processed_at: null }).eq('id', mediaId);
  } catch (err) {
    console.warn(`[PublishingAgent] Storage cleanup failed (non-fatal): ${err.message}`);
  }
}

async function markFailed(postId, errorMessage) {
  console.error(`[PublishingAgent] FAILED post ${postId}: ${errorMessage}`);
  await supabaseAdmin.from('posts')
    .update({ status: 'failed', error_message: String(errorMessage).slice(0, 500) }).eq('id', postId);
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

module.exports = { processQueue, publishPost };
```

---

## backend/workers/activityCleanupWorker.js — FULL FILE AT ROLLBACK POINT

Restore from git:
```
git checkout 8aa9c46 -- backend/workers/activityCleanupWorker.js
```

Or paste the complete file content below:

```javascript
/**
 * workers/activityCleanupWorker.js
 *
 * Deletes activity_log rows older than 90 days.
 * Runs nightly at 04:00 UTC via a BullMQ repeatable cron job.
 */

const { Worker } = require('bullmq');
const { connection } = require('../queues');
const { supabaseAdmin } = require('../services/supabaseService');

const activityCleanupWorker = new Worker(
  'activity-cleanup',
  async (job) => {
    if (job.name !== 'cleanup-old-activity') return;

    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    const { error } = await supabaseAdmin
      .from('activity_log')
      .delete()
      .lt('created_at', cutoff);

    if (error) throw new Error('Activity log cleanup failed: ' + error.message);

    console.log(`[ActivityCleanupWorker] Deleted rows older than ${cutoff}`);
  },
  { connection, concurrency: 1 }
);

activityCleanupWorker.on('failed', (job, err) => {
  console.error('[ActivityCleanupWorker] Job failed:', err.message);
});

module.exports = activityCleanupWorker;
```
