/**
 * agents/contentGapAgent.js
 *
 * Layer 4 Synthesis Agent — Content Gap Detection.
 *
 * WHAT THIS DOES:
 * Finds what the audience is ASKING FOR that the user has never — or rarely —
 * posted about. This is the simplest, highest-ROI brief suggestion you can make:
 * the audience is already telling you what they want. You're just not listening.
 *
 * Example outputs:
 *   "Your audience asks about pricing in 34% of question comments.
 *    You have 0 promotional posts in the last 90 days. That's a gap."
 *
 *   "Your audience frequently requests links/demos (top request topic).
 *    You have never used a comment_keyword CTA. Your DM automation is untapped."
 *
 *   "Educational posts generate 3x more questions than any other type.
 *    But 80% of your recent content is promotional. Your audience wants education."
 *
 * WHAT IT CROSS-REFERENCES:
 *
 *   Source A — comment_signals (from commentSentimentAgent):
 *     — top_question_topics:  what the audience asks about
 *     — top_request_topics:   what the audience actively wants
 *     — by_post_type ratios:  which content types generate the most intent signals
 *
 *   Source B — post history (from DB):
 *     — post_type distribution in the last 90 days
 *     — CTA format distribution (what kinds of CTAs the user actually uses)
 *
 *   Source C — cta_effectiveness (from ctaEffectivenessAgent):
 *     — best CTA format the user hasn't tried or underuses
 *
 * GAP DETECTION LOGIC (three gap types):
 *
 *   TYPE 1 — POST TYPE GAP
 *   A post type that generates disproportionate question/request comments
 *   (ratio > 1.5x from comment_signals.by_post_type) but makes up < 15% of
 *   the user's recent posts. The audience wants this content and isn't getting it.
 *
 *   TYPE 2 — TOPIC GAP
 *   top_question_topics or top_request_topics contain phrases that don't appear
 *   in any recent post's hook or caption text. The audience is asking about
 *   something the user has never addressed.
 *   (Note: we check post text in the DB, not via LLM — simple substring match
 *    against the top phrases. Fast, free, good enough for gap signals.)
 *
 *   TYPE 3 — CTA GAP
 *   The best-performing CTA format (from cta_effectiveness) is one the user
 *   rarely or never uses. Or: the user never uses comment_keyword CTAs despite
 *   having DM automations set up — the automation is sitting idle.
 *
 * WHAT IT WRITES (signal_weights.content_gaps):
 *   {
 *     "content_gaps": [
 *       {
 *         "type":        "post_type_gap",
 *         "gap":         "educational",
 *         "evidence":    "generates 3.2x more question comments but only 8% of your recent posts",
 *         "action":      "Create more educational content — your audience is in learning mode"
 *       },
 *       {
 *         "type":        "topic_gap",
 *         "gap":         "pricing options",
 *         "evidence":    "appears in 34% of your question comments but not in any recent post",
 *         "action":      "Address pricing directly — your audience needs this answered"
 *       },
 *       {
 *         "type":        "cta_gap",
 *         "gap":         "comment_keyword",
 *         "evidence":    "your best-performing CTA format (4.2 triggers/1K reach) — you've used it in 0 posts",
 *         "action":      "Add a comment_keyword CTA to your next post to activate your DM automation"
 *       }
 *     ]
 *   }
 *
 * WHAT THE LLM SEES (via contextBuilder):
 *   CONTENT GAPS (what your audience wants that you're not giving them):
 *   • Post type gap: educational content generates 3.2x more questions but is only 8% of your posts
 *     → Create more educational content — your audience is in learning mode
 *   • Topic gap: "pricing options" appears in 34% of comments but never in your posts
 *     → Address pricing directly — your audience needs this answered
 *
 * MINIMUM DATA:
 *   Requires comment_signals in signal_weights to run (from commentSentimentAgent).
 *   Post history check requires at least 10 posts in the last 90 days.
 *
 * Triggered by: signalWeightsWorker.js (weekly, after briefOptimizationAgent)
 */

const { supabaseAdmin }     = require('../services/supabaseService');
const { getAgentDirective } = require('../services/agentDirectiveService');

const GAP_POST_TYPE_THRESHOLD = 0.15;  // < 15% of posts = underused post type
const GAP_COMMENT_RATIO       = 1.5;   // comment intent ratio > 1.5x = high demand
const MIN_POSTS_FOR_HISTORY   = 10;

// ----------------------------------------------------------------
// runContentGapAnalysis — main export.
// ----------------------------------------------------------------
async function runContentGapAnalysis(userId) {
  console.log(`[ContentGapAgent] Detecting content gaps for user ${userId}...`);

  const directive = await getAgentDirective('contentGapAgent', userId);

  // --- Read signal_weights ---
  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('signal_weights')
    .eq('user_id', userId)
    .single();

  const sw = profile?.signal_weights;

  // Need at minimum comment_signals to detect gaps
  if (!sw?.comment_signals) {
    console.log(`[ContentGapAgent] No comment_signals for ${userId} yet. Skipping.`);
    return;
  }

  const cs  = sw.comment_signals;
  const cta = sw.cta_effectiveness;

  const gaps = [];

  // ---------------------------------------------------------------
  // Source B: Post history — type distribution + CTA distribution
  // ---------------------------------------------------------------
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

  const { data: recentPosts } = await supabaseAdmin
    .from('posts')
    .select('id, brief_id, cta, hook, caption')
    .eq('user_id', userId)
    .eq('status', 'published')
    .gte('published_at', cutoff);

  const totalPosts = (recentPosts || []).length;

  // Fetch brief metadata for post_type
  const briefIds = [...new Set((recentPosts || []).map(p => p.brief_id).filter(Boolean))];
  const briefMap = {};

  if (briefIds.length > 0) {
    const { data: briefs } = await supabaseAdmin
      .from('briefs')
      .select('id, post_type')
      .in('id', briefIds);
    (briefs || []).forEach(b => { briefMap[b.id] = b.post_type; });
  }

  // Post type frequency
  const typeFreq = {};
  (recentPosts || []).forEach(post => {
    const type = post.brief_id ? briefMap[post.brief_id] : null;
    if (type) typeFreq[type] = (typeFreq[type] || 0) + 1;
  });

  // All post text for topic matching (hook + caption concatenated)
  const allPostText = (recentPosts || [])
    .map(p => `${p.hook || ''} ${p.caption || ''}`.toLowerCase())
    .join(' ');

  // ---------------------------------------------------------------
  // GAP TYPE 1: Post type gaps
  // ---------------------------------------------------------------
  if (totalPosts >= MIN_POSTS_FOR_HISTORY && cs.by_post_type) {
    for (const [postType, intents] of Object.entries(cs.by_post_type)) {
      // Check if this post type drives strong intent signals
      const topIntent = Object.entries(intents).sort((a, b) => b[1] - a[1])[0];
      if (!topIntent || topIntent[1] < GAP_COMMENT_RATIO) continue;

      // Check how often the user actually posts this type
      const typeCount  = typeFreq[postType] || 0;
      const typeShare  = totalPosts > 0 ? typeCount / totalPosts : 0;

      if (typeShare < GAP_POST_TYPE_THRESHOLD) {
        const pct = Math.round(typeShare * 100);
        const ratio = topIntent[1];
        gaps.push({
          type:     'post_type_gap',
          gap:      postType,
          evidence: `generates ${ratio}x more ${topIntent[0]} comments but only ${pct}% of your recent posts`,
          action:   `Create more ${postType} content — your audience is showing high ${topIntent[0]} intent on it`
        });
      }
    }
  }

  // ---------------------------------------------------------------
  // GAP TYPE 2: Topic gaps
  // ---------------------------------------------------------------
  // Check if top question/request topics appear in any recent post text
  const topicSources = [
    { topics: cs.top_question_topics || [], label: 'question comments' },
    { topics: cs.top_request_topics  || [], label: 'request comments'  }
  ];

  for (const { topics, label } of topicSources) {
    for (const topic of topics) {
      if (!topic || topic.length < 3) continue;

      // Simple substring match — if the topic phrase doesn't appear in any
      // recent post text, it's a gap. Not perfect but zero cost and useful.
      const appearsInPosts = allPostText.includes(topic.toLowerCase());

      if (!appearsInPosts) {
        // Estimate frequency from comment count (rough — we don't have exact per-topic counts,
        // only the ranked list from commentSentimentAgent's n-gram extraction)
        const rank = topics.indexOf(topic) + 1;  // 1 = most common
        const freqDesc = rank === 1 ? 'most commonly' : rank === 2 ? 'frequently' : 'often';

        gaps.push({
          type:     'topic_gap',
          gap:      topic,
          evidence: `${freqDesc} appears in your ${label} but not addressed in any recent post`,
          action:   `Address "${topic}" directly in a future post — your audience keeps asking about it`
        });
      }
    }
  }

  // ---------------------------------------------------------------
  // GAP TYPE 3: CTA gaps
  // ---------------------------------------------------------------
  if (cta?.best_cta_format) {
    const bestFormat    = cta.best_cta_format;
    const bestStats     = cta.by_format?.[bestFormat];

    // Check how often the user uses this CTA format in recent posts
    const { classifyCtaFormat } = require('./ctaEffectivenessAgent');
    const ctaUsage = {};
    (recentPosts || []).forEach(post => {
      const fmt = classifyCtaFormat(post.cta);
      ctaUsage[fmt] = (ctaUsage[fmt] || 0) + 1;
    });

    const bestFormatCount = ctaUsage[bestFormat] || 0;
    const bestFormatShare = totalPosts > 0 ? bestFormatCount / totalPosts : 0;

    // Flag if the best-performing CTA format is used in < 20% of posts
    if (bestFormatShare < 0.20 && bestStats) {
      const usageDesc = bestFormatCount === 0
        ? 'you have never used this CTA format'
        : `you only use it in ${Math.round(bestFormatShare * 100)}% of posts`;

      const statsDesc = [
        bestStats.trigger_rate > 0 ? `${bestStats.trigger_rate} DM triggers/1K reach` : null,
        bestStats.completion_rate > 0 ? `${Math.round(bestStats.completion_rate * 100)}% DM completion` : null
      ].filter(Boolean).join(', ');

      gaps.push({
        type:     'cta_gap',
        gap:      bestFormat,
        evidence: `your best-performing CTA format (${statsDesc}) — ${usageDesc}`,
        action:   `Use a ${bestFormat.replace(/_/g, ' ')} CTA in your next post to maximise DM conversions`
      });
    }
  }

  if (gaps.length === 0) {
    console.log(`[ContentGapAgent] No significant gaps detected for ${userId}.`);
    // Still write an empty array so contextBuilder knows the agent has run
  }

  // --- Merge into signal_weights ---
  const updated = {
    ...sw,
    content_gaps:             gaps,
    content_gaps_updated_at:  new Date().toISOString(),
    ...(directive ? { agent_directive_gaps: directive } : {})
  };

  const { error: updateErr } = await supabaseAdmin
    .from('user_profiles')
    .update({ signal_weights: updated })
    .eq('user_id', userId);

  if (updateErr) {
    console.error(`[ContentGapAgent] Failed to save for ${userId}:`, updateErr.message);
    return;
  }

  console.log(`[ContentGapAgent] ${userId} — ${gaps.length} gap(s) detected: ${gaps.map(g => `${g.type}:${g.gap}`).join(', ') || 'none'}`);
}

module.exports = { runContentGapAnalysis };
