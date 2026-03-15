/**
 * agents/researchAgent.js
 *
 * Background agent that generates niche and trend research per user,
 * caches it in Redis, and makes it available to the LLM at generation time.
 *
 * Two ways it runs:
 *   1. Scheduled: weekly for all users with published posts (Phase 5+)
 *   2. On-demand: POST /intelligence/refresh triggers refreshResearch(userId)
 *
 * How it works:
 *   - Reads the user's brand profile (industry, target_audience, brand_voice)
 *   - Builds a research prompt and asks the LLM for trend/niche insights
 *   - Caches the result in Redis: research:{userId}  (7-day TTL)
 *   - The LLM service reads this cache at generation time (see llmService.js)
 *
 * Future improvements (Phase 6+):
 *   - Integrate Google Trends API for real-time trending topics
 *   - Add RSS feeds for industry news (using rss-parser npm package)
 *   - Add Reddit API for audience signal (r/[niche] hot posts)
 *   - Add platform hashtag trending endpoints
 */

const axios = require('axios');
const { supabaseAdmin }          = require('../services/supabaseService');
const { cacheSet, cacheGet }     = require('../services/redisService');
const { loadPromptSections }     = require('../services/promptLoader');

// Research cache TTL: 7 days
const RESEARCH_TTL_SECONDS = 7 * 24 * 3600;

// ----------------------------------------------------------------
// refreshResearch — main export. Called by POST /intelligence/refresh.
// Generates a fresh research blob for one user and caches it.
// ----------------------------------------------------------------
async function refreshResearch(userId) {
  console.log(`[ResearchAgent] Refreshing research for user ${userId}...`);

  // Load the user's brand profile
  const { data: profile, error } = await supabaseAdmin
    .from('user_profiles')
    .select('brand_name, industry, target_audience, brand_voice')
    .eq('user_id', userId)
    .single();

  if (error || !profile) {
    throw new Error('Could not load user profile for research');
  }

  // Skip if profile is empty — no useful research can be generated
  if (!profile.industry && !profile.target_audience) {
    const placeholder = 'No industry or target audience set. Complete your brand profile in Settings to enable research.';
    await cacheSet(`research:${userId}`, placeholder, RESEARCH_TTL_SECONDS);
    return placeholder;
  }

  // Build the research prompt
  const researchPrompt = buildResearchPrompt(profile);

  // Call the LLM to generate research insights
  const research = await callLLMForResearch(researchPrompt);

  // Cache the result
  await cacheSet(`research:${userId}`, research, RESEARCH_TTL_SECONDS);

  console.log(`[ResearchAgent] Research cached for user ${userId}`);
  return research;
}

// ----------------------------------------------------------------
// getResearch — returns cached research or triggers a fresh fetch.
// Used by GET /intelligence/research route.
// ----------------------------------------------------------------
async function getResearch(userId) {
  const cached = await cacheGet(`research:${userId}`);
  if (cached) return cached;

  // No cache — generate fresh research
  return refreshResearch(userId);
}

// ----------------------------------------------------------------
// buildResearchPrompt — loads from prompts/research-agent.md and
// fills in the user's profile details.
// Edit that file to change what the research AI focuses on.
// ----------------------------------------------------------------
function buildResearchPrompt(profile) {
  const { user } = loadPromptSections('research-agent', {
    brand_name:       profile.brand_name      || 'Not specified',
    industry:         profile.industry         || 'Not specified',
    target_audience:  profile.target_audience  || 'Not specified',
    brand_voice:      profile.brand_voice      || 'Not specified'
  });
  return user;
}

// ----------------------------------------------------------------
// callLLMForResearch — calls the same LLM endpoint as llmService.js.
// Research calls use a lower temperature for more factual output.
// ----------------------------------------------------------------
async function callLLMForResearch(prompt) {
  const baseUrl  = process.env.LLM_BASE_URL || 'http://localhost:8000/v1';
  const endpoint = `${baseUrl}/chat/completions`;

  try {
    const response = await axios.post(
      endpoint,
      {
        model:       process.env.LLM_MODEL || 'mistralai/Mistral-7B-Instruct-v0.3',
        messages: [
          {
            role:    'system',
            content: loadPromptSections('research-agent').system
          },
          {
            role:    'user',
            content: prompt
          }
        ],
        temperature: 0.4,    // Lower temperature for more factual research
        max_tokens:  1024,   // Research summary doesn't need to be long
        stream:      false
      },
      {
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.LLM_API_KEY && process.env.LLM_API_KEY !== 'none'
            ? { Authorization: `Bearer ${process.env.LLM_API_KEY}` }
            : {})
        },
        timeout: 60000
      }
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM returned empty research response');

    return content.trim();

  } catch (err) {
    // Return a useful fallback if the LLM is unavailable
    console.error('[ResearchAgent] LLM call failed:', err.message);
    return 'Research temporarily unavailable. The AI model is not reachable. Check LLM_BASE_URL in .env.';
  }
}

module.exports = { refreshResearch, getResearch };
