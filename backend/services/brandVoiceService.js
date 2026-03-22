/**
 * services/brandVoiceService.js
 *
 * Learns a user's unique writing voice by analyzing their published posts.
 * The more posts they publish, the more accurate the voice profile becomes.
 *
 * Data flow:
 *   1. Pull all published posts from the last 90 days
 *   2. Send hooks + captions to the LLM with the brand-voice-analysis prompt
 *   3. LLM returns a structured voice profile:
 *      - tone patterns, vocabulary preferences, sentence structure
 *      - signature phrases, emoji usage, CTA style
 *   4. Cache in Redis (24-hour TTL, refreshes automatically)
 *   5. Profile is injected into post generation via contextBuilder
 *
 * The voice profile is NOT stored in the database — it's derived from
 * the posts themselves. If posts change, the profile auto-updates.
 *
 * Graceful degradation: needs at least 5 published posts to build
 * a meaningful profile. Returns null below that threshold.
 */

const { supabaseAdmin } = require('./supabaseService');
const { cacheGet, cacheSet } = require('./redisService');
const { loadPrompt } = require('./promptLoader');
const axios = require('axios');

// Minimum published posts before we can learn voice patterns
const MIN_POSTS_FOR_VOICE = 5;

// Cache TTL: 24 hours (voice doesn't change per-session)
const CACHE_TTL = 24 * 60 * 60;

// ----------------------------------------------------------------
// getVoiceProfile — the main export.
//
// Returns the user's voice profile object, or null if not enough data.
// Checks cache first, then rebuilds from posts if needed.
// ----------------------------------------------------------------
async function getVoiceProfile(userId) {
  // Check cache first
  const cacheKey = `voice_profile:${userId}`;
  const cached = await cacheGet(cacheKey);
  if (cached) {
    try {
      return typeof cached === 'string' ? JSON.parse(cached) : cached;
    } catch {
      // Cache corrupted — rebuild
    }
  }

  // Pull published posts
  const posts = await fetchPublishedPosts(userId);

  if (posts.length < MIN_POSTS_FOR_VOICE) {
    return {
      available: false,
      post_count: posts.length,
      message: `Need at least ${MIN_POSTS_FOR_VOICE} published posts to learn your voice. You have ${posts.length} so far.`
    };
  }

  // Build profile via LLM
  const profile = await analyzeVoiceWithLLM(posts);

  if (profile) {
    profile.available = true;
    profile.post_count = posts.length;
    profile.last_analyzed = new Date().toISOString();

    // Cache for 24 hours
    await cacheSet(cacheKey, JSON.stringify(profile), CACHE_TTL);
  }

  return profile || {
    available: false,
    post_count: posts.length,
    message: 'Voice analysis failed — will retry on next request.'
  };
}

// ----------------------------------------------------------------
// getVoiceProfileForPrompt — returns a plain-text summary suitable
// for injection into LLM prompts. Used by contextBuilder.
// ----------------------------------------------------------------
async function getVoiceProfileForPrompt(userId) {
  const profile = await getVoiceProfile(userId);

  if (!profile?.available) return null;

  const lines = [];
  lines.push('BRAND VOICE PROFILE (learned from your published posts):');

  if (profile.overall_tone) {
    lines.push(`- Overall tone: ${profile.overall_tone}`);
  }
  if (profile.sentence_style) {
    lines.push(`- Sentence style: ${profile.sentence_style}`);
  }
  if (profile.vocabulary_level) {
    lines.push(`- Vocabulary: ${profile.vocabulary_level}`);
  }
  if (profile.hook_patterns?.length) {
    lines.push(`- Preferred hook styles: ${profile.hook_patterns.join(', ')}`);
  }
  if (profile.signature_phrases?.length) {
    lines.push(`- Signature phrases: ${profile.signature_phrases.join(', ')}`);
  }
  if (profile.cta_style) {
    lines.push(`- CTA style: ${profile.cta_style}`);
  }
  if (profile.emoji_usage) {
    lines.push(`- Emoji usage: ${profile.emoji_usage}`);
  }
  if (profile.writing_rules?.length) {
    lines.push('- Writing rules to follow:');
    profile.writing_rules.forEach(rule => {
      lines.push(`  * ${rule}`);
    });
  }

  return lines.join('\n');
}

// ----------------------------------------------------------------
// fetchPublishedPosts — pulls hooks and captions from published posts
// ----------------------------------------------------------------
async function fetchPublishedPosts(userId) {
  try {
    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabaseAdmin
      .from('posts')
      .select('hook, caption, cta, platform, tone:briefs(tone)')
      .eq('user_id', userId)
      .eq('status', 'published')
      .gte('published_at', cutoff)
      .order('published_at', { ascending: false })
      .limit(50);

    if (error) throw new Error(error.message);

    return (data || []).filter(p => p.hook || p.caption);

  } catch (err) {
    console.error('[BrandVoice] Failed to fetch published posts:', err.message);
    return [];
  }
}

// ----------------------------------------------------------------
// analyzeVoiceWithLLM — sends post samples to the LLM for analysis
// ----------------------------------------------------------------
async function analyzeVoiceWithLLM(posts) {
  const systemPrompt = loadPrompt('brand-voice-analysis');

  // Format posts for the LLM
  const postList = posts.map((p, i) => {
    const tone = p.tone?.tone || 'unknown';
    return `Post ${i + 1} [${p.platform}, ${tone} tone]:
Hook: ${p.hook || '(none)'}
Caption: ${(p.caption || '').slice(0, 300)}
CTA: ${p.cta || '(none)'}`;
  }).join('\n\n');

  const userPrompt = `Analyze these ${posts.length} published posts to build a voice profile for this creator.

${postList}

Build a comprehensive voice profile based on the patterns you observe. Follow the JSON format in your instructions.`;

  try {
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
        temperature: 0.3,  // Low temp for consistent analysis
        max_tokens: 2048,
        stream: false
      },
      {
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.LLM_API_KEY && process.env.LLM_API_KEY !== 'none'
            ? { Authorization: `Bearer ${process.env.LLM_API_KEY}` }
            : {})
        },
        timeout: 30000
      }
    );

    const content = response.data?.choices?.[0]?.message?.content;
    if (!content) return null;

    return parseVoiceResponse(content);

  } catch (err) {
    console.error('[BrandVoice] LLM analysis failed:', err.message);
    return null;
  }
}

// ----------------------------------------------------------------
// parseVoiceResponse — extracts the voice profile from LLM output
// ----------------------------------------------------------------
function parseVoiceResponse(rawText) {
  try {
    let text = rawText.trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

    const start = text.indexOf('{');
    const end   = text.lastIndexOf('}');
    if (start === -1 || end === -1) return null;

    const parsed = JSON.parse(text.slice(start, end + 1));

    return {
      overall_tone:      parsed.overall_tone      || null,
      sentence_style:    parsed.sentence_style    || null,
      vocabulary_level:  parsed.vocabulary_level  || null,
      hook_patterns:     Array.isArray(parsed.hook_patterns) ? parsed.hook_patterns.slice(0, 5) : [],
      signature_phrases: Array.isArray(parsed.signature_phrases) ? parsed.signature_phrases.slice(0, 5) : [],
      cta_style:         parsed.cta_style         || null,
      emoji_usage:       parsed.emoji_usage       || null,
      avg_hook_length:   parsed.avg_hook_length   || null,
      avg_caption_length: parsed.avg_caption_length || null,
      writing_rules:     Array.isArray(parsed.writing_rules) ? parsed.writing_rules.slice(0, 5) : []
    };

  } catch (err) {
    console.error('[BrandVoice] Failed to parse LLM response:', err.message);
    return null;
  }
}

module.exports = { getVoiceProfile, getVoiceProfileForPrompt };
