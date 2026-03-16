/**
 * agents/mediaProcessAgent.js
 *
 * Copies user media files to Supabase Storage when a user attaches media to a
 * post. Called by workers/mediaProcessWorker.js via the 'media-process' BullMQ queue.
 *
 * WHY THIS EXISTS
 * ---------------
 * The old approach downloaded files from their cloud source (Google Drive, etc.)
 * at publish time — inside the same BullMQ job that calls the platform API.
 * That approach is fragile: one Drive token refresh failure, network timeout, or
 * large-file download silently caused posts to publish without their media.
 *
 * This agent separates the two concerns:
 *   1. Copy media to Supabase Storage (this file, runs at attach time)
 *   2. Publish using the Supabase URL (publishingAgent, runs at publish time)
 *
 * After this agent runs, media_items.processed_url is a public Supabase URL
 * with no auth dependency. The publish worker never touches Drive again.
 *
 * FLOW PER PROVIDER
 * -----------------
 *   ai_generated  → already in Supabase → set processed_url = cloud_url, status = ready
 *   google_drive  → Drive API download (authenticated) → upload to 'processed-media' bucket
 *   manual / other → if cloud_url is a direct public URL, use it as-is
 *
 * NOTE: Video trimming is NOT done here — it's platform-specific and depends on
 * per-post settings (trim_start_seconds). The publish worker handles trim after
 * downloading the already-copied Supabase file.
 */

const axios  = require('axios');
const fs     = require('fs');
const { v4: uuidv4 } = require('uuid');

const { supabaseAdmin }           = require('../services/supabaseService');
const { downloadGoogleDriveFile } = require('../services/googleDriveService');
const { cleanupTemp }             = require('../services/ffmpegService');

// Supabase Storage bucket that holds all pre-processed user media.
// Must be created manually in the Supabase dashboard and set to PUBLIC.
const BUCKET = 'processed-media';

// ----------------------------------------------------------------
// processMediaItem — main export, called by the BullMQ worker.
//
// Fetches the media_items row, copies the file to Supabase Storage
// (or confirms it's already there), then sets process_status to
// 'ready' or 'failed' so the publish worker knows what to do.
// ----------------------------------------------------------------
async function processMediaItem(mediaItemId) {
  console.log(`[MediaProcess] Starting item ${mediaItemId}...`);

  // Fetch the media item
  const { data: item, error } = await supabaseAdmin
    .from('media_items')
    .select('id, user_id, cloud_url, cloud_provider, file_type, filename, process_status')
    .eq('id', mediaItemId)
    .single();

  if (error || !item) {
    throw new Error(`Media item ${mediaItemId} not found: ${error?.message}`);
  }

  console.log(`[MediaProcess] Item ${mediaItemId}: provider=${item.cloud_provider} type=${item.file_type} status=${item.process_status}`);

  // Already ready — nothing to do (idempotent guard)
  if (item.process_status === 'ready') {
    console.log(`[MediaProcess] Item ${mediaItemId} already ready, skipping.`);
    return;
  }

  // Mark as 'processing' (atomic — only if still 'pending' or 'failed').
  // This prevents two concurrent jobs from both downloading the same file.
  await supabaseAdmin
    .from('media_items')
    .update({ process_status: 'processing' })
    .eq('id', mediaItemId)
    .in('process_status', ['pending', 'failed']);

  try {
    const processedUrl = await resolveProcessedUrl(item);

    // Mark ready with the Supabase URL
    await supabaseAdmin
      .from('media_items')
      .update({
        processed_url:  processedUrl,
        process_status: 'ready',
        process_error:  null,
        processed_at:   new Date().toISOString()
      })
      .eq('id', mediaItemId);

    console.log(`[MediaProcess] Item ${mediaItemId} → ready: ${processedUrl}`);

  } catch (err) {
    console.error(`[MediaProcess] Item ${mediaItemId} failed: ${err.message}`);

    await supabaseAdmin
      .from('media_items')
      .update({
        process_status: 'failed',
        process_error:  String(err.message).slice(0, 500)
      })
      .eq('id', mediaItemId);

    // Re-throw so BullMQ marks the job failed and triggers its retry logic
    throw err;
  }
}

// ----------------------------------------------------------------
// resolveProcessedUrl — determines the correct Supabase URL for
// the given media item, downloading and uploading as needed.
// ----------------------------------------------------------------
async function resolveProcessedUrl(item) {
  // AI-generated images are already in Supabase Storage — use their URL directly.
  // No upload needed.
  if (item.cloud_provider === 'ai_generated') {
    console.log(`[MediaProcess] AI image already in Supabase — using cloud_url directly`);
    return item.cloud_url;
  }

  // Google Drive VIDEOS: skip Supabase copy entirely.
  // Videos can be hundreds of MB — Supabase free tier limits uploads to 50 MB.
  // At publish time, publishingAgent downloads the video directly via Drive API.
  if (item.cloud_provider === 'google_drive' && item.file_type === 'video') {
    console.log(`[MediaProcess] Google Drive video — skipping Supabase copy, will download via Drive API at publish time`);
    return item.cloud_url;
  }

  // Google Drive IMAGES: download via authenticated Drive API, then upload to Supabase.
  // We CANNOT use the webViewLink URL directly — it requires a browser session.
  if (item.cloud_provider === 'google_drive') {
    const extension   = getExtension(item.filename, item.file_type);
    const contentType = getContentType(item.file_type, extension);

    console.log(`[MediaProcess] Downloading ${item.file_type} from Google Drive...`);
    const tempPath = await downloadGoogleDriveFile(item.user_id, item.cloud_url, extension);

    try {
      console.log(`[MediaProcess] Uploading to Supabase Storage (bucket: ${BUCKET})...`);
      const publicUrl = await uploadToSupabase(tempPath, item.user_id, extension, contentType);
      console.log(`[MediaProcess] Upload complete: ${publicUrl}`);
      return publicUrl;
    } finally {
      // Always clean up the temp file — whether upload succeeded or threw
      cleanupTemp(tempPath);
    }
  }

  // All other providers (manual, dropbox, box) — use the cloud_url as-is.
  // These are assumed to be publicly accessible direct URLs.
  // If they aren't, publish will fail loudly with a real error message.
  console.log(`[MediaProcess] Provider '${item.cloud_provider}' — using cloud_url directly`);
  return item.cloud_url;
}

// ----------------------------------------------------------------
// uploadToSupabase — streams a local file to the processed-media bucket.
// Uses the service role key to bypass RLS.
// Returns the permanent public URL.
// ----------------------------------------------------------------
async function uploadToSupabase(localPath, userId, extension, contentType) {
  const storagePath = `${userId}/${uuidv4()}.${extension}`;
  const storageUrl  = `${process.env.SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`;

  const fileStream = fs.createReadStream(localPath);
  const fileSize   = fs.statSync(localPath).size;

  console.log(`[MediaProcess] Uploading ${Math.round(fileSize / 1024)}KB to ${storageUrl}`);

  const response = await axios.post(storageUrl, fileStream, {
    headers: {
      'Authorization':  `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type':   contentType,
      'Content-Length': fileSize,
      'x-upsert':       'false'
    },
    maxBodyLength:    Infinity,
    maxContentLength: Infinity,
    timeout:          5 * 60 * 1000,  // 5 minutes — large video files take time
    validateStatus:   () => true       // Don't throw on non-2xx — we'll log the real error
  });

  if (response.status !== 200) {
    const detail = response.data?.message || response.data?.error || JSON.stringify(response.data);
    throw new Error(`Supabase Storage upload failed HTTP ${response.status}: ${detail}`);
  }

  return `${process.env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`;
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------
function getExtension(filename, fileType) {
  if (filename) {
    const parts = filename.split('.');
    if (parts.length > 1) return parts.pop().toLowerCase();
  }
  return fileType === 'video' ? 'mp4' : 'jpg';
}

function getContentType(fileType, extension) {
  if (fileType === 'video') {
    return extension === 'mov' ? 'video/quicktime' : 'video/mp4';
  }
  if (extension === 'png')  return 'image/png';
  if (extension === 'gif')  return 'image/gif';
  if (extension === 'webp') return 'image/webp';
  return 'image/jpeg';
}

module.exports = { processMediaItem };
