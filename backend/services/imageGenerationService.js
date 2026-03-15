/**
 * services/imageGenerationService.js
 *
 * AI image generation via Cloudflare Workers AI (Flux Schnell model).
 *
 * Why Cloudflare Workers AI?
 *   - Free tier: 10,000 neurons/day (~47 images/day at 4 steps) — zero cost in development
 *   - Production: ~$0.0023/image — cheaper than fal.ai at scale
 *   - No SDK needed — plain REST call from our existing backend
 *   - Returns image bytes directly — no temp URL to download, simpler pipeline
 *
 * Setup (one time):
 *   1. Sign up free at cloudflare.com
 *   2. Get your Account ID from the dashboard homepage (right sidebar, 32-char hex)
 *   3. Create an API token at dash.cloudflare.com/profile/api-tokens
 *      → "Create Custom Token" → Permission: Account / Workers AI / Read
 *   4. Add to .env:
 *        CLOUDFLARE_ACCOUNT_ID=your_account_id
 *        CLOUDFLARE_API_TOKEN=your_api_token
 *
 * Workflow:
 *   1. POST to Cloudflare Workers AI → receive raw PNG bytes directly in the response
 *   2. Upload bytes to Supabase Storage bucket 'ai-generated-images'
 *   3. Return the permanent public URL + storage path
 *
 * Key difference from fal.ai: Cloudflare returns the image bytes directly in the
 * HTTP response body (not a temp URL). This means we skip the download step entirely.
 */

const axios = require('axios');

// ----------------------------------------------------------------
// SIZE_MAP
// Maps the frontend size names to pixel dimensions.
// Cloudflare Workers AI Flux Schnell accepts width and height.
// Dimensions must be multiples of 8. We keep them close to
// standard social media formats while staying at power-of-2 sizes
// for best quality from the diffusion model.
// ----------------------------------------------------------------
const SIZE_MAP = {
  square_hd:      { width: 1024, height: 1024 }, // Instagram feed, LinkedIn — all platforms
  square:         { width: 1024, height: 1024 }, // Same as square_hd on this provider
  landscape_4_3:  { width: 1024, height: 768  }, // Facebook, LinkedIn banner
  landscape_16_9: { width: 1024, height: 576  }, // YouTube thumbnail, Twitter/X header
  portrait_4_3:   { width: 768,  height: 1024 }, // Instagram portrait
  portrait_16_9:  { width: 576,  height: 1024 }, // TikTok, Instagram Reels, YouTube Shorts
};

// ----------------------------------------------------------------
// generateImage
// Calls Cloudflare Workers AI Flux Schnell.
// Returns the raw image bytes as a Buffer plus dimensions.
//
// prompt     — Text description of the image to generate
// imageSize  — Key from SIZE_MAP (default: 'square_hd')
//
// Returns: { buffer, contentType, width, height }
// ----------------------------------------------------------------
async function generateImage(prompt, imageSize = 'square_hd') {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken  = process.env.CLOUDFLARE_API_TOKEN;

  if (!accountId || !apiToken) {
    throw new Error(
      'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set in .env. ' +
      'Get your Account ID from the Cloudflare dashboard homepage (right sidebar). ' +
      'Create an API token at dash.cloudflare.com/profile/api-tokens with ' +
      'Account → Workers AI → Read permission.'
    );
  }

  const { width, height } = SIZE_MAP[imageSize] || SIZE_MAP.square_hd;

  let response;
  try {
    response = await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/black-forest-labs/flux-1-schnell`,
      { prompt, num_steps: 4, width, height },
      {
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type':  'application/json'
        },
        // No responseType override — axios parses JSON by default.
        // Cloudflare flux-1-schnell always returns a JSON envelope:
        //   { "result": { "image": "<base64-encoded-jpeg>" }, "success": true }
        timeout: 90000
      }
    );
  } catch (axiosErr) {
    const status = axiosErr.response?.status;
    let detail = axiosErr.message;
    try {
      const errData = axiosErr.response?.data;
      detail = errData?.errors?.[0]?.message || errData?.message || detail;
    } catch (_) {}

    // Strip Cloudflare's "AiError: " prefix which can appear double ("AiError: AiError: ...")
    detail = detail.replace(/^(AiError:\s*)+/i, '');

    if (status === 401 || status === 403) {
      throw new Error(
        'CLOUDFLARE_API_TOKEN is invalid or does not have Workers AI permission. ' +
        'Go to dash.cloudflare.com/profile/api-tokens and verify the token has ' +
        'Account → Workers AI → Read access.'
      );
    }
    if (status === 429) throw new Error('Cloudflare Workers AI rate limit reached. Please try again in a moment.');
    if (status >= 500) throw new Error(`Cloudflare Workers AI service error (HTTP ${status}). Try again in a few minutes.`);

    // NSFW — surface as a clear user-facing message, not a raw model error
    if (/nsfw/i.test(detail)) {
      throw new Error('NSFW_PROMPT');
    }

    throw new Error(detail);
  }

  // Cloudflare returns: { "result": { "image": "<base64-jpeg>" }, "success": true }
  const base64 = response.data?.result?.image;
  if (!base64) {
    throw new Error('Cloudflare returned no image data. Response: ' + JSON.stringify(response.data));
  }

  const imageBuffer = Buffer.from(base64, 'base64');

  if (imageBuffer.length === 0) {
    throw new Error('Image generation returned empty data. Please try again.');
  }

  // Detect actual image format from magic bytes.
  // flux-1-schnell returns JPEG (0xFF 0xD8 0xFF), not PNG.
  const isJpeg = imageBuffer[0] === 0xFF && imageBuffer[1] === 0xD8 && imageBuffer[2] === 0xFF;
  const contentType = isJpeg ? 'image/jpeg' : 'image/png';

  console.log(`[ImageGen] Generated ${width}x${height} ${contentType} (${imageBuffer.length} bytes)`);

  return {
    buffer:      imageBuffer,
    contentType,
    width,
    height
  };
}

// ----------------------------------------------------------------
// uploadToStorage
// Uploads raw image bytes directly to Supabase Storage.
//
// Unlike the previous fal.ai version, there is no temp URL to
// download — Cloudflare gave us the bytes directly, so we go
// straight to the upload step.
//
// Returns: { publicUrl, storagePath }
// ----------------------------------------------------------------
async function uploadToStorage(imageBuffer, contentType, userId) {
  const timestamp   = Date.now();
  const extension   = contentType.includes('png') ? 'png' : 'jpg';
  const storagePath = `${userId}/${timestamp}.${extension}`;

  // Upload directly via Supabase Storage REST API with the service role key.
  // The service role key bypasses RLS so the upload always succeeds regardless
  // of which user is making the request.
  const storageUrl = `${process.env.SUPABASE_URL}/storage/v1/object/ai-generated-images/${storagePath}`;

  const uploadResponse = await axios.post(storageUrl, imageBuffer, {
    headers: {
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type':  contentType,
      'x-upsert':      'false'
    },
    timeout: 30000,
    maxContentLength: Infinity,
    maxBodyLength:    Infinity
  });

  if (uploadResponse.status !== 200) {
    throw new Error(`Failed to store generated image: HTTP ${uploadResponse.status}`);
  }

  const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/ai-generated-images/${storagePath}`;
  return { publicUrl, storagePath };
}

// ----------------------------------------------------------------
// generateAndStore
// Main entry point called by POST /media/generate-image.
//
// Returns: { publicUrl, storagePath, width, height }
// ----------------------------------------------------------------
async function generateAndStore(prompt, userId, imageSize = 'square_hd') {
  // Step 1: Generate via Cloudflare Workers AI — returns raw image bytes directly
  const { buffer, contentType, width, height } = await generateImage(prompt, imageSize);

  // Step 2: Upload bytes to Supabase Storage (no download step needed)
  const { publicUrl, storagePath } = await uploadToStorage(buffer, contentType, userId);

  // The frontend displays the image via /media/proxy?url=<publicUrl> so it routes
  // through localhost — bypasses ad blockers without embedding a 1MB base64 blob.
  return { publicUrl, storagePath, width, height };
}

module.exports = { generateAndStore };
