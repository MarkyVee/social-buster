/**
 * agents/briefOptimizationAgent.js
 *
 * Layer 4 Synthesis Agent — Brief Optimization.
 *
 * WHAT THIS DOES:
 * Reads ALL signal_weights data accumulated by the Layer 1–3 agents and
 * synthesizes it into one concrete, actionable recommendation:
 *
 *   "For your next post: use a question hook (2.1x your avg),
 *    educational content (your audience asks 3x more questions on it),
 *    post Tuesday at 9am UTC, use a comment_keyword CTA (4.2 DM triggers/1K reach).
 *    Avoid list hooks (trending down 29%) and promotional tone (fatigued, used in 55% of recent posts)."
 *
 * This is NOT a new data source. It reads and combines what all other agents
 * have already written. The value is the synthesis — connecting signals from
 * different layers into one brief that a user could act on immediately.
 *
 * WHERE IT SHOWS UP:
 *   1. Intelligence Dashboard preflight panel — "Optimized Brief Suggestion" card
 *   2. contextBuilder injects it as "YOUR OPTIMAL NEXT POST" block in LLM prompts
 *      so generation is nudged toward the highest-signal brief automatically
 *
 * HOW IT WORKS:
 *
 *   Step 1: Score every possible (hook_format × post_type × tone) combination
 *     using existing signal_weights multipliers. The combination with the highest
 *     composite score is the "optimal brief."
 *
 *   Composite score formula:
 *     hook_score      = hook_formats[format] multiplier (default 1.0)
 *     tone_score      = tone_objective_fit[tone_*] best matching multiplier (default 1.0)
 *     comment_score   = comment_signals.by_post_type[type].question ratio (1.0 = avg)
 *     cta_score       = cta_effectiveness.by_format best trigger_rate (normalized 0–2)
 *     fatigue_penalty = 0.1 if that dimension is flagged as fatigued (massive discouragement)
 *     trend_bonus     = +0.2 if hook format is trending up, -0.2 if trending down
 *
 *   composite = hook_score × tone_score × (1 + comment_boost) × (1 - fatigue_penalty)
 *               × (1 + trend_direction)
 *
 *   Step 2: Pick the best posting time from best_hours.
 *
 *   Step 3: Pick the best CTA format from cta_effectiveness.
 *
 *   Step 4: Identify active warnings (fatigue + algorithm alerts) to include as
 *     explicit "avoid" guidance.
 *
 * WHAT IT WRITES (signal_weights.brief_optimization):
 *   {
 *     "brief_optimization": {
 *       "recommended_hook_format":  "question",
 *       "recommended_post_type":    "educational",
 *       "recommended_tone":         "bold",
 *       "recommended_cta_format":   "comment_keyword",
 *       "recommended_post_day":     2,       ← Tuesday (0=Sun)
 *       "recommended_post_hour":    9,       ← 9am UTC
 *       "composite_score":          3.2,     ← relative quality vs baseline 1.0
 *       "avoid_patterns":           ["list hooks", "promotional posts"],
 *       "signal_count":             6,       ← how many distinct signals fed this
 *       "confidence":               "high"   ← high/medium/low based on signal_count
 *     }
 *   }
 *
 * CONFIDENCE LEVELS:
 *   high   → 5+ signal sources fed the recommendation
 *   medium → 3–4 signal sources
 *   low    → 1–2 signal sources (shows recommendation but flags limited data)
 *
 * MINIMUM DATA:
 *   Runs on any user_profiles row that has at least ONE signal_weights key set.
 *   The more agents have run, the better the recommendation. Gracefully degrades
 *   when data is sparse — omits dimensions with no data rather than guessing.
 *
 * Triggered by: signalWeightsWorker.js (weekly, LAST — synthesizes all other agents)
 */

const { supabaseAdmin }     = require('../services/supabaseService');
const { getAgentDirective } = require('../services/agentDirectiveService');

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ----------------------------------------------------------------
// scoreHookFormats — returns { format: score } map from hook_formats
// + hook_trends + content_fatigue.
// ----------------------------------------------------------------
function scoreHookFormats(sw) {
  const formats = sw.hook_formats || {};
  const trends  = sw.hook_trends  || {};
  const fatigue = sw.content_fatigue?.by_hook_format || {};

  const scores = {};
  const knownFormats = new Set([
    ...Object.keys(formats),
    ...Object.keys(trends)
  ]);

  for (const fmt of knownFormats) {
    let score = formats[fmt] || 1.0;  // multiplier, default neutral

    // Trend bonus/penalty
    const trend = trends[fmt];
    if (trend?.direction === 'up')   score *= 1.2;
    if (trend?.direction === 'down') score *= 0.8;

    // Fatigue penalty — hard discourage
    if (fatigue[fmt]?.fatigued) score *= 0.1;

    scores[fmt] = Math.round(score * 100) / 100;
  }

  return scores;
}

// ----------------------------------------------------------------
// scorePostTypes — returns { type: score } from comment_signals
// and content_fatigue.
// ----------------------------------------------------------------
function scorePostTypes(sw) {
  const commentsByType = sw.comment_signals?.by_post_type || {};
  const fatigue        = sw.content_fatigue?.by_post_type || {};

  const scores = {};
  const knownTypes = new Set([
    ...Object.keys(commentsByType),
    ...Object.keys(fatigue)
  ]);

  for (const type of knownTypes) {
    let score = 1.0;

    // Comment signal boost — types that generate questions/requests score higher
    // (indicates audience engagement and purchase intent)
    const intents = commentsByType[type] || {};
    if (intents.question) score *= Math.min(1 + (intents.question - 1) * 0.3, 2.0);
    if (intents.request)  score *= Math.min(1 + (intents.request  - 1) * 0.4, 2.0);
    if (intents.complaint) score *= Math.max(1 - (intents.complaint - 1) * 0.3, 0.3);

    // Fatigue penalty
    if (fatigue[type]?.fatigued) score *= 0.1;

    scores[type] = Math.round(score * 100) / 100;
  }

  return scores;
}

// ----------------------------------------------------------------
// scoreTones — returns { tone: score } from tone_objective_fit
// and content_fatigue.by_tone.
// ----------------------------------------------------------------
function scoreTones(sw) {
  const toneObjectiveFit = sw.tone_objective_fit || {};
  const fatigue          = sw.content_fatigue?.by_tone || {};

  const scores = {};

  // Extract per-tone best multiplier from tone_objective_fit
  // (keys are like "bold_conversions" — we want the best score per tone)
  for (const [key, multiplier] of Object.entries(toneObjectiveFit)) {
    const tone = key.split('_')[0];
    if (!scores[tone] || multiplier > scores[tone]) {
      scores[tone] = multiplier;
    }
  }

  // Apply fatigue penalty
  for (const [tone, data] of Object.entries(fatigue)) {
    if (data.fatigued) {
      scores[tone] = (scores[tone] || 1.0) * 0.1;
    }
  }

  // Round
  for (const tone of Object.keys(scores)) {
    scores[tone] = Math.round(scores[tone] * 100) / 100;
  }

  return scores;
}

// ----------------------------------------------------------------
// bestEntry — returns the key with the highest value in an object.
// Returns null if the object is empty.
// ----------------------------------------------------------------
function bestEntry(scores) {
  const entries = Object.entries(scores);
  if (entries.length === 0) return null;
  return entries.sort((a, b) => b[1] - a[1])[0][0];
}

// ----------------------------------------------------------------
// runBriefOptimization — main export.
// ----------------------------------------------------------------
async function runBriefOptimization(userId) {
  console.log(`[BriefOptimizationAgent] Synthesising brief recommendation for user ${userId}...`);

  const directive = await getAgentDirective('briefOptimizationAgent', userId);

  // --- Read current signal_weights ---
  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('signal_weights')
    .eq('user_id', userId)
    .single();

  const sw = profile?.signal_weights;
  if (!sw || typeof sw !== 'object' || Object.keys(sw).length === 0) {
    console.log(`[BriefOptimizationAgent] No signal_weights yet for ${userId}. Skipping.`);
    return;
  }

  // Track how many distinct signal sources contributed
  let signalCount = 0;

  // --- Score all dimensions ---
  const hookScores = scoreHookFormats(sw);
  const typeScores = scorePostTypes(sw);
  const toneScores = scoreTones(sw);

  if (Object.keys(hookScores).length > 0) signalCount++;
  if (sw.hook_trends     && Object.keys(sw.hook_trends).length > 0)    signalCount++;
  if (Object.keys(typeScores).length > 0) signalCount++;
  if (Object.keys(toneScores).length > 0) signalCount++;
  if (sw.cta_effectiveness) signalCount++;
  if (sw.best_hours)        signalCount++;
  if (sw.algorithm_alerts?.length > 0) signalCount++;
  if (sw.content_fatigue)   signalCount++;

  // --- Pick best values per dimension ---
  const recommendedHookFormat = bestEntry(hookScores);
  const recommendedPostType   = bestEntry(typeScores);
  const recommendedTone       = bestEntry(toneScores);

  // Best CTA format by trigger_rate
  let recommendedCtaFormat = sw.cta_effectiveness?.best_cta_format || null;

  // Best posting time
  const bestHours = sw.best_hours;
  const recommendedPostDay  = Array.isArray(bestHours?.best_days) && bestHours.best_days.length > 0
    ? bestHours.best_days[0]
    : null;
  const recommendedPostHour = Array.isArray(bestHours?.overall) && bestHours.overall.length > 0
    ? bestHours.overall[0]
    : null;

  // --- Composite score for this combination (vs neutral baseline of 1.0) ---
  const hookScore = (recommendedHookFormat && hookScores[recommendedHookFormat]) || 1.0;
  const typeScore = (recommendedPostType   && typeScores[recommendedPostType])   || 1.0;
  const toneScore = (recommendedTone       && toneScores[recommendedTone])       || 1.0;
  const compositeScore = Math.round(hookScore * typeScore * toneScore * 10) / 10;

  // --- Collect avoid patterns (fatigued dimensions) ---
  const avoidPatterns = [];

  const fatigueByHook = sw.content_fatigue?.by_hook_format || {};
  const fatigueByType = sw.content_fatigue?.by_post_type   || {};
  const fatigueByTone = sw.content_fatigue?.by_tone        || {};

  Object.entries(fatigueByHook).forEach(([fmt, d])  => { if (d.fatigued) avoidPatterns.push(`${fmt} hooks`); });
  Object.entries(fatigueByType).forEach(([type, d]) => { if (d.fatigued) avoidPatterns.push(`${type} posts`); });
  Object.entries(fatigueByTone).forEach(([tone, d]) => { if (d.fatigued) avoidPatterns.push(`${tone} tone`); });

  // Add algorithm-driven format penalties
  (sw.algorithm_alerts || []).forEach(alert => {
    Object.entries(alert.format_signals || {}).forEach(([type, sig]) => {
      if (sig.type === 'penalty' && !avoidPatterns.includes(`${type} posts`)) {
        avoidPatterns.push(`${type} posts (algorithm suppressed on ${alert.platform})`);
      }
    });
  });

  // --- Confidence level based on how many signals fed the synthesis ---
  const confidence = signalCount >= 5 ? 'high' : signalCount >= 3 ? 'medium' : 'low';

  // --- Build the optimization object ---
  // Only include dimensions we actually have data for
  const briefOptimization = { composite_score: compositeScore, signal_count: signalCount, confidence };

  if (recommendedHookFormat) briefOptimization.recommended_hook_format = recommendedHookFormat;
  if (recommendedPostType)   briefOptimization.recommended_post_type   = recommendedPostType;
  if (recommendedTone)       briefOptimization.recommended_tone        = recommendedTone;
  if (recommendedCtaFormat)  briefOptimization.recommended_cta_format  = recommendedCtaFormat;
  if (recommendedPostDay  !== null) briefOptimization.recommended_post_day  = recommendedPostDay;
  if (recommendedPostHour !== null) briefOptimization.recommended_post_hour = recommendedPostHour;
  if (avoidPatterns.length > 0)     briefOptimization.avoid_patterns        = avoidPatterns;

  // --- Merge into signal_weights ---
  const updated = {
    ...sw,
    brief_optimization:             briefOptimization,
    brief_optimization_updated_at:  new Date().toISOString(),
    ...(directive ? { agent_directive_brief_opt: directive } : {})
  };

  const { error: updateErr } = await supabaseAdmin
    .from('user_profiles')
    .update({ signal_weights: updated })
    .eq('user_id', userId);

  if (updateErr) {
    console.error(`[BriefOptimizationAgent] Failed to save for ${userId}:`, updateErr.message);
    return;
  }

  const hourLabel = h => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;
  const summary = [
    recommendedHookFormat && `hook:${recommendedHookFormat}`,
    recommendedPostType   && `type:${recommendedPostType}`,
    recommendedTone       && `tone:${recommendedTone}`,
    recommendedPostDay  !== null && `day:${DAY_NAMES[recommendedPostDay]}`,
    recommendedPostHour !== null && `hour:${hourLabel(recommendedPostHour)}`,
  ].filter(Boolean).join(' | ');

  console.log(`[BriefOptimizationAgent] ${userId} — ${summary} | score:${compositeScore} confidence:${confidence} (${signalCount} signals)`);
}

module.exports = { runBriefOptimization };
