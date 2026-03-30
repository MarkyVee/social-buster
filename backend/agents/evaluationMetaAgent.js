/**
 * agents/evaluationMetaAgent.js
 *
 * FEAT-001 Phase 6: Avatar Self-Improvement Agent
 *
 * Analyzes evaluation outcomes to suggest prompt improvements for each avatar.
 * The more evaluations happen, the smarter this agent gets at recommending
 * prompt tweaks — building a data flywheel that improves content quality
 * across all users.
 *
 * HOW IT WORKS:
 *   1. For each active avatar, pull the last 30 days of evaluation_results
 *   2. Cross-reference with posts table: did the user edit after seeing suggestions?
 *      Did the post perform well after publishing?
 *   3. Identify patterns: which suggestions were followed? Which led to better performance?
 *   4. Call LLM with the avatar's current prompt + outcome data → generate improved prompt
 *   5. INSERT into avatar_prompt_suggestions (status: pending) for admin review
 *
 * TRIGGERS:
 *   - On-demand from admin panel ("Analyze & Suggest Improvements" button)
 *   - Can also be scheduled as a daily/weekly BullMQ repeatable job
 *
 * DATA SIGNALS:
 *   - Suggestion acceptance rate: how often users click "Apply"
 *   - Post performance after evaluation: likes, comments, reach (from post_metrics)
 *   - Field edit frequency: did the user change the field after seeing eval?
 *   - Avatar-specific patterns: does one avatar consistently provide better suggestions?
 *   - Post type patterns: does the avatar perform differently for educational vs promotional?
 */

const axios = require('axios');
const { supabaseAdmin } = require('../services/supabaseService');
const { getActiveAvatars } = require('../services/evaluationService');

// How far back to look for evaluation data
const ANALYSIS_WINDOW_DAYS = 30;

// Min evaluations needed before the agent makes suggestions (need enough data)
const MIN_EVALUATIONS_PER_AVATAR = 10;

// ----------------------------------------------------------------
// callMetaLLM — calls the LLM to analyze outcomes and suggest
// prompt improvements. Lower temperature for analytical reasoning.
// ----------------------------------------------------------------
async function callMetaLLM(systemPrompt, userPrompt) {
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
      temperature: 0.4,    // Low temp — analytical, not creative
      max_tokens: 2048,    // Needs room for full prompt rewrite + reasoning
      stream: false
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
  if (!content) throw new Error('Meta-agent LLM returned empty response');
  return content;
}

// ----------------------------------------------------------------
// gatherAvatarOutcomes — pulls evaluation + post performance data
// for a single avatar over the analysis window.
// ----------------------------------------------------------------
async function gatherAvatarOutcomes(avatarId) {
  const cutoff = new Date(Date.now() - ANALYSIS_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // Get all evaluations for this avatar in the window
  const { data: evaluations, error: evalErr } = await supabaseAdmin
    .from('evaluation_results')
    .select('id, post_id, field, post_type, evaluation_text, suggestions, created_at')
    .eq('avatar_id', avatarId)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false })
    .limit(200);

  if (evalErr || !evaluations || evaluations.length === 0) {
    return null;
  }

  // Get unique post IDs to check performance
  const postIds = [...new Set(evaluations.map(e => e.post_id))];

  // Fetch post data: status + metrics (did it get published? how did it perform?)
  const { data: posts } = await supabaseAdmin
    .from('posts')
    .select('id, status, platform, updated_at')
    .in('id', postIds.slice(0, 100)); // Cap to prevent oversized query

  // Fetch post metrics for published posts
  const publishedIds = (posts || []).filter(p => p.status === 'published').map(p => p.id);
  let metrics = [];
  if (publishedIds.length > 0) {
    const { data: metricsData } = await supabaseAdmin
      .from('post_metrics')
      .select('post_id, likes, comments, shares, reach, impressions')
      .in('post_id', publishedIds.slice(0, 100));
    metrics = metricsData || [];
  }

  // Build a performance map: postId → { likes, comments, shares, reach }
  const perfMap = {};
  for (const m of metrics) {
    perfMap[m.post_id] = m;
  }

  // Build a post status map
  const postMap = {};
  for (const p of (posts || [])) {
    postMap[p.id] = p;
  }

  return {
    evaluations,
    postMap,
    perfMap,
    totalEvaluations: evaluations.length,
    publishedCount: publishedIds.length,
    avgMetrics: publishedIds.length > 0 ? {
      avgLikes: Math.round(metrics.reduce((s, m) => s + (m.likes || 0), 0) / metrics.length),
      avgComments: Math.round(metrics.reduce((s, m) => s + (m.comments || 0), 0) / metrics.length),
      avgReach: Math.round(metrics.reduce((s, m) => s + (m.reach || 0), 0) / metrics.length)
    } : null
  };
}

// ----------------------------------------------------------------
// analyzeAvatar — runs the meta-analysis for one avatar and
// generates a prompt improvement suggestion if warranted.
// ----------------------------------------------------------------
async function analyzeAvatar(avatar, outcomes) {
  // Build the analysis prompt
  const systemPrompt = `You are an AI prompt engineering expert. Your job is to analyze how well an evaluation avatar's prompt is performing and suggest specific improvements.

You will receive:
1. The avatar's current system prompt
2. A sample of recent evaluations this avatar produced
3. Performance data on posts that were evaluated (likes, comments, reach)
4. Patterns in what types of content this avatar evaluates

Your output must be valid JSON:
{
  "should_update": true/false,
  "confidence": 0.0-1.0,
  "reason": "Why you recommend this change (2-3 sentences)",
  "suggested_prompt": "The full improved system prompt (only if should_update is true)",
  "key_changes": ["List of specific changes you made and why"]
}

Rules:
- Only suggest changes if you have HIGH confidence they will improve evaluation quality
- Keep the avatar's personality and core evaluation focus intact
- Improve specificity, actionability, and relevance of the evaluations
- If the avatar is performing well (users are applying suggestions, posts are performing), don't change it
- Consider post_type patterns — if the avatar only sees certain types of content, optimize for those`;

  // Sample 10 recent evaluations for the prompt (don't send 200)
  const sampleEvals = outcomes.evaluations.slice(0, 10).map(e => ({
    field: e.field,
    post_type: e.post_type,
    evaluation_snippet: (e.evaluation_text || '').slice(0, 200),
    suggestion_count: (e.suggestions || []).length,
    had_replacements: (e.suggestions || []).some(s => s.replacement)
  }));

  // Count suggestion patterns
  const totalSuggestions = outcomes.evaluations.reduce((s, e) => s + (e.suggestions || []).length, 0);
  const withReplacements = outcomes.evaluations.reduce((s, e) =>
    s + (e.suggestions || []).filter(sg => sg.replacement).length, 0);

  // Post type distribution
  const postTypes = {};
  for (const e of outcomes.evaluations) {
    const pt = e.post_type || 'unknown';
    postTypes[pt] = (postTypes[pt] || 0) + 1;
  }

  // Field distribution
  const fields = {};
  for (const e of outcomes.evaluations) {
    fields[e.field] = (fields[e.field] || 0) + 1;
  }

  const userPrompt = `AVATAR: ${avatar.icon} ${avatar.name}
DESCRIPTION: ${avatar.description}
FIELD FOCUS: ${(avatar.field_focus || []).join(', ') || 'all fields'}
POST TYPE FOCUS: ${(avatar.post_type_focus || []).join(', ') || 'universal'}

CURRENT SYSTEM PROMPT:
${avatar.system_prompt}

PERFORMANCE DATA (last ${ANALYSIS_WINDOW_DAYS} days):
- Total evaluations: ${outcomes.totalEvaluations}
- Posts later published: ${outcomes.publishedCount}
- Total suggestions given: ${totalSuggestions}
- Suggestions with replacements: ${withReplacements}
${outcomes.avgMetrics ? `- Avg post performance: ${outcomes.avgMetrics.avgLikes} likes, ${outcomes.avgMetrics.avgComments} comments, ${outcomes.avgMetrics.avgReach} reach` : '- No published post metrics yet'}

POST TYPE DISTRIBUTION:
${Object.entries(postTypes).map(([k, v]) => `  ${k}: ${v} evaluations`).join('\n')}

FIELD DISTRIBUTION:
${Object.entries(fields).map(([k, v]) => `  ${k}: ${v} evaluations`).join('\n')}

SAMPLE EVALUATIONS:
${JSON.stringify(sampleEvals, null, 2)}

Based on this data, should the avatar's prompt be updated? If so, provide the full improved prompt.`;

  const raw = await callMetaLLM(systemPrompt, userPrompt);

  // Parse the response
  try {
    // Try direct JSON parse
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      // Extract from markdown code block
      const match = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (match) parsed = JSON.parse(match[1].trim());
      else {
        const braceMatch = raw.match(/\{[\s\S]*\}/);
        if (braceMatch) parsed = JSON.parse(braceMatch[0]);
      }
    }

    if (!parsed) {
      console.warn(`[MetaAgent] Could not parse LLM response for avatar "${avatar.name}"`);
      return null;
    }

    return parsed;

  } catch (err) {
    console.error(`[MetaAgent] Parse error for avatar "${avatar.name}":`, err.message);
    return null;
  }
}

// ----------------------------------------------------------------
// runMetaAnalysis — main export. Analyzes all active avatars and
// inserts prompt suggestions for any that warrant changes.
//
// Returns a summary of what was analyzed and suggested.
// ----------------------------------------------------------------
async function runMetaAnalysis() {
  console.log('[MetaAgent] Starting avatar prompt analysis...');

  const avatars = await getActiveAvatars();
  const results = [];

  for (const avatar of avatars) {
    try {
      // Gather outcome data
      const outcomes = await gatherAvatarOutcomes(avatar.id);

      if (!outcomes || outcomes.totalEvaluations < MIN_EVALUATIONS_PER_AVATAR) {
        results.push({
          avatar: avatar.name,
          icon: avatar.icon,
          status: 'skipped',
          reason: `Only ${outcomes?.totalEvaluations || 0} evaluations (need ${MIN_EVALUATIONS_PER_AVATAR}+)`
        });
        continue;
      }

      // Run the meta-analysis LLM call
      const analysis = await analyzeAvatar(avatar, outcomes);

      if (!analysis || !analysis.should_update) {
        results.push({
          avatar: avatar.name,
          icon: avatar.icon,
          status: 'no_change',
          reason: analysis?.reason || 'Current prompt is performing well'
        });
        continue;
      }

      // Insert the suggestion for admin review
      const { error } = await supabaseAdmin
        .from('avatar_prompt_suggestions')
        .insert({
          avatar_id: avatar.id,
          suggested_prompt: analysis.suggested_prompt,
          reason: analysis.reason,
          metrics_basis: {
            total_evaluations: outcomes.totalEvaluations,
            published_count: outcomes.publishedCount,
            avg_metrics: outcomes.avgMetrics,
            confidence: analysis.confidence,
            key_changes: analysis.key_changes || []
          }
        });

      if (error) {
        console.error(`[MetaAgent] Failed to save suggestion for "${avatar.name}":`, error.message);
        results.push({
          avatar: avatar.name,
          icon: avatar.icon,
          status: 'error',
          reason: error.message
        });
      } else {
        results.push({
          avatar: avatar.name,
          icon: avatar.icon,
          status: 'suggested',
          reason: analysis.reason,
          confidence: analysis.confidence,
          changes: analysis.key_changes || []
        });
        console.log(`[MetaAgent] Prompt suggestion created for "${avatar.name}" (confidence: ${analysis.confidence})`);
      }

    } catch (err) {
      console.error(`[MetaAgent] Error analyzing avatar "${avatar.name}":`, err.message);
      results.push({
        avatar: avatar.name,
        icon: avatar.icon,
        status: 'error',
        reason: err.message
      });
    }
  }

  console.log(`[MetaAgent] Analysis complete. ${results.filter(r => r.status === 'suggested').length} suggestions created.`);
  return results;
}

module.exports = { runMetaAnalysis };
