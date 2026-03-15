/**
 * services/videoAnalysisService.js  (v2 — stream pipeline)
 *
 * Previous approach (v1) was:
 *   Download full video → scene detection → 30+ FFmpeg processes → 10+ minutes for a 4-min video
 *
 * New approach (v2):
 *   Stream → pipe:0 → single FFmpeg pass → chapter thumbnails → vision LLM → done in ~1-2 min
 *
 * What changed and why:
 *
 *   1. NO FULL DOWNLOAD — the video stream from Google Drive (or any URL) is piped
 *      directly into FFmpeg's stdin (pipe:0). We never write the full video to disk.
 *      This eliminates a 2-3 minute wait for a 378 MB file.
 *
 *   2. FIXED CHAPTER THUMBNAILS instead of scene detection.
 *      The old 'select=gt(scene,0.3)' filter decoded every single frame at full
 *      resolution to compute scene scores — ~9,000 frames for a 5-min 30fps video.
 *      New: 'fps=1/N' extracts one frame every N seconds in a single pass.
 *      10 chapters for a 5-min video. Same clip picker UX, ~20× faster analysis.
 *
 *   3. ONE FFMPEG PROCESS per video (was 30+ separate runs).
 *      No more per-segment volumedetect or individual frame extractions.
 *      Audio energy is dropped — the vision LLM's mood/tags carry that signal.
 *
 *   4. BullMQ concurrency stays at 1 — the stream stays open during the whole
 *      FFmpeg pipe, and two concurrent streams on a 2-core VPS would fight for I/O.
 *
 * Pipeline:
 *   1. Fetch media item from DB
 *   2. Get video duration (stored field, or Drive metadata API, or ffprobe on URL)
 *   3. Check 500 MB / 5-min limits — reject too_large immediately, no download
 *   4. Calculate chapter interval: totalDuration / 10 chapters, clamped 10–60s
 *   5. Open Drive/URL stream → pipe to FFmpeg → extract chapter JPEGs to temp dir
 *   6. Upload each thumbnail to Supabase Storage
 *   7. Call vision LLM on each thumbnail (description, tags, mood)
 *   8. Derive pacing + platform_fit from chapter duration
 *   9. Insert all rows into video_segments, mark item as 'ready'
 *  10. Clean temp dir
 */

'use strict';

const path      = require('path');
const os        = require('os');
const fs        = require('fs/promises');
const fssync    = require('fs');
const axios     = require('axios');
const { spawn } = require('child_process');    // native spawn for pipe:0
const ffmpeg    = require('fluent-ffmpeg');    // kept only for ffprobe

const { supabaseAdmin }        = require('./supabaseService');
const { getGoogleDriveClient } = require('./googleDriveService');
const { tagSegmentWithVision } = require('./visionTaggingService');

// Use FFMPEG_PATH env var if set (e.g. in Docker). Applies to both ffprobe and spawn.
const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';
if (process.env.FFMPEG_PATH) {
  ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
}

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------

// We aim for this many chapter thumbnails per video
const TARGET_CHAPTERS = 10;

// Clamp chapter interval to this range (seconds)
const MIN_INTERVAL_SECS = 10;
const MAX_INTERVAL_SECS = 60;

// Source video caps — checked before opening the stream
const MAX_VIDEO_SIZE_BYTES    = 500 * 1024 * 1024;  // 500 MB
const MAX_VIDEO_DURATION_SECS = 5 * 60;             // 5 minutes

// Hard timeout for the entire stream → FFmpeg pipe operation (5 minutes)
const STREAM_TIMEOUT_MS = 5 * 60 * 1000;

// Supabase Storage bucket for thumbnails
const THUMBNAIL_BUCKET = 'video-segments';

// ----------------------------------------------------------------
// analyzeVideo — main entry point, called by mediaAnalysisWorker
//
// mediaItemId: UUID of the media_items row to analyze.
// Returns: number of segments (chapters) saved.
// ----------------------------------------------------------------
async function analyzeVideo(mediaItemId) {
  console.log(`[VideoAnalysis] Starting analysis for media item ${mediaItemId}`);

  await setAnalysisStatus(mediaItemId, 'analyzing');

  let tempDir = null;

  try {
    // ---- Step 1: Fetch the media item record ----
    const { data: item, error: fetchError } = await supabaseAdmin
      .from('media_items')
      .select('id, user_id, cloud_url, cloud_file_id, cloud_provider, filename, duration_seconds, file_type')
      .eq('id', mediaItemId)
      .single();

    if (fetchError || !item) {
      throw new Error(`Media item ${mediaItemId} not found: ${fetchError?.message}`);
    }

    if (item.file_type !== 'video') {
      await setAnalysisStatus(mediaItemId, 'ready');
      return 0;
    }

    if (!item.cloud_url && !item.cloud_file_id) {
      throw new Error('Media item has no downloadable URL or file ID — cannot analyse');
    }

    // ---- Step 2: Resolve video duration ----
    // We need duration BEFORE opening the stream so we can:
    //   a) reject videos over the 5-min cap without streaming them
    //   b) calculate the chapter interval
    // Sources in priority order:
    //   1. item.duration_seconds (stored during media scan — free, instant)
    //   2. Google Drive videoMediaMetadata.durationMillis (one lightweight API call)
    //   3. ffprobe run on the URL (reads only the container header, not the full file)
    const durationSeconds = await resolveVideoDuration(item);

    if (!durationSeconds || durationSeconds <= 0) {
      throw new Error(`Could not determine video duration for ${item.filename} — cannot build chapters`);
    }

    // ---- Step 3: Enforce limits ----
    if (durationSeconds > MAX_VIDEO_DURATION_SECS) {
      console.log(`[VideoAnalysis] Skipping ${item.filename} — ${Math.round(durationSeconds)}s exceeds ${MAX_VIDEO_DURATION_SECS}s cap`);
      await setAnalysisStatus(mediaItemId, 'too_large');
      return 0;
    }

    const sizeBytes = await resolveVideoSize(item);
    if (sizeBytes && sizeBytes > MAX_VIDEO_SIZE_BYTES) {
      console.log(`[VideoAnalysis] Skipping ${item.filename} — ${Math.round(sizeBytes / 1024 / 1024)}MB exceeds 500MB cap`);
      await setAnalysisStatus(mediaItemId, 'too_large');
      return 0;
    }

    // ---- Step 4: Calculate chapter interval ----
    // Aim for TARGET_CHAPTERS thumbnails, clamped so we never go below
    // 10s (too many thumbs) or above 60s (too sparse for a short clip).
    const interval = Math.min(
      MAX_INTERVAL_SECS,
      Math.max(MIN_INTERVAL_SECS, Math.ceil(durationSeconds / TARGET_CHAPTERS))
    );
    const expectedChapters = Math.floor(durationSeconds / interval);
    console.log(`[VideoAnalysis] ${item.filename}: ${Math.round(durationSeconds)}s → 1 chapter every ${interval}s (~${expectedChapters} total)`);

    // ---- Step 5: Stream video → FFmpeg pipe → extract chapter JPEGs ----
    // No full download — the stream is piped directly into FFmpeg stdin.
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sb-analysis-'));

    await extractChapterThumbnails(item, interval, tempDir);

    // ---- Step 6: Find generated thumbnails ----
    const thumbFiles = (await fs.readdir(tempDir))
      .filter(f => f.startsWith('thumb') && f.endsWith('.jpg'))
      .sort();  // sort alphabetically: thumb001 → thumb002 → ...

    console.log(`[VideoAnalysis] Extracted ${thumbFiles.length} chapter thumbnails`);

    if (thumbFiles.length === 0) {
      throw new Error('FFmpeg produced no thumbnails — video may be corrupt or an unsupported format');
    }

    // ---- Step 7: Upload thumbnails + run vision LLM + build segment rows ----
    const segmentRows = [];

    for (let i = 0; i < thumbFiles.length; i++) {
      try {
        const thumbPath    = path.join(tempDir, thumbFiles[i]);
        const startSeconds = i * interval;
        const endSeconds   = Math.min(durationSeconds, (i + 1) * interval);
        const segDuration  = endSeconds - startSeconds;

        // Upload to Supabase Storage (REST API — bypasses RLS)
        const thumbUrl = await uploadThumbnail(thumbPath, item.user_id, mediaItemId, i);

        // Vision LLM — non-blocking: returns null if not configured or if it fails
        const visionData = await tagSegmentWithVision(thumbUrl);

        const pacing      = derivePacing(segDuration);
        const platformFit = derivePlatformFit(segDuration, pacing);

        segmentRows.push({
          media_item_id: mediaItemId,
          user_id:       item.user_id,
          start_seconds: startSeconds,
          end_seconds:   endSeconds,
          thumbnail_url: thumbUrl,
          description:   visionData?.description || null,
          tags:          visionData?.tags        || [],
          mood:          visionData?.mood        || null,
          energy_level:  5,   // Audio energy analysis removed in v2.
                              // Default to mid-scale (5). Vision LLM mood carries this signal.
          pacing,
          platform_fit:  platformFit
        });

      } catch (segErr) {
        // One bad chapter doesn't abort the whole analysis
        console.warn(`[VideoAnalysis] Chapter ${i} failed: ${segErr.message} — skipping`);
      }
    }

    // ---- Step 8: Save segments to DB ----
    if (segmentRows.length > 0) {
      const { error: insertError } = await supabaseAdmin
        .from('video_segments')
        .insert(segmentRows);

      if (insertError) {
        throw new Error(`Failed to save segments: ${insertError.message}`);
      }
    }

    // ---- Step 9: Mark the media item as ready ----
    await setAnalysisStatus(mediaItemId, 'ready');

    console.log(`[VideoAnalysis] Done: ${segmentRows.length} chapters saved for ${mediaItemId}`);
    return segmentRows.length;

  } catch (err) {
    console.error(`[VideoAnalysis] Failed for ${mediaItemId}: ${err.message}`);
    await setAnalysisStatus(mediaItemId, 'failed');
    throw err;

  } finally {
    // Always clean up temp thumbnails, even on failure
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// ----------------------------------------------------------------
// extractChapterThumbnails
//
// The core of the v2 pipeline. Opens a stream from the video source
// and pipes it directly into FFmpeg's stdin (pipe:0). FFmpeg extracts
// one JPEG frame every `interval` seconds in a single pass.
//
// No video file is written to disk — only small JPEG thumbnails.
//
// Uses native child_process.spawn (not fluent-ffmpeg) because
// fluent-ffmpeg doesn't handle pipe:0 input cleanly.
// ----------------------------------------------------------------
async function extractChapterThumbnails(item, interval, tempDir) {
  const outputPattern = path.join(tempDir, 'thumb%03d.jpg');

  // fps=1/N  → exactly one frame every N seconds (reliable, works at any frame rate)
  // scale=320:-2 → resize to 320px wide, height auto (aspect ratio preserved)
  // -vsync vfr  → variable frame rate output so FFmpeg doesn't duplicate frames
  // -q:v 3      → good quality JPEG (scale 1=best, 31=worst)
  // -an         → strip audio (not needed for thumbnails)
  const ffmpegArgs = [
    '-i',      'pipe:0',
    '-vf',     `fps=1/${interval},scale=320:-2`,
    '-vsync',  'vfr',
    '-q:v',    '3',
    '-an',
    outputPattern
  ];

  return new Promise(async (resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, ffmpegArgs);

    // Collect stderr so we can include it in error messages for debugging
    let stderr = '';
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });

    // Hard timeout — if the stream or FFmpeg hangs, kill the process
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      reject(new Error(`Stream pipe timed out after ${STREAM_TIMEOUT_MS / 60000} minutes`));
    }, STREAM_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timeoutId);
      if (timedOut) return; // already rejected
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg exited ${code}: ${stderr.slice(-500)}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(new Error(`FFmpeg spawn failed: ${err.message}`));
    });

    // Suppress EPIPE errors on stdin — these are expected when FFmpeg closes
    // its end of the pipe after receiving all the data it needs.
    proc.stdin.on('error', (err) => {
      if (err.code !== 'EPIPE') {
        clearTimeout(timeoutId);
        reject(new Error(`FFmpeg stdin error: ${err.message}`));
      }
    });

    // Open the video stream and pipe it into FFmpeg's stdin
    try {
      const inputStream = await getVideoStream(item);

      inputStream.on('error', (err) => {
        clearTimeout(timeoutId);
        proc.kill('SIGTERM');
        reject(new Error(`Video stream error: ${err.message}`));
      });

      inputStream.pipe(proc.stdin);

    } catch (streamErr) {
      clearTimeout(timeoutId);
      proc.kill('SIGTERM');
      reject(streamErr);
    }
  });
}

// ----------------------------------------------------------------
// getVideoStream
//
// Returns a Node.js ReadableStream for the video source.
// ----------------------------------------------------------------
async function getVideoStream(item) {
  if (item.cloud_provider === 'google_drive' && item.cloud_file_id) {
    return getGoogleDriveStream(item.user_id, item.cloud_file_id);
  }
  if (item.cloud_url) {
    return getUrlStream(item.cloud_url);
  }
  throw new Error('No cloud source available for streaming');
}

async function getGoogleDriveStream(userId, fileId) {
  const { data: connection, error } = await supabaseAdmin
    .from('cloud_connections')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', 'google_drive')
    .single();

  if (error || !connection) {
    throw new Error('Google Drive connection not found — user may have disconnected');
  }

  const { drive }  = await getGoogleDriveClient(userId, connection);
  const response   = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );

  return response.data;
}

async function getUrlStream(url) {
  const response = await axios.get(url, {
    responseType: 'stream',
    timeout:      30000   // connection/header timeout; stream itself is managed by the pipe timeout
  });
  return response.data;
}

// ----------------------------------------------------------------
// resolveVideoDuration
//
// Gets the video duration WITHOUT downloading the file.
// Sources in priority order (fastest first):
//   1. item.duration_seconds — stored during initial media scan (free)
//   2. Google Drive videoMediaMetadata.durationMillis — one API call
//   3. ffprobe on the URL — reads only the container header
// ----------------------------------------------------------------
async function resolveVideoDuration(item) {
  // Fastest path: already stored when the file was scanned
  if (item.duration_seconds && item.duration_seconds > 0) {
    return item.duration_seconds;
  }

  if (item.cloud_provider === 'google_drive' && item.cloud_file_id) {
    try {
      const { drive } = await getDriveClientForUser(item.user_id);
      const meta      = await drive.files.get({
        fileId:            item.cloud_file_id,
        fields:            'videoMediaMetadata',
        supportsAllDrives: true
      });
      const ms = parseInt(meta.data?.videoMediaMetadata?.durationMillis || '0', 10);
      if (ms > 0) return ms / 1000;
    } catch (_) { /* fall through */ }
  }

  if (item.cloud_url) {
    // ffprobe reads only the container header from the URL — fast (~1-2s)
    return getVideoDuration(item.cloud_url);
  }

  return 0;
}

// ----------------------------------------------------------------
// resolveVideoSize
//
// Gets the video file size in bytes WITHOUT downloading.
// Returns null if unknown — size check is best-effort only.
// ----------------------------------------------------------------
async function resolveVideoSize(item) {
  try {
    if (item.cloud_provider === 'google_drive' && item.cloud_file_id) {
      const { drive } = await getDriveClientForUser(item.user_id);
      const meta      = await drive.files.get({
        fileId:            item.cloud_file_id,
        fields:            'size',
        supportsAllDrives: true
      });
      return parseInt(meta.data?.size || '0', 10);

    } else if (item.cloud_url) {
      const headRes = await axios.head(item.cloud_url, { timeout: 10000 });
      return parseInt(headRes.headers['content-length'] || '0', 10);
    }
  } catch (_) { /* non-fatal — skip size check */ }

  return null;
}

// ----------------------------------------------------------------
// getDriveClientForUser
//
// Fetches the user's Google Drive connection and returns an
// authenticated Drive client. Shared by resolveVideoDuration,
// resolveVideoSize, and getGoogleDriveStream.
// ----------------------------------------------------------------
async function getDriveClientForUser(userId) {
  const { data: conn, error } = await supabaseAdmin
    .from('cloud_connections')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', 'google_drive')
    .single();

  if (error || !conn) throw new Error('Google Drive connection not found');

  return getGoogleDriveClient(userId, conn);
}

// ----------------------------------------------------------------
// getVideoDuration
//
// Runs ffprobe on a local file path OR a URL to read the container
// duration without downloading the full video. Includes a 10-second
// timeout so a hung ffprobe can never stall the whole job.
// ----------------------------------------------------------------
function getVideoDuration(pathOrUrl) {
  const probePromise = new Promise((resolve) => {
    ffmpeg.ffprobe(pathOrUrl, (err, metadata) => {
      if (err) { resolve(0); return; }
      resolve(Math.floor(metadata?.format?.duration || 0));
    });
  });

  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => {
      console.warn('[VideoAnalysis] ffprobe timed out — defaulting duration to 0');
      resolve(0);
    }, 10000)
  );

  return Promise.race([probePromise, timeoutPromise]);
}

// ----------------------------------------------------------------
// uploadThumbnail
//
// Uploads a JPEG thumbnail to Supabase Storage using the REST API
// directly (same approach as imageGenerationService.js).
//
// Why REST API instead of supabaseAdmin.storage.from().upload()?
// The JS client's storage methods can fail with RLS errors even
// with the service role key if bucket policies are missing.
// The direct REST API with the service role header always bypasses
// storage policies — it is the authoritative admin upload method.
//
// Returns the public URL, or null if the upload fails.
// ----------------------------------------------------------------
async function uploadThumbnail(thumbPath, userId, mediaItemId, segmentIndex) {
  const fileBuffer  = await fs.readFile(thumbPath);
  const storagePath = `${userId}/${mediaItemId}/seg_${segmentIndex}.jpg`;
  const storageUrl  = `${process.env.SUPABASE_URL}/storage/v1/object/${THUMBNAIL_BUCKET}/${storagePath}`;

  try {
    const uploadResponse = await axios.post(storageUrl, fileBuffer, {
      headers: {
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type':  'image/jpeg',
        'x-upsert':      'true'   // Overwrite if analysis is re-run on the same video
      },
      timeout: 30000,
      maxContentLength: Infinity,
      maxBodyLength:    Infinity
    });

    if (uploadResponse.status !== 200) {
      console.warn(`[VideoAnalysis] Thumbnail upload HTTP ${uploadResponse.status} for chapter ${segmentIndex}`);
      return null;
    }

    return `${process.env.SUPABASE_URL}/storage/v1/object/public/${THUMBNAIL_BUCKET}/${storagePath}`;

  } catch (uploadErr) {
    const detail = uploadErr.response?.data?.message || uploadErr.message;
    console.warn(`[VideoAnalysis] Thumbnail upload failed for chapter ${segmentIndex}: ${detail}`);
    return null;
  }
}

// ----------------------------------------------------------------
// derivePacing
//
// Infers pacing from the duration of a single segment/chapter.
// ----------------------------------------------------------------
function derivePacing(segmentDurationSeconds) {
  if (segmentDurationSeconds <= 5)  return 'fast';
  if (segmentDurationSeconds <= 15) return 'moderate';
  return 'slow';
}

// ----------------------------------------------------------------
// derivePlatformFit
//
// Returns an array of platform names this segment is well-suited for,
// based on its duration and pacing.
// ----------------------------------------------------------------
function derivePlatformFit(durationSeconds, pacing) {
  const platforms = [];

  if (durationSeconds <= 60)  platforms.push('tiktok', 'instagram', 'youtube');
  if (durationSeconds <= 140) platforms.push('x');
  if (durationSeconds <= 180) platforms.push('facebook');
  if (durationSeconds <= 300) platforms.push('threads');
  if (durationSeconds <= 600) platforms.push('linkedin');

  if (pacing === 'fast' && !platforms.includes('tiktok')) {
    platforms.push('tiktok', 'instagram');
  }

  return [...new Set(platforms)];
}

// ----------------------------------------------------------------
// setAnalysisStatus
//
// Updates the analysis_status column on a media_items row.
// ----------------------------------------------------------------
async function setAnalysisStatus(mediaItemId, status) {
  await supabaseAdmin
    .from('media_items')
    .update({ analysis_status: status })
    .eq('id', mediaItemId);
}

// ----------------------------------------------------------------
// retagUntaggedSegments
//
// Back-fills vision tags on segments that were saved without them
// (e.g. from the old v1 pipeline or if the vision API was down).
// Called once at server startup by workers/index.js.
// ----------------------------------------------------------------
async function retagUntaggedSegments() {
  const { data: segments, error } = await supabaseAdmin
    .from('video_segments')
    .select('id, thumbnail_url')
    .is('description', null)
    .not('thumbnail_url', 'is', null);

  if (error) {
    console.error('[VideoAnalysis] Failed to fetch untagged segments:', error.message);
    return 0;
  }

  if (!segments || segments.length === 0) return 0;

  console.log(`[VideoAnalysis] Found ${segments.length} untagged segment(s) — starting vision re-tagging`);

  let successCount = 0;

  for (const seg of segments) {
    try {
      const visionData = await tagSegmentWithVision(seg.thumbnail_url);

      if (!visionData) continue;

      const { error: updateError } = await supabaseAdmin
        .from('video_segments')
        .update({
          description: visionData.description,
          tags:        visionData.tags,
          mood:        visionData.mood
        })
        .eq('id', seg.id);

      if (updateError) {
        console.warn(`[VideoAnalysis] Failed to update segment ${seg.id}: ${updateError.message}`);
      } else {
        successCount++;
      }

      // Small pause between API calls — be polite to vision API rate limits
      await new Promise(resolve => setTimeout(resolve, 500));

    } catch (segErr) {
      console.warn(`[VideoAnalysis] Re-tag failed for segment ${seg.id}: ${segErr.message}`);
    }
  }

  if (successCount > 0) {
    console.log(`[VideoAnalysis] Re-tagging complete: ${successCount}/${segments.length} segments updated`);
  }

  return successCount;
}

// setAnalysisStatusPublic is exported so the worker can mark a job as failed
// from the outside (e.g. when the hard 8-minute job timeout fires).
module.exports = { analyzeVideo, retagUntaggedSegments, setAnalysisStatusPublic: setAnalysisStatus };
