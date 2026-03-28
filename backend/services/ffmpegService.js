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
// Platform specs — single source of truth for all platform limits.
// Loaded from frontend/public/data/platformSpecs.json so both
// backend and frontend read from the same file.
// ----------------------------------------------------------------
const PLATFORM_SPECS = require('../../frontend/public/data/platformSpecs.json');

// Derive video duration limits from specs (backwards-compatible object shape)
const PLATFORM_LIMITS = Object.fromEntries(
  Object.entries(PLATFORM_SPECS)
    .filter(([, s]) => s.video?.maxDuration)
    .map(([p, s]) => [p, s.video.maxDuration])
);

// Derive image file size limits from specs (backwards-compatible object shape)
const PLATFORM_IMAGE_LIMITS = Object.fromEntries(
  Object.entries(PLATFORM_SPECS)
    .filter(([, s]) => s.image?.maxBytes)
    .map(([p, s]) => [p, s.image.maxBytes])
);

// Max pixel length of the longest side after downsampling.
// 2048px preserves high quality while keeping most photos well under 4 MB.
const IMAGE_MAX_DIMENSION_PX = 2048;

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
// forceReencode — when true, always re-encode to H.264/AAC regardless of the
// source codec. Pass true when publishing to social media platforms, since they
// require H.264 video + AAC audio. Source videos from phones are often H.265/HEVC
// which all major platforms reject with a codec error even if the container is MP4.
async function trimVideo(inputPath, platform, startTime = 0, forceReencode = false) {
  const maxDuration = PLATFORM_LIMITS[platform];
  if (!maxDuration) {
    throw new Error(`Unknown platform "${platform}". Check PLATFORM_LIMITS in ffmpegService.js`);
  }

  // Probe the input to see if trimming is actually needed
  const { duration } = await probeVideo(inputPath);

  // Effective duration = total video length minus the start offset
  const effectiveDuration = duration - startTime;

  // Cap the output duration at the platform limit
  const outputDuration = Math.min(effectiveDuration, maxDuration);

  ensureTempDir();
  const outputFilename = `trimmed_${uuidv4()}.mp4`;
  const outputPath     = path.join(TEMP_DIR, outputFilename);

  // When forceReencode is set (social media publishing), skip stream copy entirely
  // and go straight to re-encode. Guarantees H.264/AAC output that every platform accepts.
  // Also handles the case where no trim is needed but re-encoding is still required
  // (e.g. a short H.265 video that's within duration but has the wrong codec).
  if (forceReencode) {
    console.log(`[FFmpeg] Re-encoding to H.264/AAC: start=${startTime}s duration=${outputDuration}s for ${platform}`);
    return trimWithReencode(inputPath, outputPath, startTime, outputDuration);
  }

  if (startTime === 0 && effectiveDuration <= maxDuration) {
    // Already within limit, no offset, no re-encode needed — return input as-is
    console.log(`[FFmpeg] Video is ${duration}s (limit: ${maxDuration}s) — no trim needed`);
    return inputPath;
  }

  console.log(`[FFmpeg] Trimming video: start=${startTime}s duration=${outputDuration}s (platform limit: ${maxDuration}s) for ${platform}`);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(startTime)
      .setDuration(outputDuration)
      .videoCodec('copy')
      .audioCodec('copy')
      .outputOptions([
        '-avoid_negative_ts make_zero',
        '-movflags +faststart'
      ])
      .output(outputPath)
      .on('start', cmd => console.log(`[FFmpeg] Command: ${cmd}`))
      .on('end', () => {
        console.log(`[FFmpeg] Trim complete → ${outputFilename}`);
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error('[FFmpeg] Trim error:', err.message);
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
      // scale filter: trunc(iw/2)*2 forces even pixel dimensions required by H.264.
      // Odd-sized videos (e.g. from some Android phones) are rejected with error 351
      // by Facebook and other platforms if dimensions aren't divisible by 2.
      .videoFilters('scale=trunc(iw/2)*2:trunc(ih/2)*2')
      .outputOptions([
        '-preset ultrafast',   // Fastest encode — quality difference imperceptible for social media
        '-crf 23',             // Quality level (lower = better, 23 is fine for social)
        '-pix_fmt yuv420p',    // Force YUV 4:2:0 — required by Facebook, Instagram, TikTok
        '-movflags +faststart' // Optimise for streaming: move moov atom to front of file
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

// ----------------------------------------------------------------
// resizeImageIfNeeded
//
// Checks whether an image file exceeds the platform's size limit.
// If it does, uses FFmpeg to scale down the longest side to
// IMAGE_MAX_DIMENSION_PX (preserving aspect ratio, no re-encoding
// of colour data — just a resolution reduction).
//
// Returns the path to the (possibly new) file.
// If the image is already within the limit, the original path is
// returned unchanged — no temp file is created.
//
// The caller is responsible for adding the returned path to
// tempFilePaths so it gets cleaned up after publishing.
// ----------------------------------------------------------------
// ----------------------------------------------------------------
// cropImageToAspectRange
// Checks the image's aspect ratio against the platform's allowed range
// (from platformSpecs.json). If outside the range, center-crops to the
// nearest valid ratio using FFmpeg's crop filter.
//
// Returns the path to the cropped file, or the original path if no
// crop was needed.
// ----------------------------------------------------------------
async function cropImageToAspectRange(inputPath, platform) {
  const spec = PLATFORM_SPECS[platform];
  if (!spec?.image?.minAspect || !spec?.image?.maxAspect) return inputPath;

  const { minAspect, maxAspect } = spec.image;

  // Probe image dimensions using ffprobe
  const { width, height } = await new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(new Error(`Failed to probe image: ${err.message}`));
      const stream = metadata.streams.find(s => s.codec_type === 'video');
      if (!stream) return reject(new Error('No image stream found'));
      resolve({ width: stream.width, height: stream.height });
    });
  });

  const ratio = width / height;

  // Already within the allowed range — no crop needed
  if (ratio >= minAspect && ratio <= maxAspect) {
    console.log(`[FFmpeg] Image ${width}x${height} (ratio ${ratio.toFixed(2)}) is within ${platform} range [${minAspect}–${maxAspect}] — no crop needed`);
    return inputPath;
  }

  ensureTempDir();

  let cropW, cropH;
  if (ratio < minAspect) {
    // Too tall — crop height to fit minAspect (keep full width)
    cropW = width;
    cropH = Math.floor(width / minAspect);
  } else {
    // Too wide — crop width to fit maxAspect (keep full height)
    cropW = Math.floor(height * maxAspect);
    cropH = height;
  }

  const ext = path.extname(inputPath).replace('.', '') || 'jpg';
  const outputPath = path.join(TEMP_DIR, `cropped_${uuidv4()}.${ext}`);

  console.log(
    `[FFmpeg] Image ${width}x${height} (ratio ${ratio.toFixed(2)}) outside ${platform} ` +
    `range [${minAspect}–${maxAspect}] — center-cropping to ${cropW}x${cropH}...`
  );

  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      // Center-crop: crop=w:h:x:y — x/y center the crop area
      .videoFilters(`crop=${cropW}:${cropH}`)
      .outputOptions([
        '-q:v', '2',
        '-frames:v', '1'
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', (err) => reject(new Error(`Image crop failed: ${err.message}`)))
      .run();
  });

  console.log(`[FFmpeg] Image cropped: ${width}x${height} → ${cropW}x${cropH}`);
  return outputPath;
}

// ----------------------------------------------------------------
// processImageForPlatform
// Full image processing pipeline: aspect ratio crop → file size check.
// Replaces the old resizeImageIfNeeded as the main entry point.
// ----------------------------------------------------------------
async function processImageForPlatform(inputPath, platform) {
  // Step 1: Crop to valid aspect ratio if needed
  const croppedPath = await cropImageToAspectRange(inputPath, platform);

  // Step 2: Resize if file is too large
  return await resizeImageIfNeeded(croppedPath, platform);
}

async function resizeImageIfNeeded(inputPath, platform) {
  const limitBytes = PLATFORM_IMAGE_LIMITS[platform];

  // Unknown platform or no limit defined — leave the file alone
  if (!limitBytes || limitBytes === Infinity) return inputPath;

  const fileSizeBytes = fs.statSync(inputPath).size;
  if (fileSizeBytes <= limitBytes) return inputPath; // already within limit

  ensureTempDir();

  // Preserve the original extension so the output format matches the input
  const ext        = path.extname(inputPath).replace('.', '') || 'jpg';
  const outputPath = path.join(TEMP_DIR, `resized_${uuidv4()}.${ext}`);

  console.log(
    `[FFmpeg] Image ${Math.round(fileSizeBytes / 1024)}KB exceeds ` +
    `${platform} limit (${Math.round(limitBytes / 1024)}KB) — ` +
    `downsampling to max ${IMAGE_MAX_DIMENSION_PX}px on longest side...`
  );

  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      // Scale the longest side down to IMAGE_MAX_DIMENSION_PX.
      // force_original_aspect_ratio=decrease: only shrinks, never enlarges.
      // flags=lanczos: high-quality downsampling kernel (no blurry bicubic).
      .videoFilters(
        `scale=${IMAGE_MAX_DIMENSION_PX}:${IMAGE_MAX_DIMENSION_PX}` +
        `:force_original_aspect_ratio=decrease:flags=lanczos`
      )
      .outputOptions([
        '-q:v', '2',      // High-quality JPEG (scale 1–31, 2 = near-lossless)
        '-frames:v', '1'  // Single image output — tell FFmpeg to stop after 1 frame
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', (err) => reject(new Error(`Image resize failed: ${err.message}`)))
      .run();
  });

  const newSizeBytes = fs.statSync(outputPath).size;
  console.log(
    `[FFmpeg] Image resized: ${Math.round(fileSizeBytes / 1024)}KB → ` +
    `${Math.round(newSizeBytes / 1024)}KB`
  );

  return outputPath;
}

module.exports = {
  PLATFORM_LIMITS,
  PLATFORM_IMAGE_LIMITS,
  downloadToTemp,
  probeVideo,
  trimVideo,
  resizeImageIfNeeded,
  cropImageToAspectRange,
  processImageForPlatform,
  cleanupTemp,
  cleanupOldTempFiles
};
