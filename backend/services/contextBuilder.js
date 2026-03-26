/**
 * services/contextBuilder.js
 *
 * Shared Context Pipeline — the "nervous system" connecting all AI agents.
 *
 * WHAT THIS DOES:
 * Every AI agent in Social Buster (research, video tagging, post generation,
 * performance tracking, clip selection) used to work in isolation. This service
 * pulls data from ALL agents and makes it available to ANY agent that needs it.
 *
 * HOW IT WORKS:
 * Call buildContext(userId) and get back a structured object containing:
 *   - User's brand profile (industry, voice, audience)
 *   - Research cache (trending topics, niche insights)
 *   - Performance intelligence (what's working, best times, top hooks)
 *   - Cohort benchmarks (how peers in the same niche perform)
 *   - Comment themes (what the audience is asking about)
 *   - Content patterns (recent post types, formats, frequency)
 *   - Video library tags (what visual content the user has available)
 *
 * Each agent's prompt file (in /backend/prompts/) uses {{context_*}} variables
 * that get filled with the relevant sections. Edit the prompt files to control
 * what each agent does with the shared context — no code changes needed.
 *
 * THE COLLECTIVE LAYER:
 * Individual user data feeds INTO cohort aggregations (via performanceAgent).
 * Cohort data feeds BACK into every user's context. So the more users post,
 * the smarter every agent gets for everyone. No individual post content is
 * ever shared — only aggregated, anonymized metrics.
 *
 * PERFORMANCE:
 * Most data is already cached (Redis for research/intelligence, DB for cohort).
 * Building context adds ~2-3 small DB queries. Results are cached for 1 hour
 * so repeated agent calls in the same window don't re-query.
 */

const { supabaseAdmin }      = require('./supabaseService');
const { cacheGet, cacheSet } = require('./redisService');
const { minePainPoints }     = require('./painPointMinerService');
const { getVoiceProfileForPrompt } = require('./brandVoiceService');

// Context cache TTL: 1 hour. Agents run on schedules (15min to weekly),
// so stale-by-1-hour is fine. Keeps DB queries minimal.
const CONTEXT_TTL = 3600;

// ----------------------------------------------------------------
// buildContext — main export.
//
// Pulls all available cross-agent data for a user and returns a
// structured object. Each field can be injected into any prompt via
// {{context_research}}, {{context_performance}}, etc.
//
// Options:
//   sections: array of section names to include. Default: all.
//             Use this when an agent only needs specific data to
//             avoid unnecessary DB queries.
//             e.g. ['research', 'performance', 'cohort']
// ----------------------------------------------------------------
async function buildContext(userId, options = {}) {
  const sections = options.sections || [
    'profile', 'research', 'performance', 'cohort',
    'comments', 'content_patterns', 'video_tags',
    'pain_points', 'voice_profile'
  ];

  // Check cache first
  const cacheKey = `agent_context:${userId}`;
  const cached = await cacheGet(cacheKey);
  if (cached && !options.skipCache) {
    try {
      const parsed = typeof cached === 'string' ? JSON.parse(cached) : cached;
      // If caller wants specific sections, filter
      if (options.sections) {
        const filtered = { user_id: userId };
        for (const s of options.sections) {
          if (parsed[s]) filtered[s] = parsed[s];
        }
        return filtered;
      }
      return parsed;
    } catch (_) { /* cache corrupted — rebuild */ }
  }

  const context = { user_id: userId };

  // Run all section builders in parallel for speed
  const builders = [];

  if (sections.includes('profile'))          builders.push(buildProfileSection(userId).then(d => context.profile = d));
  if (sections.includes('research'))         builders.push(buildResearchSection(userId).then(d => context.research = d));
  if (sections.includes('performance'))      builders.push(buildPerformanceSection(userId).then(d => context.performance = d));
  if (sections.includes('cohort'))           builders.push(buildCohortSection(userId).then(d => context.cohort = d));
  if (sections.includes('comments'))         builders.push(buildCommentSection(userId).then(d => context.comments = d));
  if (sections.includes('content_patterns')) builders.push(buildContentPatterns(userId).then(d => context.content_patterns = d));
  if (sections.includes('video_tags'))       builders.push(buildVideoTagsSection(userId).then(d => context.video_tags = d));
  if (sections.includes('pain_points'))      builders.push(buildPainPointsSection(userId).then(d => context.pain_points = d));
  if (sections.includes('voice_profile'))    builders.push(buildVoiceSection(userId).then(d => context.voice_profile = d));

  await Promise.all(builders);

  // Cache the full context
  try {
    await cacheSet(cacheKey, JSON.stringify(context), CONTEXT_TTL);
  } catch (_) { /* non-fatal */ }

  return context;
}

// ----------------------------------------------------------------
// formatForPrompt — converts a context object into a plain-text
// string that can be injected into any prompt file via {{variable}}.
//
// Each section becomes a labeled block. Agents use what's relevant
// and ignore the rest — the prompt file controls what matters.
// ----------------------------------------------------------------
function formatForPrompt(context, sectionNames) {
  const parts = [];
  const include = sectionNames || Object.keys(context);

  if (include.includes('research') && context.research) {
    parts.push(`## TRENDING IN YOUR NICHE (from Research Agent)\n${context.research}`);
  }

  if (include.includes('performance') && context.performance) {
    parts.push(`## YOUR PERFORMANCE DATA (from Performance Agent)\n${context.performance}`);
  }

  if (include.includes('cohort') && context.cohort) {
    parts.push(`## COHORT BENCHMARKS (how similar creators perform)\n${context.cohort}`);
  }

  if (include.includes('comments') && context.comments) {
    parts.push(`## WHAT YOUR AUDIENCE IS SAYING (from Comment Agent)\n${context.comments}`);
  }

  if (include.includes('content_patterns') && context.content_patterns) {
    parts.push(`## YOUR RECENT CONTENT PATTERNS\n${context.content_patterns}`);
  }

  if (include.includes('video_tags') && context.video_tags) {
    parts.push(`## YOUR VIDEO LIBRARY (tagged content available)\n${context.video_tags}`);
  }

  if (include.includes('pain_points') && context.pain_points) {
    parts.push(`## AUDIENCE PAIN POINTS (from Pain-Point Miner)\n${context.pain_points}`);
  }

  if (include.includes('voice_profile') && context.voice_profile) {
    parts.push(`## YOUR BRAND VOICE (learned from your published posts)\n${context.voice_profile}`);
  }

  return parts.join('\n\n') || '(No intelligence data available yet — use best practices.)';
}


// ================================================================
// SECTION BUILDERS
//
// Each function pulls data from one source and formats it as a
// concise plain-text summary suitable for LLM prompt injection.
// Keep these SHORT — LLM context is limited and expensive.
// ================================================================

// ----------------------------------------------------------------
// Profile — brand identity (always fast, single row)
// ----------------------------------------------------------------
async function buildProfileSection(userId) {
  try {
    const { data } = await supabaseAdmin
      .from('user_profiles')
      .select('brand_name, industry, target_audience, brand_voice, business_type, geo_region')
      .eq('user_id', userId)
      .single();

    if (!data) return null;

    return {
      brand_name:      data.brand_name || null,
      industry:        data.industry || null,
      target_audience: data.target_audience || null,
      brand_voice:     data.brand_voice || null,
      business_type:   data.business_type || null,
      geo_region:      data.geo_region || null
    };
  } catch (_) { return null; }
}

// ----------------------------------------------------------------
// Research — cached trend/niche insights from researchAgent
// ----------------------------------------------------------------
async function buildResearchSection(userId) {
  try {
    const cached = await cacheGet(`research:${userId}`);
    return cached || null;
  } catch (_) { return null; }
}

// ----------------------------------------------------------------
// Performance — cached per-user intelligence from performanceAgent
// ----------------------------------------------------------------
async function buildPerformanceSection(userId) {
  try {
    const cached = await cacheGet(`intelligence:${userId}`);
    return cached || null;
  } catch (_) { return null; }
}

// ----------------------------------------------------------------
// Cohort — aggregated benchmarks from peers with same industry/geo
// ----------------------------------------------------------------
async function buildCohortSection(userId) {
  try {
    // Get the user's cohort key
    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('industry, geo_region')
      .eq('user_id', userId)
      .single();

    if (!profile?.industry) return null;

    const { data: cohort } = await supabaseAdmin
      .from('cohort_performance')
      .select('platform, post_type, avg_likes, avg_reach, avg_comments, sample_size, best_hour, top_hooks')
      .eq('industry', profile.industry)
      .eq('geo_region', profile.geo_region || 'US')
      .gte('sample_size', 5)
      .order('avg_likes', { ascending: false })
      .limit(10);

    if (!cohort || cohort.length === 0) return null;

    // Format as concise text
    const lines = cohort.map(c => {
      let line = `• ${c.platform}/${c.post_type}: avg ${c.avg_likes} likes, ${c.avg_reach} reach (${c.sample_size} posts)`;
      if (c.best_hour !== null && c.best_hour !== undefined) {
        line += ` | best hour: ${c.best_hour}:00`;
      }
      return line;
    });

    // Include top hooks if available
    const allHooks = cohort
      .filter(c => c.top_hooks && c.top_hooks.length > 0)
      .flatMap(c => c.top_hooks)
      .slice(0, 5);

    if (allHooks.length > 0) {
      lines.push('', 'Top-performing hook styles in your niche:');
      allHooks.forEach(h => lines.push(`• "${h}"`));
    }

    return lines.join('\n');
  } catch (_) { return null; }
}

// ----------------------------------------------------------------
// Comments — recent audience themes and questions
// Clusters the last 30 days of comments into themes.
// This is a lightweight pass — full LLM clustering is a separate
// feature (Pain-Point Miner). Here we just surface raw signals.
// ----------------------------------------------------------------
async function buildCommentSection(userId) {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: comments } = await supabaseAdmin
      .from('comments')
      .select('comment_text, sentiment, platform')
      .eq('user_id', userId)
      .gte('ingested_at', cutoff)
      .order('ingested_at', { ascending: false })
      .limit(100);

    if (!comments || comments.length === 0) return null;

    // Basic sentiment counts
    const sentiments = { positive: 0, neutral: 0, negative: 0 };
    comments.forEach(c => {
      if (sentiments[c.sentiment] !== undefined) sentiments[c.sentiment]++;
    });

    // Extract questions (comments ending in ?)
    const questions = comments
      .filter(c => c.comment_text && c.comment_text.trim().endsWith('?'))
      .map(c => c.comment_text.trim())
      .slice(0, 10);

    // Most common words (simple frequency, skip short words)
    const stopWords = new Set(['the', 'and', 'this', 'that', 'you', 'your', 'for', 'are', 'was', 'with', 'have', 'has', 'not', 'but', 'can', 'will', 'just', 'from', 'they', 'been', 'would', 'could', 'what', 'when', 'how', 'who', 'all', 'our', 'out', 'about', 'more', 'some', 'than', 'them', 'very', 'its']);
    const wordFreq = {};
    comments.forEach(c => {
      if (!c.comment_text) return;
      c.comment_text.toLowerCase().split(/\s+/).forEach(w => {
        const clean = w.replace(/[^a-z]/g, '');
        if (clean.length > 3 && !stopWords.has(clean)) {
          wordFreq[clean] = (wordFreq[clean] || 0) + 1;
        }
      });
    });
    const topWords = Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([word, count]) => `${word} (${count}x)`);

    const lines = [
      `${comments.length} comments in last 30 days: ${sentiments.positive} positive, ${sentiments.neutral} neutral, ${sentiments.negative} negative`
    ];

    if (topWords.length > 0) {
      lines.push(`Most discussed topics: ${topWords.join(', ')}`);
    }

    if (questions.length > 0) {
      lines.push('', 'Questions your audience is asking:');
      questions.forEach(q => lines.push(`• "${q}"`));
    }

    return lines.join('\n');
  } catch (_) { return null; }
}

// ----------------------------------------------------------------
// Content Patterns — what the user has been posting recently
// Helps agents avoid repetition and suggest variety.
// ----------------------------------------------------------------
async function buildContentPatterns(userId) {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: posts } = await supabaseAdmin
      .from('posts')
      .select('platform, post_type, tone, hook, status, published_at')
      .eq('user_id', userId)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(50);

    if (!posts || posts.length === 0) return null;

    // Count by post type
    const typeCounts = {};
    const toneCounts = {};
    const platformCounts = {};
    posts.forEach(p => {
      if (p.post_type) typeCounts[p.post_type] = (typeCounts[p.post_type] || 0) + 1;
      if (p.tone)      toneCounts[p.tone]      = (toneCounts[p.tone] || 0) + 1;
      if (p.platform)  platformCounts[p.platform] = (platformCounts[p.platform] || 0) + 1;
    });

    const published = posts.filter(p => p.status === 'published').length;
    const draft     = posts.filter(p => p.status === 'draft').length;

    const lines = [
      `Last 30 days: ${posts.length} posts created (${published} published, ${draft} drafts)`,
      `Post types used: ${Object.entries(typeCounts).map(([t, c]) => `${t} (${c}x)`).join(', ')}`,
      `Tones used: ${Object.entries(toneCounts).map(([t, c]) => `${t} (${c}x)`).join(', ')}`,
      `Platforms: ${Object.entries(platformCounts).map(([p, c]) => `${p} (${c}x)`).join(', ')}`
    ];

    // Recent hooks for variety checking
    const recentHooks = posts
      .filter(p => p.hook && p.status === 'published')
      .slice(0, 5)
      .map(p => `• "${p.hook.slice(0, 80)}"`);

    if (recentHooks.length > 0) {
      lines.push('', 'Recent hooks (avoid repeating these patterns):');
      lines.push(...recentHooks);
    }

    return lines.join('\n');
  } catch (_) { return null; }
}

// ----------------------------------------------------------------
// Video Tags — summary of what visual content is in the library
// Helps post generation make better media_recommendation suggestions
// and helps clip selection understand what's available.
// ----------------------------------------------------------------
async function buildVideoTagsSection(userId) {
  try {
    const { data: segments } = await supabaseAdmin
      .from('video_segments')
      .select('tags, mood, description, energy_level, pacing')
      .eq('user_id', userId)
      .limit(100);

    if (!segments || segments.length === 0) return null;

    // Aggregate all tags with frequency
    const tagFreq = {};
    const moodFreq = {};
    segments.forEach(s => {
      if (Array.isArray(s.tags)) {
        s.tags.forEach(t => { tagFreq[t] = (tagFreq[t] || 0) + 1; });
      }
      if (s.mood) moodFreq[s.mood] = (moodFreq[s.mood] || 0) + 1;
    });

    const topTags = Object.entries(tagFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([tag, count]) => `${tag} (${count}x)`);

    const moods = Object.entries(moodFreq)
      .sort((a, b) => b[1] - a[1])
      .map(([mood, count]) => `${mood} (${count}x)`);

    // Energy distribution
    const energyScores = segments.filter(s => s.energy_level != null).map(s => s.energy_level);
    const avgEnergy = energyScores.length > 0
      ? (energyScores.reduce((a, b) => a + b, 0) / energyScores.length).toFixed(1)
      : null;

    const lines = [
      `${segments.length} analyzed video segments available`,
      `Content tags: ${topTags.join(', ')}`,
      `Mood distribution: ${moods.join(', ')}`
    ];

    if (avgEnergy) {
      lines.push(`Average energy level: ${avgEnergy}/10`);
    }

    return lines.join('\n');
  } catch (_) { return null; }
}


// ----------------------------------------------------------------
// Pain Points — LLM-clustered audience themes from comments.
// Uses the painPointMinerService (cached 6 hours internally).
// ----------------------------------------------------------------
async function buildPainPointsSection(userId) {
  try {
    const result = await minePainPoints(userId, { limit: 5 });
    if (!result?.available || !result.pain_points?.length) return null;

    const lines = [`${result.comment_count} comments analyzed, ${result.pain_points.length} pain points identified:`];

    result.pain_points.forEach((pp, i) => {
      lines.push(`\n${i + 1}. ${pp.theme} [${pp.urgency} urgency, ${pp.frequency}x mentioned]`);
      if (pp.description) lines.push(`   ${pp.description}`);
      if (pp.post_angles?.length) {
        pp.post_angles.forEach(angle => lines.push(`   → Post idea: ${angle}`));
      }
    });

    return lines.join('\n');
  } catch (_) { return null; }
}

// ----------------------------------------------------------------
// Voice Profile — learned writing style from published posts.
// Uses the brandVoiceService (cached 24 hours internally).
// ----------------------------------------------------------------
async function buildVoiceSection(userId) {
  try {
    return await getVoiceProfileForPrompt(userId);
  } catch (_) { return null; }
}

module.exports = { buildContext, formatForPrompt };
