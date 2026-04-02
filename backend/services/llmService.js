/**
 * services/llmService.js
 *
 * Calls any OpenAI-compatible LLM endpoint to generate social media posts.
 * Works with Groq, OpenAI, local vLLM, or any compatible provider —
 * just set LLM_BASE_URL, LLM_MODEL, and LLM_API_KEY in .env.
 *
 * Recommended for production: Groq (https://console.groq.com)
 *   - 1,000+ tokens/second → post generation in ~10 seconds
 *   - 14,400 free requests/day (enough for thousands of daily users)
 *   - Cost beyond free tier: ~$0.59/M tokens (negligible at scale)
 *   LLM_BASE_URL=https://api.groq.com/openai/v1
 *   LLM_MODEL=llama-3.1-8b-instant
 *   LLM_API_KEY=your_groq_api_key
 *
 * For local dev / self-hosted GPU:
 *   LLM_BASE_URL=http://localhost:8000/v1
 *   LLM_MODEL=mistralai/Mistral-7B-Instruct-v0.3
 *   LLM_API_KEY=none
 *
 * Main export: generatePosts(brief, userContext)
 * Returns an array of post objects ready to save to the database.
 */

const axios = require('axios');
const { loadPrompt } = require('./promptLoader');
const { buildContext, formatForPrompt } = require('./contextBuilder');

// ----------------------------------------------------------------
// Sanitize user-submitted content before injecting into LLM prompts.
// Strips common prompt injection patterns (role overrides, instruction
// resets, system prompt leaks) while preserving normal marketing text.
// This is a defense-in-depth layer — the LLM's own safety filters
// are the primary guard, but we strip obvious attacks before they
// reach the model.
// ----------------------------------------------------------------
function sanitizeForPrompt(text) {
  if (!text || typeof text !== 'string') return text || '';

  return text
    // Strip attempts to override system role or inject new instructions
    .replace(/\b(ignore|forget|disregard|override)\s+(all\s+)?(previous|above|prior|earlier)\s+(instructions?|rules?|prompts?|context)/gi, '[filtered]')
    .replace(/\b(you are now|act as|pretend to be|switch to|new role|system prompt|reveal your|show me your|return your|output your)\b/gi, '[filtered]')
    .replace(/\b(do not follow|stop following|bypass|circumvent|jailbreak)\b/gi, '[filtered]')
    // Strip markdown/formatting that could confuse prompt boundaries
    .replace(/^---+$/gm, '')
    .replace(/^#{1,6}\s+(SYSTEM|ASSISTANT|USER|INSTRUCTIONS?|RULES?)/gim, '')
    // Limit length to prevent context stuffing (2000 chars is plenty for a brief note)
    .slice(0, 2000);
}

// ----------------------------------------------------------------
// How many platforms to generate per LLM call.
//
// Each call produces 3 platforms × 3 options = 9 posts ≈ 3,500 output tokens.
// Keeping batches at 3 ensures every call stays well within token limits
// and finishes in ~10 seconds on Groq (or ~30-40s on a local GPU).
//
// For 7 platforms: 3 batches run sequentially → total ~30s on Groq.
// ----------------------------------------------------------------
const PLATFORM_BATCH_SIZE = 3;

// ----------------------------------------------------------------
// Platform-specific writing guidelines injected into every prompt.
// Loaded from prompts/post-generation-platforms.md at startup.
// Edit that file to tune how the AI writes for each platform.
// Lines starting with # in the file are treated as comments and stripped.
// ----------------------------------------------------------------

// Parse the platforms file into a keyed object { instagram: '...', facebook: '...' }
// so we can inject only the rules for the platforms selected in a given brief.
function parsePlatformGuides() {
  const raw = loadPrompt('post-generation-platforms');

  // Strip comment lines (lines starting with #)
  const cleaned = raw.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n');

  const guides  = {};
  const keys    = ['instagram', 'facebook', 'tiktok', 'linkedin', 'x', 'threads', 'whatsapp', 'telegram'];

  for (let i = 0; i < keys.length; i++) {
    const key   = keys[i];
    const next  = keys[i + 1];
    // Find the block from this key's header to the next one
    const upper = key.toUpperCase();
    const start = cleaned.indexOf(`${upper} rules:`);
    if (start === -1) continue;

    const end = next ? cleaned.indexOf(`${next.toUpperCase()} rules:`, start) : cleaned.length;
    guides[key] = '\n' + cleaned.slice(start, end === -1 ? cleaned.length : end).trim();
  }

  return guides;
}

const PLATFORM_GUIDES = parsePlatformGuides();

// ----------------------------------------------------------------
// Build the system prompt — loaded from prompts/post-generation.md.
// Edit that file to change the AI's role, rules, or output format.
// ----------------------------------------------------------------
function buildSystemPrompt() {
  return loadPrompt('post-generation');
}

// ----------------------------------------------------------------
// Build the user message — the actual brief + brand context.
// ----------------------------------------------------------------
function buildUserPrompt(brief, userContext) {
  const platformList = brief.platforms.join(', ');
  const totalPosts = brief.platforms.length * 3;

  // Include platform guides only for the selected platforms
  const relevantGuides = brief.platforms
    .filter(p => PLATFORM_GUIDES[p])
    .map(p => PLATFORM_GUIDES[p])
    .join('\n');

  // Writing style guidance derived from the semantic profiles of the brief selections.
  // Each post type, objective, and tone has a specific writing note that shapes
  // the LLM's output — better than just passing the value names alone.
  const styleSection = userContext.style_notes
    ? `WRITING STYLE GUIDANCE (apply these rules to every post you write):\n${userContext.style_notes}`
    : '';

  // Shared context from all agents (research, performance, cohort, comments, content patterns, video tags).
  // This is the cross-agent intelligence layer — each section comes from a different agent
  // and is formatted as plain text ready for LLM injection.
  // Cap at 4,000 chars to stay well within Groq's request body limit when combined
  // with the system prompt, platform guides, and brief fields (~3,000 more chars).
  const MAX_CONTEXT_CHARS = 4000;
  const rawContext = userContext.shared_context || '(No intelligence data available yet — use best practices.)';
  const sharedContext = rawContext.length > MAX_CONTEXT_CHARS
    ? rawContext.slice(0, MAX_CONTEXT_CHARS) + '\n...(truncated for length)'
    : rawContext;

  // Sanitize all user-submitted fields to prevent prompt injection.
  // Enum fields (post_type, objective, tone) are validated in routes/briefs.js
  // but we sanitize anyway for defense-in-depth. Free-text fields (notes,
  // target_audience, brand_name, brand_voice) are the primary injection risk.
  const safeNotes    = sanitizeForPrompt(brief.notes);
  const safeAudience = sanitizeForPrompt(brief.target_audience);
  const safeBrand    = sanitizeForPrompt(userContext.brand_name);
  const safeIndustry = sanitizeForPrompt(userContext.industry);
  const safeVoice    = sanitizeForPrompt(userContext.brand_voice);

  return `Generate ${totalPosts} social media posts (3 options x ${brief.platforms.length} platform${brief.platforms.length > 1 ? 's' : ''}).

BRIEF:
- Post Type: ${brief.post_type}
- Objective: ${brief.objective}
- Tone: ${brief.tone}
- Target Audience: ${safeAudience || 'General audience'}
- Platforms: ${platformList}
- Additional Notes: ${safeNotes || 'None'}

BRAND CONTEXT:
- Brand Name: ${safeBrand || 'Not specified'}
- Industry: ${safeIndustry || 'Not specified'}
- Brand Voice: ${safeVoice || brief.tone}

${styleSection ? styleSection + '\n\n' : ''}INTELLIGENCE (data from all agents — use this to make smarter posts):
${sharedContext}

PLATFORM RULES:
${relevantGuides}

Generate exactly 3 post options for EACH of these platforms: ${platformList}
Total posts in the JSON array must be exactly: ${totalPosts}`;
}

// ----------------------------------------------------------------
// Parse the LLM response into a clean array of post objects.
// Local models sometimes wrap JSON in markdown code blocks or
// include extra surrounding text. This handles all those cases.
// ----------------------------------------------------------------

/**
 * sanitizeJsonControlChars
 *
 * Walks the JSON string character by character, tracking whether the cursor
 * is inside a quoted string value. Only control characters that appear INSIDE
 * string values are escaped — structural whitespace (newlines between keys,
 * indentation) is left untouched so JSON.parse can still read it.
 *
 * Without this, a naive global replace turns structural newlines into literal
 * \n text, which immediately breaks JSON.parse ("Expected property name or '}'
 * at position 1").
 */
function sanitizeJsonControlChars(text) {
  let result   = '';
  let inString = false;
  let escaped  = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (escaped) {
      // Character after a backslash — pass through as-is
      result  += ch;
      escaped  = false;
      continue;
    }

    if (ch === '\\' && inString) {
      // Start of an escape sequence inside a string
      result  += ch;
      escaped  = true;
      continue;
    }

    if (ch === '"') {
      // Toggle string mode on every unescaped double-quote
      inString = !inString;
      result  += ch;
      continue;
    }

    if (inString) {
      // Inside a string: escape bare control characters that JSON forbids
      if (ch === '\n') { result += '\\n';  continue; }
      if (ch === '\r') { result += '\\r';  continue; }
      if (ch === '\t') { result += '\\t';  continue; }
      if (ch.charCodeAt(0) < 0x20) { continue; } // strip other control chars
    }

    result += ch;
  }

  return result;
}

function parseLLMResponse(rawText) {
  let text = rawText.trim();

  // Strip markdown code fences if present: ```json...``` or ```...```
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

  // Extract just the JSON object by finding first { and last }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');

  if (start === -1 || end === -1) {
    throw new Error('LLM response did not contain a valid JSON object');
  }

  let jsonText = text.slice(start, end + 1);

  // Fix any unescaped control characters inside string values.
  // (Groq/Llama sometimes emits real newlines inside caption/hook values.)
  jsonText = sanitizeJsonControlChars(jsonText);

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`LLM returned malformed JSON: ${e.message}`);
  }

  if (!parsed.posts || !Array.isArray(parsed.posts)) {
    throw new Error('LLM JSON response is missing the required "posts" array');
  }

  // Normalise each post — ensure all fields exist and hashtags have no # prefix
  return parsed.posts
    .map((post, i) => ({
      platform:             (post.platform || '').toLowerCase().trim(),
      option_number:        typeof post.option_number === 'number' ? post.option_number : (i + 1),
      hook:                 post.hook || '',
      caption:              post.caption || '',
      hashtags:             Array.isArray(post.hashtags)
                              ? post.hashtags.map(h => String(h).replace(/^#/, '').trim())
                              : [],
      cta:                  post.cta || '',
      media_recommendation: post.media_recommendation || '',
      why_this_works:       post.why_this_works || ''
    }))
    // Drop any posts that are missing platform or hook (incomplete generation)
    .filter(post => post.platform && post.hook);
}

// ----------------------------------------------------------------
// Call the vLLM API. Retries once on any failure.
// ----------------------------------------------------------------
async function callLLM(systemPrompt, userPrompt, attempt = 1) {
  const baseUrl = process.env.LLM_BASE_URL || 'http://localhost:8000/v1';
  const endpoint = `${baseUrl}/chat/completions`;

  try {
    const response = await axios.post(
      endpoint,
      {
        model: process.env.LLM_MODEL || 'mistralai/Mistral-7B-Instruct-v0.3',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt }
        ],
        // 0.8 gives creative variety while staying coherent
        temperature: 0.8,
        // Budget per batch: 3 platforms × 3 options × ~500 tokens/post = ~4,500 tokens.
        // 5,120 gives comfortable headroom for longer captions (LinkedIn, YouTube).
        max_tokens: 5120,
        stream: false
      },
      {
        headers: {
          'Content-Type': 'application/json',
          // Pass API key if provided (required for Groq, OpenAI; optional for local vLLM)
          ...(process.env.LLM_API_KEY && process.env.LLM_API_KEY !== 'none'
            ? { Authorization: `Bearer ${process.env.LLM_API_KEY}` }
            : {})
        },
        // 60 seconds per batch. Groq finishes in ~10s; local GPU up to 45s.
        timeout: 60000
      }
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM returned an empty response body');

    return content;

  } catch (err) {
    if (attempt < 2) {
      console.warn(`[LLM] Attempt ${attempt} failed (${err.message}), retrying in 2s...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      return callLLM(systemPrompt, userPrompt, attempt + 1);
    }

    // Give a clear error if the LLM endpoint isn't reachable
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
      throw new Error('The AI model is not reachable. Check LLM_BASE_URL in your .env and make sure the service is running.');
    }

    throw err;
  }
}

// ----------------------------------------------------------------
// generatePosts — the main export.
//
// brief:       { id, post_type, objective, tone, target_audience, platforms, notes }
// userContext: { brand_name, industry, brand_voice, intelligence }
//
// Returns: array of post objects, 3 per platform.
//
// BATCHING: platforms are processed in groups of PLATFORM_BATCH_SIZE (3).
// This keeps every LLM call within token limits AND means each batch
// finishes in ~10 seconds on Groq regardless of total platforms selected.
// Example: 7 platforms → 3 batches → ~30 seconds total on Groq.
// ----------------------------------------------------------------
async function generatePosts(brief, userContext) {
  console.log(`[LLM] Generating posts | brief: ${brief.id} | platforms: ${brief.platforms.join(', ')}`);

  // Build shared context from all agents (research, performance, cohort, comments, video tags).
  // This pulls cached data from Redis and small DB queries — typically <100ms.
  // If it fails, we proceed without context (graceful degradation).
  try {
    if (userContext.user_id && !userContext.shared_context) {
      const context = await buildContext(userContext.user_id, {
        sections: ['research', 'performance', 'cohort', 'comments', 'content_patterns', 'video_tags']
      });
      userContext.shared_context = formatForPrompt(context);
      console.log(`[LLM] Shared context loaded (${userContext.shared_context.length} chars)`);
    }
  } catch (err) {
    console.warn(`[LLM] Failed to build shared context: ${err.message} — proceeding without`);
  }

  // Split platforms into batches, e.g. [['instagram','facebook','tiktok'], ['linkedin','x','threads'], ['whatsapp','telegram']]
  const batches = [];
  for (let i = 0; i < brief.platforms.length; i += PLATFORM_BATCH_SIZE) {
    batches.push(brief.platforms.slice(i, i + PLATFORM_BATCH_SIZE));
  }

  const systemPrompt = buildSystemPrompt();
  let allPosts = [];

  for (let i = 0; i < batches.length; i++) {
    const batchPlatforms = batches[i];
    console.log(`[LLM] Batch ${i + 1}/${batches.length}: ${batchPlatforms.join(', ')}`);

    // Build a prompt scoped to just this batch's platforms
    const batchBrief   = { ...brief, platforms: batchPlatforms };
    const userPrompt   = buildUserPrompt(batchBrief, userContext);
    const rawResponse  = await callLLM(systemPrompt, userPrompt);
    const batchPosts   = parseLLMResponse(rawResponse);

    allPosts = allPosts.concat(batchPosts);
    console.log(`[LLM] Batch ${i + 1} done: ${batchPosts.length} posts`);
  }

  console.log(`[LLM] Total generated: ${allPosts.length} posts`);
  return allPosts;
}

module.exports = { generatePosts, sanitizeForPrompt };
