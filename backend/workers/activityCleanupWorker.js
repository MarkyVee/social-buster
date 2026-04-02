/**
 * workers/activityCleanupWorker.js
 *
 * Nightly maintenance worker. Runs at 04:00 UTC via BullMQ repeatable cron.
 * Registered in workers/index.js.
 *
 * Two jobs run in sequence:
 *
 * 1. Activity log cleanup
 *    Deletes activity_log rows older than 90 days to keep the table lean.
 *    Throws on error → BullMQ retries (critical maintenance path).
 *
 * 2. Storage cleanup (cleanupOrphanedStorage)
 *    Deletes files from the processed-media Supabase bucket that are no longer
 *    needed. Two passes per run:
 *
 *    Pass A — Reference-counted cleanup:
 *      Finds media_items where process_status = 'ready' AND every posts row
 *      using that media_id has a terminal status (published / failed / cancelled).
 *      Safe to delete only once all posts sharing the file are done.
 *      Resets process_status to 'pending' BEFORE deleting the file, so any
 *      concurrent read sees 'pending' and waits for re-processing rather than
 *      trying to use a deleted URL.
 *
 *    Pass B — Orphan sweep:
 *      Finds media_items where process_status = 'ready' AND processed_at is
 *      older than 24 hours AND no posts row references the media_id at all.
 *      These are files that were processed but never attached to a post, or
 *      whose posts were deleted. Also catches re-encoded Instagram/Threads video
 *      copies that weren't cleaned up at publish time.
 *
 *    Storage cleanup is non-fatal — a failure logs a warning but does NOT
 *    throw. The activity log cleanup is the critical path; storage cleanup
 *    is best-effort maintenance.
 *
 * What is NEVER deleted:
 *   - AI-generated images (cloud_provider = 'ai_generated') — user may reuse
 *   - Files in 'ai-generated-images' bucket — separate bucket, separate lifecycle
 *   - Files in 'video-segments' bucket — analysis data, not media copies
 *   - media_items rows themselves — only the Supabase Storage file is removed
 */

const { Worker } = require('bullmq');
const axios      = require('axios');
const { connection }    = require('../queues');
const { supabaseAdmin } = require('../services/supabaseService');

const PROCESSED_MEDIA_BUCKET = 'processed-media';

// Terminal post statuses — a post in one of these states is done with its media file.
// Any other status (draft, approved, scheduled, publishing) means the file is still needed.
const TERMINAL_STATUSES = ['published', 'failed', 'cancelled'];

// ----------------------------------------------------------------
// activityCleanupWorker
// ----------------------------------------------------------------
const activityCleanupWorker = new Worker(
  'activity-cleanup',

  async (job) => {
    if (job.name !== 'cleanup-old-activity') return;

    // ── Step 1: Activity log cleanup (critical — throws on failure) ──
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    const { error } = await supabaseAdmin
      .from('activity_log')
      .delete()
      .lt('created_at', cutoff);

    if (error) throw new Error('Activity log cleanup failed: ' + error.message);

    console.log(`[ActivityCleanupWorker] Activity log: deleted rows older than ${cutoff}`);

    // ── Step 2: Storage cleanup (non-fatal — best-effort) ──
    try {
      await cleanupOrphanedStorage();
    } catch (storageErr) {
      // Log but don't throw — storage cleanup failure must not retry the whole job
      // and should not block the next nightly run.
      console.warn(`[ActivityCleanupWorker] Storage cleanup failed (non-fatal): ${storageErr.message}`);
    }
  },

  { connection, concurrency: 1 }
);

// ----------------------------------------------------------------
// cleanupOrphanedStorage
// Deletes files from processed-media bucket that are no longer needed.
// Two passes: reference-counted cleanup, then orphan sweep.
// ----------------------------------------------------------------
async function cleanupOrphanedStorage() {
  console.log('[ActivityCleanupWorker] Starting storage cleanup...');
  let deletedCount = 0;

  // ── Pass A: Reference-counted cleanup ────────────────────────────
  // Find media_items that are 'ready' (file exists in Supabase) and whose
  // every associated post has reached a terminal status.
  //
  // Query strategy: fetch all 'ready' media_items, then for each one check
  // whether any non-terminal posts still reference it. Skip if any exist.
  //
  // We process in batches of 50 to avoid loading thousands of rows at once.
  const { data: readyItems, error: readyErr } = await supabaseAdmin
    .from('media_items')
    .select('id, user_id, cloud_provider, processed_url, processed_at')
    .eq('process_status', 'ready')
    .not('cloud_provider', 'eq', 'ai_generated')  // never touch AI images
    .not('processed_url', 'is', null)
    .limit(200);  // process up to 200 per nightly run — enough for any realistic volume

  if (readyErr) {
    console.warn('[ActivityCleanupWorker] Could not fetch ready media_items:', readyErr.message);
  } else {
    for (const item of (readyItems || [])) {
      // Skip files not in processed-media bucket (safety check)
      if (!item.processed_url?.includes(PROCESSED_MEDIA_BUCKET)) continue;

      // Count posts that still need this file (not yet in a terminal status)
      const { count: activeCount, error: countErr } = await supabaseAdmin
        .from('posts')
        .select('id', { count: 'exact', head: true })
        .eq('media_id', item.id)
        .not('status', 'in', `(${TERMINAL_STATUSES.map(s => `"${s}"`).join(',')})`);

      if (countErr) {
        console.warn(`[ActivityCleanupWorker] Could not check post count for media ${item.id}: ${countErr.message}`);
        continue;
      }

      if (activeCount > 0) {
        // At least one post still needs this file — leave it alone
        continue;
      }

      // All posts are done (or there are no posts — covered by Pass B below).
      // Check there is at least one post referencing this media_id before deleting.
      // (Items with zero posts are handled by Pass B.)
      const { count: totalCount } = await supabaseAdmin
        .from('posts')
        .select('id', { count: 'exact', head: true })
        .eq('media_id', item.id);

      if (!totalCount || totalCount === 0) continue;  // Pass B handles zero-post orphans

      // Safe to delete. Reset process_status FIRST so any concurrent read sees
      // 'pending' and waits for re-processing rather than using a deleted URL.
      await supabaseAdmin
        .from('media_items')
        .update({ process_status: 'pending', processed_url: null, processed_at: null })
        .eq('id', item.id);

      await deleteStorageFile(item.processed_url);
      deletedCount++;
      console.log(`[ActivityCleanupWorker] Pass A: deleted file for media ${item.id} (all posts terminal)`);
    }
  }

  // ── Pass B: Orphan sweep ─────────────────────────────────────────
  // Find media_items that are 'ready', older than 24 hours, and have NO posts
  // referencing them at all. These are:
  //   - Files processed but never attached to a post
  //   - Files whose posts were later deleted
  //   - Re-encoded Instagram/Threads video copies that weren't cleaned up at publish
  //
  // The 24-hour buffer gives the user time to attach freshly processed media
  // to a post before we sweep it. Without this, media processed at 11pm could
  // be deleted before the user schedules their morning post.
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: orphanItems, error: orphanErr } = await supabaseAdmin
    .from('media_items')
    .select('id, user_id, cloud_provider, processed_url')
    .eq('process_status', 'ready')
    .not('cloud_provider', 'eq', 'ai_generated')
    .not('processed_url', 'is', null)
    .lte('processed_at', oneDayAgo)
    .limit(200);

  if (orphanErr) {
    console.warn('[ActivityCleanupWorker] Could not fetch orphan candidates:', orphanErr.message);
  } else {
    for (const item of (orphanItems || [])) {
      if (!item.processed_url?.includes(PROCESSED_MEDIA_BUCKET)) continue;

      const { count: postCount } = await supabaseAdmin
        .from('posts')
        .select('id', { count: 'exact', head: true })
        .eq('media_id', item.id);

      if (postCount > 0) continue;  // Has posts — Pass A handles it

      // No posts at all. Safe to delete.
      await supabaseAdmin
        .from('media_items')
        .update({ process_status: 'pending', processed_url: null, processed_at: null })
        .eq('id', item.id);

      await deleteStorageFile(item.processed_url);
      deletedCount++;
      console.log(`[ActivityCleanupWorker] Pass B: deleted orphaned file for media ${item.id}`);
    }
  }

  console.log(`[ActivityCleanupWorker] Storage cleanup complete — ${deletedCount} file(s) deleted`);
}

// ----------------------------------------------------------------
// deleteStorageFile — deletes a single file from Supabase Storage.
// Takes the full public URL, extracts the storage path, and calls DELETE.
// Non-throwing — logs warnings instead.
// ----------------------------------------------------------------
async function deleteStorageFile(publicUrl) {
  try {
    const bucketPrefix = `/storage/v1/object/public/${PROCESSED_MEDIA_BUCKET}/`;
    const pathIndex    = publicUrl.indexOf(bucketPrefix);

    if (pathIndex === -1) {
      console.warn(`[ActivityCleanupWorker] Cannot extract path from URL: ${publicUrl}`);
      return;
    }

    const storagePath = publicUrl.slice(pathIndex + bucketPrefix.length);
    const deleteUrl   = `${process.env.SUPABASE_URL}/storage/v1/object/${PROCESSED_MEDIA_BUCKET}/${storagePath}`;

    const resp = await axios.delete(deleteUrl, {
      headers: { 'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
      timeout: 15000,
      validateStatus: () => true
    });

    if (resp.status === 404) {
      console.log(`[ActivityCleanupWorker] File already gone (404): ${storagePath}`);
    } else if (resp.status < 200 || resp.status >= 300) {
      console.warn(`[ActivityCleanupWorker] Delete returned HTTP ${resp.status} for ${storagePath}`);
    }

  } catch (err) {
    console.warn(`[ActivityCleanupWorker] deleteStorageFile error: ${err.message}`);
  }
}

// ----------------------------------------------------------------
// Worker event logging
// ----------------------------------------------------------------
activityCleanupWorker.on('failed', (job, err) => {
  console.error('[ActivityCleanupWorker] Job failed:', err.message);
});

module.exports = activityCleanupWorker;
