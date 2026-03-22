/**
 * services/visionTaggingService.js
 *
 * Phase 2 — Vision LLM Tagging
 *
 * This service takes a thumbnail image URL from a video segment and sends it
 * to a vision-capable AI model. The AI looks at the image and tells us:
 *
 *   description — What's happening in 1-2 sentences
 *                 Example: "A child opens a present near a Christmas tree while
 *                           family members watch and clap."
 *
 *   tags        — List of everything visible / happening in the frame
 *                 Example: ["christmas tree", "child", "people clapping",
 *                           "holiday", "family", "gift wrapping", "indoor"]
 *
 *   mood        — Single word mood/tone of the clip
 *                 Example: "heartwarming"
 *
 * This is the data that makes the clip picker smart. When a user writes a post
 * brief that says "heartwarming holiday content", we can match it to the
 * right segments instantly — no AI call needed at that point, just a DB query.
 *
 * Adapter Pattern (No Vendor Lock-In):
 * ─────────────────────────────────────
 * Uses OpenAI-compatible API format, so it works with any provider that
 * supports image URLs in messages. To switch providers, change the env vars:
 *
 *   VISION_BASE_URL  — API endpoint  (default: same as LLM_BASE_URL / Groq)
 *   VISION_API_KEY   — Auth key      (default: same as LLM_API_KEY)
 *   VISION_MODEL     — Model name    (default: llama-3.2-11b-vision-preview)
 *
 * If VISION_MODEL is not set or the provider returns an error, this service
 * returns null gracefully — vision tagging is a nice-to-have, not a blocker.
 * The segment still gets saved with its FFmpeg energy/pacing data.
 */

const axios = require('axios');
const { loadPromptSections } = require('./promptLoader');
const { buildContext, formatForPrompt } = require('./contextBuilder');

// ----------------------------------------------------------------
// Config — all from .env, falls back to the main LLM settings
// ----------------------------------------------------------------
const VISION_BASE_URL = process.env.VISION_BASE_URL || process.env.LLM_BASE_URL;
const VISION_API_KEY  = process.env.VISION_API_KEY  || process.env.LLM_API_KEY;
const VISION_MODEL    = process.env.VISION_MODEL    || 'meta-llama/llama-4-scout-17b-16e-instruct';

// Moods the AI is allowed to pick from. Keeping it to a fixed list so the
// clip picker can filter by mood reliably (no typos or invented words).
const ALLOWED_MOODS = [
  'energetic', 'calm', 'happy', 'heartwarming', 'funny',
  'dramatic', 'inspirational', 'professional', 'nostalgic', 'exciting'
];

// Prompts are loaded from prompts/vision-tagging.md at startup.
// Edit that file to change what the AI looks for — no code changes needed.
// The file has two sections separated by "---": system prompt and user prompt.
// The user prompt contains {{context_shared}} which gets filled with cross-agent data.
const PROMPT_SECTIONS = loadPromptSections('vision-tagging');
const SYSTEM_PROMPT = PROMPT_SECTIONS.system;

// ----------------------------------------------------------------
// fetchImageAsBase64
//
// Downloads an image from a URL and returns a base64 data URL string.
// This is required for Groq's vision API — it does not accept external
// image URLs directly. We download the JPEG ourselves and send the raw
// pixel data inline in the request.
//
// Returns a string like: "data:image/jpeg;base64,/9j/4AAQ..."
// ----------------------------------------------------------------
async function fetchImageAsBase64(imageUrl) {
  const response = await axios.get(imageUrl, {
    responseType: 'arraybuffer',  // Get raw bytes, not text
    timeout: 15000
  });
  const buffer = Buffer.from(response.data);
  const base64 = buffer.toString('base64');
  return `data:image/jpeg;base64,${base64}`;
}

// ----------------------------------------------------------------
// tagSegmentWithVision
//
// Main function. Download the thumbnail, convert to base64, send to
// the vision AI, and get back enriched tag data.
// Returns null if vision is not available or if tagging fails.
//
// thumbnailUrl: Public URL of the segment thumbnail (Supabase Storage)
// userId:       Optional. If provided, cross-agent context (research,
//               performance, cohort data) is injected into the prompt
//               so the AI tags content with awareness of what performs
//               well for this user and their niche.
//
// Returns: { description, tags, mood, hook_potential, energy_level,
//            audience_fit, use_cases, text_overlay_opportunity } or null
// ----------------------------------------------------------------
async function tagSegmentWithVision(thumbnailUrl, userId = null) {
  // If the thumbnail wasn't uploaded, we have nothing to send
  if (!thumbnailUrl) {
    return null;
  }

  // If no vision API is configured, skip silently
  if (!VISION_BASE_URL || !VISION_API_KEY) {
    return null;
  }

  try {
    // Groq (and some other providers) require the image as base64, not a URL.
    // We download the thumbnail first, then send the raw bytes inline.
    const base64Image = await fetchImageAsBase64(thumbnailUrl);

    // Build user prompt with cross-agent context if userId is available.
    // This lets the vision tagger know what's trending, what performs well,
    // and what the user's audience cares about — making tags more relevant.
    let userPrompt = PROMPT_SECTIONS.user;
    if (userId) {
      try {
        const ctx = await buildContext(userId, {
          sections: ['research', 'performance', 'cohort']
        });
        const sharedContext = formatForPrompt(ctx, ['research', 'performance', 'cohort']);
        userPrompt = userPrompt.replace('{{context_shared}}', sharedContext);
      } catch (_) {
        userPrompt = userPrompt.replace('{{context_shared}}', '');
      }
    } else {
      userPrompt = userPrompt.replace('{{context_shared}}', '');
    }

    const response = await axios.post(
      `${VISION_BASE_URL}/chat/completions`,
      {
        model: VISION_MODEL,
        messages: [
          {
            role: 'system',
            content: SYSTEM_PROMPT
          },
          {
            role: 'user',
            // OpenAI-compatible multimodal format using base64 inline data
            content: [
              {
                type: 'image_url',
                image_url: { url: base64Image }  // base64 data URL works with Groq
              },
              {
                type: 'text',
                text: userPrompt
              }
            ]
          }
        ],
        // Keep the response focused and short — we only need a small JSON object
        max_tokens: 500,
        temperature: 0.2   // Low temperature = more consistent, factual responses
      },
      {
        headers: {
          'Authorization': `Bearer ${VISION_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000  // 30 seconds — vision models can be slower than text-only
      }
    );

    // Extract the raw text the AI returned
    const rawText = response.data?.choices?.[0]?.message?.content || '';

    // Parse the JSON from the response
    const result = parseVisionResponse(rawText);

    if (result) {
      console.log(`[VisionTagging] Tagged segment: mood="${result.mood}" tags=[${result.tags.slice(0, 3).join(', ')}...]`);
    }

    return result;

  } catch (err) {
    // Log the full API error body so we can diagnose model/format issues
    const apiError = err.response?.data?.error?.message || err.response?.data || err.message;
    console.warn(`[VisionTagging] Tagging failed for ${thumbnailUrl}: ${JSON.stringify(apiError)}`);
    return null;
  }
}

// ----------------------------------------------------------------
// parseVisionResponse
//
// Parses the AI's text response into our expected shape.
// The AI SHOULD return pure JSON, but sometimes adds markdown
// code fences (```json ... ```) or extra whitespace. We handle that.
//
// Returns { description, tags, mood } or null if parsing fails.
// ----------------------------------------------------------------
function parseVisionResponse(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  try {
    // Strip markdown code fences if present (e.g. ```json ... ```)
    let cleaned = rawText.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    const parsed = JSON.parse(cleaned);

    // Validate core fields (always required)
    const description = typeof parsed.description === 'string' ? parsed.description.trim() : null;
    const mood        = validateMood(parsed.mood);
    const tags        = validateTags(parsed.tags);

    if (!description && !mood && tags.length === 0) {
      console.warn('[VisionTagging] AI returned JSON but all fields were empty or invalid');
      return null;
    }

    // Enriched fields (optional — older prompts may not return these)
    const hook_potential            = ['high', 'medium', 'low'].includes(parsed.hook_potential) ? parsed.hook_potential : null;
    const energy_level              = typeof parsed.energy_level === 'number' && parsed.energy_level >= 1 && parsed.energy_level <= 10 ? parsed.energy_level : null;
    const audience_fit              = validateAudienceFit(parsed.audience_fit);
    const use_cases                 = validateUseCases(parsed.use_cases);
    const text_overlay_opportunity  = typeof parsed.text_overlay_opportunity === 'boolean' ? parsed.text_overlay_opportunity : null;

    return {
      description, tags, mood,
      hook_potential, energy_level, audience_fit, use_cases, text_overlay_opportunity
    };

  } catch (parseErr) {
    // The AI returned something that isn't valid JSON — this happens occasionally
    console.warn(`[VisionTagging] Could not parse AI response as JSON: "${rawText.slice(0, 100)}..."`);
    return null;
  }
}

// ----------------------------------------------------------------
// validateMood
//
// Ensures the mood value is one of our allowed words.
// If the AI invents its own word, we try to find the closest match
// (e.g. "joyful" → "happy"). Falls back to null if nothing fits.
// ----------------------------------------------------------------
function validateMood(rawMood) {
  if (!rawMood || typeof rawMood !== 'string') return null;

  const normalized = rawMood.toLowerCase().trim();

  // Exact match
  if (ALLOWED_MOODS.includes(normalized)) return normalized;

  // Common synonyms → canonical mood
  const synonymMap = {
    'joyful':     'happy',
    'excited':    'energetic',
    'enthusiastic': 'energetic',
    'uplifting':  'inspirational',
    'motivated':  'inspirational',
    'warm':       'heartwarming',
    'touching':   'heartwarming',
    'humorous':   'funny',
    'comedic':    'funny',
    'tense':      'dramatic',
    'intense':    'dramatic',
    'serious':    'professional',
    'formal':     'professional',
    'peaceful':   'calm',
    'relaxing':   'calm',
    'thrilling':  'exciting',
    'sentimental': 'nostalgic',
    'retro':      'nostalgic'
  };

  return synonymMap[normalized] || null;
}

// ----------------------------------------------------------------
// validateTags
//
// Ensures tags is a clean array of lowercase strings with synonym
// normalization. Common variants get collapsed to canonical forms
// so clip matching works consistently.
//
// Edit TAG_SYNONYMS to refine what the AI returns over time.
// This is the tuning knob for tag quality.
// ----------------------------------------------------------------
const TAG_SYNONYMS = {
  // Locations
  'gymnasium':    'gym',
  'outdoors':     'outdoor',
  'indoors':      'indoor',
  'outside':      'outdoor',
  'inside':       'indoor',
  'home office':  'office',
  'workspace':    'office',
  'eatery':       'restaurant',
  'cafe':         'restaurant',
  'coffee shop':  'restaurant',

  // People
  'woman':        'adult',
  'man':          'adult',
  'kid':          'child',
  'kids':         'child',
  'children':     'child',
  'toddler':      'child',
  'teen':         'teenager',
  'teens':        'teenager',
  'group':        'crowd',
  'audience':     'crowd',
  'speaker':      'presenter',

  // Actions
  'working out':  'exercising',
  'exercise':     'exercising',
  'workout':      'exercising',
  'running':      'exercising',
  'lifting':      'exercising',
  'eating':       'food',
  'dining':       'food',
  'chatting':     'talking',
  'speaking':     'talking',
  'discussing':   'talking',
  'laughing':     'people laughing',
  'smiling':      'happy',
  'crying':       'emotional',

  // Themes
  'xmas':         'christmas',
  'x-mas':        'christmas',
  'bday':         'birthday',
  'new year':     'new years',
  'new years eve': 'new years',
  'back to school': 'back-to-school',
  'diy':          'DIY',
  'do it yourself': 'DIY',
  'health':       'wellness',
  'healthy':      'wellness',
  'selfcare':     'self-care',
  'self care':    'self-care',

  // Visual styles
  'closeup':      'close-up',
  'close up':     'close-up',
  'wideshot':     'wide shot',
  'wide-shot':    'wide shot',
  'slo-mo':       'slow motion',
  'slowmo':       'slow motion',
  'timelapse':    'time-lapse',
  'time lapse':   'time-lapse'
};

function validateTags(rawTags) {
  if (!Array.isArray(rawTags)) return [];

  const normalized = rawTags
    .filter(t => typeof t === 'string' && t.trim().length > 0 && t.length <= 50)
    .map(t => {
      const lower = t.toLowerCase().trim();
      return TAG_SYNONYMS[lower] || lower;
    });

  // Deduplicate after normalization (synonyms may collapse to the same tag)
  const unique = [...new Set(normalized)];

  return unique.slice(0, 30);  // Cap at 30 tags — anything more is probably noise
}

// ----------------------------------------------------------------
// validateAudienceFit
//
// Restricts audience_fit to a known set of audience types.
// If the AI invents a category, map it to the closest match or drop it.
// ----------------------------------------------------------------
const ALLOWED_AUDIENCES = [
  'entrepreneurs', 'parents', 'fitness enthusiasts', 'foodies', 'students',
  'professionals', 'teens', 'creators', 'pet owners', 'travelers',
  'beauty/fashion', 'tech enthusiasts', 'small business owners', 'health/wellness'
];

const AUDIENCE_SYNONYMS = {
  'business owners':    'small business owners',
  'startup founders':   'entrepreneurs',
  'moms':               'parents',
  'dads':               'parents',
  'families':           'parents',
  'gym goers':          'fitness enthusiasts',
  'athletes':           'fitness enthusiasts',
  'runners':            'fitness enthusiasts',
  'content creators':   'creators',
  'influencers':        'creators',
  'bloggers':           'creators',
  'developers':         'tech enthusiasts',
  'programmers':        'tech enthusiasts',
  'gamers':             'tech enthusiasts',
  'college students':   'students',
  'high school':        'teens',
  'teenagers':          'teens',
  'gen z':              'teens',
  'millennials':        'professionals',
  'dog owners':         'pet owners',
  'cat owners':         'pet owners',
  'fashion':            'beauty/fashion',
  'beauty':             'beauty/fashion',
  'makeup':             'beauty/fashion',
  'wellness':           'health/wellness',
  'self-care':          'health/wellness',
  'cooking':            'foodies',
  'food lovers':        'foodies',
  'adventure':          'travelers',
  'backpackers':        'travelers'
};

function validateAudienceFit(rawAudience) {
  if (!Array.isArray(rawAudience)) return [];

  const validated = rawAudience
    .filter(a => typeof a === 'string')
    .map(a => {
      const lower = a.toLowerCase().trim();
      if (ALLOWED_AUDIENCES.includes(lower)) return lower;
      return AUDIENCE_SYNONYMS[lower] || null;
    })
    .filter(Boolean);

  return [...new Set(validated)].slice(0, 5);
}

// ----------------------------------------------------------------
// validateUseCases
//
// Restricts use_cases to a known set of post types.
// ----------------------------------------------------------------
const ALLOWED_USE_CASES = [
  'product demo', 'testimonial', 'behind-the-scenes', 'educational',
  'entertainment', 'emotional storytelling', 'trend participation',
  'before/after', 'tutorial', 'announcement', 'brand awareness',
  'community building'
];

const USE_CASE_SYNONYMS = {
  'how-to':               'tutorial',
  'how to':               'tutorial',
  'teaching':             'educational',
  'informational':        'educational',
  'explainer':            'educational',
  'demo':                 'product demo',
  'demonstration':        'product demo',
  'review':               'testimonial',
  'customer story':       'testimonial',
  'bts':                  'behind-the-scenes',
  'behind the scenes':    'behind-the-scenes',
  'funny':                'entertainment',
  'comedy':               'entertainment',
  'meme':                 'entertainment',
  'transformation':       'before/after',
  'makeover':             'before/after',
  'launch':               'announcement',
  'reveal':               'announcement',
  'unboxing':             'announcement',
  'story':                'emotional storytelling',
  'personal story':       'emotional storytelling',
  'storytime':            'emotional storytelling',
  'trending':             'trend participation',
  'challenge':            'trend participation',
  'viral':                'trend participation',
  'engagement':           'community building',
  'q&a':                  'community building',
  'poll':                 'community building'
};

function validateUseCases(rawCases) {
  if (!Array.isArray(rawCases)) return [];

  const validated = rawCases
    .filter(u => typeof u === 'string')
    .map(u => {
      const lower = u.toLowerCase().trim();
      if (ALLOWED_USE_CASES.includes(lower)) return lower;
      return USE_CASE_SYNONYMS[lower] || null;
    })
    .filter(Boolean);

  return [...new Set(validated)].slice(0, 4);
}

module.exports = { tagSegmentWithVision };
