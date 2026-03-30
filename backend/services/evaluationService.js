/**
 * services/evaluationService.js
 *
 * FEAT-001: Avatar-Based Content Evaluation System
 *
 * Core evaluation engine. Takes a post field (hook, caption, hashtags, CTA, media)
 * and runs it through 3-5 AI avatar personalities in parallel. Each avatar evaluates
 * from its unique perspective and returns actionable suggestions.
 *
 * Avatar selection is smart:
 *   - Universal avatars (post_type_focus = []) always run
 *   - Specialist avatars only run when the post type matches their focus
 *   - Max 5 avatars per evaluation (speed matters — 3-5 seconds target)
 *
 * Data richness strategy:
 *   Every evaluation result is tagged with avatar_id + field + post_type.
 *   Over time this builds granular data on what works for specific content types,
 *   feeding the intelligence engine and avatar self-improvement pipeline.
 */

const axios = require('axios');
const { supabaseAdmin } = require('./supabaseService');
const { cacheGet, cacheSet } = require('./redisService');
const { buildContext, formatForPrompt } = require('./contextBuilder');
const { loadPrompt } = require('./promptLoader');
const { sanitizeForPrompt } = require('./llmService');

// Max avatars per evaluation — keeps latency under 5 seconds
const MAX_AVATARS_PER_EVAL = 5;

// Avatar cache TTL: 5 minutes. Admin edits are rare, and this prevents
// hitting the DB on every evaluation request.
const AVATAR_CACHE_TTL = 300;
const AVATAR_CACHE_KEY = 'eval_avatars';

// ----------------------------------------------------------------
// getActiveAvatars — fetches avatars from DB with Redis cache.
// Returns all active avatars sorted by sort_order.
// ----------------------------------------------------------------
async function getActiveAvatars() {
  // Try cache first
  const cached = await cacheGet(AVATAR_CACHE_KEY);
  if (cached) {
    try {
      return typeof cached === 'string' ? JSON.parse(cached) : cached;
    } catch (_) { /* cache corrupt, refetch */ }
  }

  const { data, error } = await supabaseAdmin
    .from('evaluation_avatars')
    .select('*')
    .eq('active', true)
    .order('sort_order', { ascending: true });

  if (error) throw new Error(`Failed to fetch avatars: ${error.message}`);

  await cacheSet(AVATAR_CACHE_KEY, JSON.stringify(data), AVATAR_CACHE_TTL);
  return data;
}

// ----------------------------------------------------------------
// selectAvatars — picks the right avatars for this evaluation.
//
// Strategy: universal avatars first, then specialists that match
// the post type. Cap at MAX_AVATARS_PER_EVAL for speed.
// ----------------------------------------------------------------
function selectAvatars(allAvatars, postType, field) {
  // Universal avatars: post_type_focus is empty or null
  const universal = allAvatars.filter(a =>
    !a.post_type_focus || a.post_type_focus.length === 0
  );

  // Specialists: post_type_focus includes the current post type
  const specialists = postType
    ? allAvatars.filter(a =>
        a.post_type_focus && a.post_type_focus.length > 0 &&
        a.post_type_focus.includes(postType)
      )
    : [];

  // Combine: specialists first (more relevant), then universal, cap at max
  const combined = [...specialists, ...universal];

  // Deduplicate (shouldn't happen, but safety)
  const seen = new Set();
  const unique = combined.filter(a => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });

  return unique.slice(0, MAX_AVATARS_PER_EVAL);
}

// ----------------------------------------------------------------
// callEvaluationLLM — calls the LLM for a single avatar evaluation.
//
// Uses the same LLM endpoint as llmService.js (OpenAI-compatible).
// Lower temperature (0.6) for more consistent, actionable feedback.
// Lower max_tokens (1024) — evaluations are short and focused.
// ----------------------------------------------------------------
async function callEvaluationLLM(systemPrompt, userPrompt) {
  const baseUrl  = process.env.LLM_BASE_URL || 'http://localhost:8000/v1';
  const endpoint = `${baseUrl}/chat/completions`;

  const response = await axios.post(
    endpoint,
    {
      model: process.env.LLM_MODEL || 'mistralai/Mistral-7B-Instruct-v0.3',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt }
      ],
      temperature: 0.6,    // Lower than post generation — we want consistent evaluations
      max_tokens: 1024,    // Evaluations are short: 2-3 sentences + 2-3 suggestions
      stream: false
    },
    {
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.LLM_API_KEY && process.env.LLM_API_KEY !== 'none'
          ? { Authorization: `Bearer ${process.env.LLM_API_KEY}` }
          : {})
      },
      timeout: 30000   // 30 seconds — evaluation should be fast
    }
  );

  const content = response.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM returned empty response');
  return content;
}

// ----------------------------------------------------------------
// callVisionEvaluationLLM — evaluates media using the vision model.
//
// Downloads the image/thumbnail, converts to base64, sends to vision LLM.
// Same pattern as visionTaggingService.js.
// ----------------------------------------------------------------
async function callVisionEvaluationLLM(systemPrompt, userPrompt, mediaUrl) {
  const visionBaseUrl = process.env.VISION_BASE_URL || process.env.LLM_BASE_URL;
  const visionModel   = process.env.VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';
  const visionKey     = process.env.VISION_API_KEY || process.env.LLM_API_KEY;
  const endpoint      = `${visionBaseUrl}/chat/completions`;

  // Download image and convert to base64
  const imgResponse = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    timeout: 15000
  });
  const base64 = Buffer.from(imgResponse.data).toString('base64');
  const dataUrl = `data:image/jpeg;base64,${base64}`;

  const response = await axios.post(
    endpoint,
    {
      model: visionModel,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: userPrompt },
            { type: 'image_url', image_url: { url: dataUrl } }
          ]
        }
      ],
      temperature: 0.6,
      max_tokens: 1024,
      stream: false
    },
    {
      headers: {
        'Content-Type': 'application/json',
        ...(visionKey && visionKey !== 'none'
          ? { Authorization: `Bearer ${visionKey}` }
          : {})
      },
      timeout: 30000
    }
  );

  const content = response.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Vision LLM returned empty response');
  return content;
}

// ----------------------------------------------------------------
// parseEvalResponse — extracts JSON from LLM response.
//
// LLMs sometimes wrap JSON in markdown code blocks. This handles
// both clean JSON and ```json ... ``` wrapped responses.
// ----------------------------------------------------------------
function parseEvalResponse(raw) {
  // Try direct parse first
  try {
    return JSON.parse(raw);
  } catch (_) { /* not clean JSON, try extraction */ }

  // Extract from markdown code block
  const match = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (match) {
    try {
      return JSON.parse(match[1].trim());
    } catch (_) { /* extraction failed */ }
  }

  // Last resort: find the first { ... } block
  const braceMatch = raw.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]);
    } catch (_) { /* give up */ }
  }

  // Return a fallback so the evaluation isn't lost
  return {
    evaluation: raw.slice(0, 500),
    suggestions: []
  };
}

// ----------------------------------------------------------------
// runEvaluation — main export. Called by the evaluationWorker.
//
// Runs 3-5 avatar evaluations in parallel, stores results in DB,
// and returns the results array.
// ----------------------------------------------------------------
async function runEvaluation({ userId, postId, field, fieldContent, mediaUrl, postType, briefContext }) {
  // 1. Get active avatars and select the right ones for this post type
  const allAvatars = await getActiveAvatars();
  const selectedAvatars = selectAvatars(allAvatars, postType, field);

  if (selectedAvatars.length === 0) {
    throw new Error('No active avatars found');
  }

  // 2. Build shared context (research, performance, cohort data)
  let sharedContext = '';
  try {
    const ctx = await buildContext(userId, {
      sections: ['research', 'performance', 'cohort', 'voice_profile']
    });
    sharedContext = formatForPrompt(ctx);
  } catch (err) {
    console.warn('[Evaluation] Context build failed (non-fatal):', err.message);
    sharedContext = '(No intelligence data available yet — use best practices.)';
  }

  // 3. Sanitize user content
  const safeContent = sanitizeForPrompt(fieldContent);

  // 4. Build the user prompt template (shared across all avatars)
  const userPromptBase = [
    `FIELD BEING EVALUATED: ${field}`,
    `FIELD CONTENT:\n${safeContent}`,
    briefContext ? `\nBRIEF CONTEXT:\n${briefContext}` : '',
    `\nPERFORMANCE & INTELLIGENCE DATA:\n${sharedContext}`
  ].filter(Boolean).join('\n');

  // 5. Run all avatars in parallel
  const results = await Promise.allSettled(
    selectedAvatars.map(async (avatar) => {
      try {
        let raw;

        if (field === 'media' && mediaUrl) {
          // Vision evaluation for media
          raw = await callVisionEvaluationLLM(
            avatar.system_prompt,
            userPromptBase,
            mediaUrl
          );
        } else {
          // Text evaluation for all other fields
          raw = await callEvaluationLLM(avatar.system_prompt, userPromptBase);
        }

        const parsed = parseEvalResponse(raw);

        return {
          avatarId: avatar.id,
          name: avatar.name,
          icon: avatar.icon,
          evaluation: parsed.evaluation || '',
          suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : []
        };
      } catch (err) {
        console.error(`[Evaluation] Avatar "${avatar.name}" failed:`, err.message);
        return {
          avatarId: avatar.id,
          name: avatar.name,
          icon: avatar.icon,
          evaluation: `Evaluation unavailable — ${err.message}`,
          suggestions: []
        };
      }
    })
  );

  // 6. Extract fulfilled results (allSettled never rejects, but be safe)
  const evalResults = results.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);

  // 7. Batch insert into evaluation_results
  if (evalResults.length > 0) {
    const rows = evalResults.map(r => ({
      user_id: userId,
      post_id: postId,
      field,
      post_type: postType || null,
      avatar_id: r.avatarId,
      evaluation_text: r.evaluation,
      suggestions: r.suggestions
    }));

    const { error } = await supabaseAdmin
      .from('evaluation_results')
      .insert(rows);

    if (error) {
      console.error('[Evaluation] Failed to save results:', error.message);
      // Don't throw — we still return the results to the user
    }
  }

  return evalResults;
}

module.exports = { runEvaluation, getActiveAvatars };
