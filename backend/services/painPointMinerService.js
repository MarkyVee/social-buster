/**
 * services/painPointMinerService.js
 *
 * Mines audience pain points, questions, and desires from ingested comments.
 * Uses the LLM to cluster raw comments into actionable themes.
 *
 * Data flow:
 *   1. Pull raw comments from the last 30 days (comments table)
 *   2. Pre-filter: extract questions (ends with ?) and negative-sentiment comments
 *   3. Send to LLM with the pain-point-mining prompt
 *   4. LLM returns structured themes with frequency, urgency, and example quotes
 *   5. Cache result in Redis (6-hour TTL — refreshes on next request after expiry)
 *
 * The output feeds into:
 *   - contextBuilder.js (injected into post generation prompts)
 *   - Frontend intelligence dashboard (pain-point card)
 *   - Brief form pre-flight panel (suggested topics)
 *
 * Graceful degradation: if the user has < 5 comments, returns a
 * "not enough data" response instead of hallucinating themes.
 */

const { supabaseAdmin } = require('./supabaseService');
const { cacheGet, cacheSet } = require('./redisService');
const { loadPrompt } = require('./promptLoader');
const axios = require('axios');

// Minimum comments needed before we attempt LLM clustering
const MIN_COMMENTS = 5;

// Cache TTL: 6 hours (pain points don't change that fast)
const CACHE_TTL = 6 * 60 * 60;

// ----------------------------------------------------------------
// minePainPoints — the main export.
//
// Options:
//   platform — optional filter (e.g. 'instagram')
//   limit    — max number of themes to return (default 5)
//
// Returns: { available, pain_points, comment_count, message }
// ----------------------------------------------------------------
async function minePainPoints(userId, options = {}) {
  const { platform, limit = 5 } = options;

  // Check cache first
  const cacheKey = `pain_points:${userId}:${platform || 'all'}`;
  const cached = await cacheGet(cacheKey);
  if (cached) {
    try {
      const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
      return parsed;
    } catch {
      // Cache is corrupted — regenerate
    }
  }

  // Pull raw comments from the last 30 days
  const comments = await fetchRecentComments(userId, platform);

  if (comments.length < MIN_COMMENTS) {
    return {
      available: false,
      pain_points: [],
      comment_count: comments.length,
      message: `Need at least ${MIN_COMMENTS} comments to identify pain points. You have ${comments.length} so far.`
    };
  }

  // Pre-filter: prioritize questions and negative comments (they reveal pain points)
  const questions = comments.filter(c => c.comment_text.trim().endsWith('?'));
  const negative  = comments.filter(c => c.sentiment === 'negative');
  const neutral   = comments.filter(c => c.sentiment === 'neutral');

  // Build a representative sample (max 100 comments to stay within token limits)
  const sample = deduplicateAndLimit([
    ...questions,
    ...negative,
    ...neutral,
    ...comments  // fill remaining slots with any comments
  ], 100);

  // Call the LLM to cluster into themes
  const painPoints = await clusterWithLLM(sample, limit);

  const result = {
    available: true,
    pain_points: painPoints,
    comment_count: comments.length,
    question_count: questions.length,
    negative_count: negative.length
  };

  // Cache for 6 hours
  await cacheSet(cacheKey, JSON.stringify(result), CACHE_TTL);

  return result;
}

// ----------------------------------------------------------------
// fetchRecentComments — pulls all comments from the last 30 days
// ----------------------------------------------------------------
async function fetchRecentComments(userId, platform) {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    let query = supabaseAdmin
      .from('comments')
      .select('comment_text, sentiment, platform, ingested_at')
      .eq('user_id', userId)
      .gte('ingested_at', cutoff)
      .order('ingested_at', { ascending: false })
      .limit(500);

    if (platform) {
      query = query.eq('platform', platform);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return data || [];

  } catch (err) {
    console.error('[PainPointMiner] Failed to fetch comments:', err.message);
    return [];
  }
}

// ----------------------------------------------------------------
// deduplicateAndLimit — removes near-duplicate comments, caps at limit
// ----------------------------------------------------------------
function deduplicateAndLimit(comments, maxCount) {
  const seen = new Set();
  const unique = [];

  for (const comment of comments) {
    // Normalize for dedup: lowercase, strip punctuation, first 50 chars
    const key = comment.comment_text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .trim()
      .slice(0, 50);

    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(comment);

    if (unique.length >= maxCount) break;
  }

  return unique;
}

// ----------------------------------------------------------------
// clusterWithLLM — sends comment sample to the LLM for theme extraction
// ----------------------------------------------------------------
async function clusterWithLLM(comments, limit) {
  const systemPrompt = loadPrompt('pain-point-mining');

  // Format comments as a numbered list for the LLM
  const commentList = comments
    .map((c, i) => `${i + 1}. [${c.sentiment}] [${c.platform}] "${c.comment_text}"`)
    .join('\n');

  const userPrompt = `Analyze these ${comments.length} audience comments and identify the top ${limit} recurring pain points, questions, or desires.

COMMENTS:
${commentList}

Return exactly ${limit} themes (or fewer if the data doesn't support that many). Follow the JSON format in your instructions.`;

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
        temperature: 0.4,  // Lower temp for analytical tasks
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
    if (!content) return [];

    return parsePainPointResponse(content, limit);

  } catch (err) {
    console.error('[PainPointMiner] LLM clustering failed:', err.message);
    // Fall back to simple keyword-based clustering
    return fallbackClustering(comments, limit);
  }
}

// ----------------------------------------------------------------
// parsePainPointResponse — extracts structured themes from LLM output
// ----------------------------------------------------------------
function parsePainPointResponse(rawText, limit) {
  try {
    let text = rawText.trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

    const start = text.indexOf('{');
    const end   = text.lastIndexOf('}');
    if (start === -1 || end === -1) return [];

    const parsed = JSON.parse(text.slice(start, end + 1));
    const themes = parsed.pain_points || parsed.themes || [];

    return themes.slice(0, limit).map(theme => ({
      theme:       theme.theme       || theme.title || 'Unknown theme',
      urgency:     theme.urgency     || 'medium',
      frequency:   theme.frequency   || theme.count || 0,
      description: theme.description || theme.summary || '',
      quotes:      Array.isArray(theme.quotes) ? theme.quotes.slice(0, 3) : [],
      post_angles: Array.isArray(theme.post_angles) ? theme.post_angles.slice(0, 2) : []
    }));

  } catch (err) {
    console.error('[PainPointMiner] Failed to parse LLM response:', err.message);
    return [];
  }
}

// ----------------------------------------------------------------
// fallbackClustering — simple keyword-frequency clustering when LLM fails.
// Groups comments by most common significant words.
// ----------------------------------------------------------------
function fallbackClustering(comments, limit) {
  // Count word frequency across all comments
  const wordCounts = {};
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'this', 'that', 'these', 'those',
    'i', 'me', 'my', 'you', 'your', 'it', 'its', 'we', 'our', 'they',
    'them', 'their', 'what', 'which', 'who', 'when', 'where', 'how',
    'not', 'no', 'so', 'if', 'or', 'and', 'but', 'for', 'to', 'of',
    'in', 'on', 'at', 'by', 'with', 'from', 'up', 'about', 'into',
    'just', 'like', 'more', 'very', 'really', 'get', 'got', 'too'
  ]);

  comments.forEach(c => {
    const words = c.comment_text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/);
    words.forEach(w => {
      if (w.length > 3 && !stopWords.has(w)) {
        wordCounts[w] = (wordCounts[w] || 0) + 1;
      }
    });
  });

  // Take top words as themes
  const topWords = Object.entries(wordCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  return topWords.map(([word, count]) => {
    // Find example comments containing this word
    const examples = comments
      .filter(c => c.comment_text.toLowerCase().includes(word))
      .slice(0, 2);

    return {
      theme:       `Audience interest: "${word}"`,
      urgency:     'medium',
      frequency:   count,
      description: `Mentioned ${count} times across comments`,
      quotes:      examples.map(e => e.comment_text.slice(0, 100)),
      post_angles: []
    };
  });
}

module.exports = { minePainPoints };
