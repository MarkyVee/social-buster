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
    'pain_points', 'voice_profile', 'signal_weights'
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
  if (sections.includes('signal_weights'))   builders.push(buildSignalWeightsSection(userId).then(d => context.signal_weights = d));

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

  if (include.includes('signal_weights') && context.signal_weights) {
    parts.push(`## WHAT WORKS FOR YOUR AUDIENCE (learned from your post performance)\n${context.signal_weights}`);
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

// ----------------------------------------------------------------
// Signal Weights — learned performance patterns from the learning engine.
//
// Reads user_profiles.signal_weights (written by hookPerformanceAgent,
// toneObjectiveFitAgent, and postTypeCalendarAgent weekly) and formats
// it as human-readable guidance for the LLM.
//
// Example output injected into the brief prompt:
//
//   HOOK FORMATS (ranked by your audience's engagement):
//   • question  → 2.1x your average  ← use this
//   • curiosity → 1.6x your average  ← use this
//   • list      → 1.2x your average
//   • statement → 0.9x your average
//   • story     → 0.7x your average  ← avoid
//
//   TONE + OBJECTIVE COMBINATIONS:
//   • bold + conversions    → 1.8x your average  ← use this
//   • friendly + engagement → 1.4x your average  ← use this
//   ⚠️ humorous + conversions → 0.4x your average (underperforms)
//
// Returns null if no weights exist yet (new user, or first weekly run
// hasn't completed). The LLM falls back to general best practices.
// ----------------------------------------------------------------
async function buildSignalWeightsSection(userId) {
  try {
    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('signal_weights')
      .eq('user_id', userId)
      .single();

    const sw = profile?.signal_weights;
    if (!sw || typeof sw !== 'object') return null;

    const lines = [];

    // --- Hook format performance ---
    if (sw.hook_formats && Object.keys(sw.hook_formats).length > 0) {
      const sorted = Object.entries(sw.hook_formats).sort((a, b) => b[1] - a[1]);
      lines.push('HOOK FORMATS (ranked by your audience\'s engagement):');
      sorted.forEach(([format, multiplier]) => {
        const label = multiplier >= 1.3
          ? '← use this'
          : multiplier <= 0.7
            ? '← avoid'
            : '';
        lines.push(`• ${format.padEnd(10)} → ${multiplier}x your average  ${label}`.trimEnd());
      });
    }

    // --- Hook format trends (hookTrendAgent) ---
    if (sw.hook_trends && Object.keys(sw.hook_trends).length > 0) {
      if (lines.length > 0) lines.push('');
      const movingUp   = Object.entries(sw.hook_trends).filter(([, v]) => v.direction === 'up');
      const movingDown = Object.entries(sw.hook_trends).filter(([, v]) => v.direction === 'down');

      if (movingUp.length > 0 || movingDown.length > 0) {
        lines.push('HOOK FORMAT MOMENTUM (trending over last 60 days):');
        movingUp.forEach(([format, v]) => {
          lines.push(`↑ ${format} hooks: gaining traction (${v.ratio}x recent vs prior)  ← momentum building`);
        });
        movingDown.forEach(([format, v]) => {
          lines.push(`↓ ${format} hooks: losing traction (${v.ratio}x recent vs prior)  ← avoid for now`);
        });
      }
    }

    // --- Tone + objective fit ---
    if (sw.tone_objective_fit && Object.keys(sw.tone_objective_fit).length > 0) {
      if (lines.length > 0) lines.push('');
      const sorted = Object.entries(sw.tone_objective_fit).sort((a, b) => b[1] - a[1]);

      const strong  = sorted.filter(([, v]) => v >= 1.3);
      const weak    = sorted.filter(([, v]) => v <= 0.7);

      lines.push('TONE + OBJECTIVE COMBINATIONS:');
      strong.forEach(([key, v]) => {
        const [tone, obj] = key.split('_');
        lines.push(`• ${tone} + ${obj} → ${v}x your average  ← use this`);
      });
      weak.forEach(([key, v]) => {
        const [tone, obj] = key.split('_');
        lines.push(`⚠️ ${tone} + ${obj} → ${v}x your average (underperforms for your audience)`);
      });
    }

    // --- Best posting times (postTypeCalendarAgent) ---
    if (sw.best_hours && typeof sw.best_hours === 'object') {
      if (lines.length > 0) lines.push('');
      const bh = sw.best_hours;

      // Helper: convert 0-23 UTC hour to "9am" / "2pm" label
      const hourLabel = h => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
      const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

      lines.push('BEST TIMES TO POST (UTC, learned from your own audience):');

      if (Array.isArray(bh.overall) && bh.overall.length > 0) {
        const hoursStr = bh.overall.map(hourLabel).join(', ');
        const daysStr  = Array.isArray(bh.best_days) && bh.best_days.length > 0
          ? bh.best_days.map(d => DAY_NAMES[d]).join('/')
          : 'not enough data';
        lines.push(`• Overall best hours: ${hoursStr} | Best days: ${daysStr}`);
      }

      if (bh.by_post_type && Object.keys(bh.by_post_type).length > 0) {
        Object.entries(bh.by_post_type).forEach(([type, hours]) => {
          if (!Array.isArray(hours) || hours.length === 0) return;
          const sorted = [...hours].sort((a, b) => a - b);
          // Build a compact window label: "9am–11am" if consecutive, or list if not
          const labels = sorted.map(hourLabel);
          const windowStr = labels.length >= 2
            ? `${labels[0]}–${labels[labels.length - 1]} window`
            : labels[0];
          lines.push(`• ${type} posts: ${windowStr}`);
        });
      }
    }

    // --- Comment signals (commentSentimentAgent) ---
    if (sw.comment_signals && typeof sw.comment_signals === 'object') {
      if (lines.length > 0) lines.push('');
      const cs = sw.comment_signals;
      lines.push('COMMENT SIGNALS (what your audience says after reading your posts):');

      // Per-post-type intent ratios — only show the strongest signals
      if (cs.by_post_type && Object.keys(cs.by_post_type).length > 0) {
        Object.entries(cs.by_post_type).forEach(([postType, intents]) => {
          const sorted = Object.entries(intents).sort((a, b) => b[1] - a[1]);
          sorted.forEach(([intent, ratio]) => {
            const signal = ratio >= 1.5
              ? `← strong signal (${ratio}x avg)`
              : ratio <= 0.5
                ? `← low for this type (${ratio}x avg)`
                : `(${ratio}x avg)`;
            lines.push(`• ${postType} posts → ${ratio}x more ${intent} comments  ${signal}`.trimEnd());
          });
        });
      }

      // Per-tone intent ratios
      if (cs.by_tone && Object.keys(cs.by_tone).length > 0) {
        Object.entries(cs.by_tone).forEach(([tone, intents]) => {
          const sorted = Object.entries(intents).sort((a, b) => b[1] - a[1]);
          sorted.forEach(([intent, ratio]) => {
            if (ratio >= 1.5 || ratio <= 0.5) {
              const dir = ratio >= 1.5 ? 'generates' : 'suppresses';
              lines.push(`• ${tone} tone ${dir} ${intent} comments (${ratio}x avg)`);
            }
          });
        });
      }

      // Topic hints
      if (Array.isArray(cs.top_question_topics) && cs.top_question_topics.length > 0) {
        lines.push(`• Audience most often asks about: ${cs.top_question_topics.join(', ')}`);
      }
      if (Array.isArray(cs.top_request_topics) && cs.top_request_topics.length > 0) {
        lines.push(`• Audience most often requests: ${cs.top_request_topics.join(', ')}`);
      }
    }

    // --- CTA effectiveness (ctaEffectivenessAgent) ---
    if (sw.cta_effectiveness && typeof sw.cta_effectiveness === 'object') {
      if (lines.length > 0) lines.push('');
      const cta = sw.cta_effectiveness;
      lines.push('CTA EFFECTIVENESS (learned from your DM conversion data):');

      if (cta.by_format && Object.keys(cta.by_format).length > 0) {
        // Sort by trigger_rate descending
        const sorted = Object.entries(cta.by_format)
          .sort((a, b) => (b[1].trigger_rate || 0) - (a[1].trigger_rate || 0));

        sorted.forEach(([format, stats]) => {
          const isBest = format === cta.best_cta_format;
          const parts  = [`${stats.trigger_rate} DM triggers/1K reach`];
          if (stats.completion_rate > 0) parts.push(`${Math.round(stats.completion_rate * 100)}% complete`);
          if (stats.lead_rate > 0)       parts.push(`${Math.round(stats.lead_rate * 100)}% capture leads`);
          const label  = isBest ? '  ← best format for your audience' : '';
          lines.push(`• ${format.replace(/_/g, ' ')} CTAs: ${parts.join(' | ')}${label}`);
        });
      }

      if (Array.isArray(cta.top_trigger_phrases) && cta.top_trigger_phrases.length > 0) {
        lines.push(`• Top-performing CTA phrases: "${cta.top_trigger_phrases.join('", "')}"`);
      }
    }

    // --- Content fatigue warnings (contentFatigueAgent) ---
    // These go last — they're active warnings the LLM must factor into generation.
    // A fatigued pattern should be avoided in THIS brief regardless of other signals.
    if (sw.content_fatigue && typeof sw.content_fatigue === 'object') {
      const cf = sw.content_fatigue;

      // Collect all fatigued dimensions with stats for the LLM
      const warnings = [];

      const check = (buckets, labelFn) => {
        if (!buckets || typeof buckets !== 'object') return;
        Object.entries(buckets).forEach(([key, data]) => {
          if (data.fatigued) {
            const freqPct    = Math.round(data.frequency * 100);
            const dropPct    = Math.round((1 - data.engagement_decline) * 100);
            warnings.push(`${labelFn(key)}: used in ${freqPct}% of recent posts, engagement down ${dropPct}%`);
          }
        });
      };

      check(cf.by_hook_format, k => `${k} hooks`);
      check(cf.by_post_type,   k => `${k} posts`);
      check(cf.by_tone,        k => `${k} tone`);

      if (warnings.length > 0) {
        if (lines.length > 0) lines.push('');
        lines.push('⚠️ CONTENT FATIGUE WARNINGS — avoid these patterns in this brief:');
        warnings.forEach(w => lines.push(`• ${w} — audience is fatiguing on this`));
        lines.push('→ Diversify: choose a different hook format, post type, or tone than the above.');
      }
    }

    // --- Admin directives (stored by agents when set, surfaced here to LLM) ---
    // Directives are free-text guidance written by admin in the dashboard,
    // e.g. "Have you considered that this audience is B2B?"
    // They don't change the math — they give the LLM extra framing.
    const directiveKeys = ['agent_directive_hook', 'agent_directive_tone', 'agent_directive_calendar'];
    const activeDirectives = directiveKeys
      .map(k => sw[k])
      .filter(Boolean);

    if (activeDirectives.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push('ADMIN NOTES (apply these when generating content):');
      activeDirectives.forEach(d => lines.push(`• ${d}`));
    }

    return lines.length > 0 ? lines.join('\n') : null;
  } catch (_) { return null; }
}

module.exports = { buildContext, formatForPrompt };
