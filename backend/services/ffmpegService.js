/**
 * services/ffmpegService.js
 *
 * All FFmpeg video processing operations: probe, download, trim, and cleanup.
 *
 * This service is used ONLY by the publishingAgent (Phase 5) — it is never
 * called directly from a route handler. All processing is background-only.
 *
 * Workflow when publishing a video post:
 *   1. publishingAgent calls downloadToTemp(cloudUrl) to get a local copy.
 *   2. probeVideo(localPath) checks the actual duration.
 *   3. If duration exceeds the platform limit, trimVideo(localPath, platform) trims it.
 *   4. The trimmed file is uploaded to the platform API.
 *   5. cleanupTemp() removes both the original and trimmed temp files.
 *
 * Platform video duration limits (in seconds):
 *   TikTok:    15–60s  | Instagram Reels: 15–90s | YouTube Shorts: <60s
 *   Facebook:  180s    | LinkedIn:        600s    | X:              140s
 *   Threads:   300s
 */

const ffmpeg    = require('fluent-ffmpeg');
const path      = require('path');
const fs        = require('fs');
const https     = require('https');
const http      = require('http');
const { v4: uuidv4 } = require('uuid');

// Set the FFmpeg binary path from .env if provided (required in Docker)
if (process.env.FFMPEG_PATH) {
  ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
}

// ----------------------------------------------------------------
// Platform-specific maximum video durations in seconds.
// Videos longer than these limits will be trimmed before publishing.
// ----------------------------------------------------------------
const PLATFORM_LIMITS = {
  tiktok:    60,
  instagram: 90,
  youtube:   60,
  facebook:  180,
  linkedin:  600,
  x:         140,
  threads:   300
};

// Where temp files live — matches the Docker volume mount
const TEMP_DIR = process.env.FFMPEG_TEMP_DIR || '/tmp/social-buster/videos';

// ----------------------------------------------------------------
// ensureTempDir — create the temp directory if it doesn't exist.
// Called before every operation that writes a file.
// ----------------------------------------------------------------
function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

// ----------------------------------------------------------------
// downloadToTemp
// Downloads a file from a URL to a local temp path.
// Follows up to 3 redirects (Google Drive and Dropbox share links redirect).
// Returns the local file path.
// ----------------------------------------------------------------
async function downloadToTemp(url, extension = 'mp4', redirectCount = 0) {
  if (redirectCount > 3) {
    throw new Error('Too many redirects while downloading media file');
  }

  ensureTempDir();
  const filename = `download_${uuidv4()}.${extension}`;
  const filepath = path.join(TEMP_DIR, filename);

  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file     = fs.createWriteStream(filepath);

    const request = protocol.get(url, response => {
      // Follow redirects
      if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307) {
        file.close();
        fs.unlink(filepath, () => {}); // Clean up empty file
        const redirectUrl = response.headers.location;
        if (!redirectUrl) {
          return reject(new Error('Redirect response missing Location header'));
        }
        resolve(downloadToTemp(redirectUrl, extension, redirectCount + 1));
        return;
      }

      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(filepath, () => {});
        return reject(new Error(`Download failed with HTTP ${response.statusCode}`));
      }

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve(filepath);
      });

      file.on('error', err => {
        fs.unlink(filepath, () => {});
        reject(err);
      });
    });

    request.on('error', err => {
      fs.unlink(filepath, () => {});
      reject(new Error(`Download request failed: ${err.message}`));
    });

    // 5-minute timeout for large video downloads
    request.setTimeout(300000, () => {
      request.destroy();
      fs.unlink(filepath, () => {});
      reject(new Error('Download timed out after 5 minutes'));
    });
  });
}

// ----------------------------------------------------------------
// probeVideo
// Uses ffprobe to read video metadata without re-encoding.
// Returns: { duration, resolution, fps }
// ----------------------------------------------------------------
async function probeVideo(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        return reject(new Error(`Failed to probe video: ${err.message}`));
      }

      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      const duration    = Math.ceil(metadata.format?.duration || 0);
      const resolution  = videoStream
        ? `${videoStream.width}x${videoStream.height}`
        : null;
      const fps = videoStream?.r_frame_rate
        ? Math.round(eval(videoStream.r_frame_rate)) // e.g. "30000/1001" → 30
        : null;

      resolve({ duration, resolution, fps });
    });
  });
}

// ----------------------------------------------------------------
// trimVideo
// Trims a video to the maximum duration allowed for a given platform.
// If the video is already within the limit, it is copied without re-encoding
// (using stream copy — much faster, no quality loss).
//
// startTime (optional) — seconds offset where the trim begins.
//   0 = from the beginning (default).
//   30 = start the clip at the 30 second mark.
//   The output duration is always capped at the platform limit.
//
// Returns the path to the output file.
// ----------------------------------------------------------------
async function trimVideo(inputPath, platform, startTime = 0) {
  const maxDuration = PLATFORM_LIMITS[platform];
  if (!maxDuration) {
    throw new Error(`Unknown platform "${platform}". Check PLATFORM_LIMITS in ffmpegService.js`);
  }

  // Probe the input to see if trimming is actually needed
  const { duration } = await probeVideo(inputPath);

  // Effective duration = total video length minus the start offset
  const effectiveDuration = duration - startTime;

  if (startTime === 0 && effectiveDuration <= maxDuration) {
    // Already within limit and no offset — no trim needed, return input path as-is
    console.log(`[FFmpeg] Video is ${duration}s (limit: ${maxDuration}s) — no trim needed`);
    return inputPath;
  }

  // Cap the output duration at the platform limit
  const outputDuration = Math.min(effectiveDuration, maxDuration);

  ensureTempDir();
  const outputFilename = `trimmed_${uuidv4()}.mp4`;
  const outputPath     = path.join(TEMP_DIR, outputFilename);

  console.log(`[FFmpeg] Trimming video: start=${startTime}s duration=${outputDuration}s (platform limit: ${maxDuration}s) for ${platform}`);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startTime)
      .setDuration(outputDuration)
      // Use stream copy when possible (no re-encoding = much faster + no quality loss)
      // If the source is already H264/AAC this works; for other codecs it falls back
      .videoCodec('copy')
      .audioCodec('copy')
      .outputOptions([
        '-avoid_negative_ts make_zero',
        '-movflags +faststart' // Optimize MP4 for streaming
      ])
      .output(outputPath)
      .on('start', cmd => console.log(`[FFmpeg] Command: ${cmd}`))
      .on('end', () => {
        console.log(`[FFmpeg] Trim complete → ${outputFilename}`);
        resolve(outputPath);
      })
      .on('error', (err, stdout, stderr) => {
        console.error('[FFmpeg] Trim error:', err.message);
        // If stream copy failed (incompatible codec), retry with re-encode
        if (err.message.includes('Invalid data')) {
          console.log('[FFmpeg] Stream copy failed, retrying with re-encode...');
          trimWithReencode(inputPath, outputPath, startTime, outputDuration)
            .then(resolve)
            .catch(reject);
        } else {
          reject(new Error(`FFmpeg trim failed: ${err.message}`));
        }
      })
      .run();
  });
}

// ----------------------------------------------------------------
// trimWithReencode — fallback when stream copy fails.
// Re-encodes to H264/AAC which is universally compatible.
// Slower but guarantees output is valid.
// ----------------------------------------------------------------
async function trimWithReencode(inputPath, outputPath, startTime = 0, durationSeconds) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startTime)
      .setDuration(durationSeconds)
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions([
        '-preset fast',        // Balance quality/speed
        '-crf 23',             // Quality level (lower = better, 23 is fine for social)
        '-movflags +faststart'
      ])
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', err => reject(new Error(`FFmpeg re-encode failed: ${err.message}`)))
      .run();
  });
}

// ----------------------------------------------------------------
// cleanupTemp — safely deletes a temp file.
// Logs but does NOT throw if the file doesn't exist.
// Always call this after a file has been uploaded to the platform.
// ----------------------------------------------------------------
function cleanupTemp(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[FFmpeg] Cleaned up temp file: ${path.basename(filePath)}`);
    }
  } catch (err) {
    // Non-fatal — the file will be cleaned up by the Docker volume eventually
    console.error(`[FFmpeg] Failed to cleanup ${filePath}:`, err.message);
  }
}

// ----------------------------------------------------------------
// cleanupOldTempFiles — removes temp files older than maxAgeHours.
// Called by publishingAgent on startup to prevent temp dir from bloating.
// ----------------------------------------------------------------
function cleanupOldTempFiles(maxAgeHours = 24) {
  if (!fs.existsSync(TEMP_DIR)) return;

  const cutoff = Date.now() - maxAgeHours * 60 * 60 * 1000;
  let cleaned  = 0;

  fs.readdirSync(TEMP_DIR).forEach(filename => {
    const filepath = path.join(TEMP_DIR, filename);
    try {
      const stat = fs.statSync(filepath);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(filepath);
        cleaned++;
      }
    } catch {
      // Skip files we can't stat
    }
  });

  if (cleaned > 0) {
    console.log(`[FFmpeg] Cleaned up ${cleaned} old temp files from ${TEMP_DIR}`);
  }
}

module.exports = {
  PLATFORM_LIMITS,
  downloadToTemp,
  probeVideo,
  trimVideo,
  cleanupTemp,
  cleanupOldTempFiles
};
