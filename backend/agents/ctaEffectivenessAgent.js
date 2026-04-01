/**
 * agents/ctaEffectivenessAgent.js
 *
 * Layer 2 Learning Agent — CTA Effectiveness Analysis.
 *
 * WHAT THIS DOES:
 * Analyses which Call-To-Action formats actually drive action — not just
 * engagement (likes/comments), but the downstream signals that matter most:
 * DM triggers, DM conversation completions, and lead capture.
 *
 * This agent bridges two systems that currently don't talk to each other:
 *   — The post generation system (which writes CTA text onto posts)
 *   — The DM automation system (which fires when comments trigger keywords)
 *
 * By connecting them through post_id, we can answer: when a CTA says
 * "comment GUIDE below", how often does that actually result in a completed
 * DM conversation? Which CTA *formats* are most effective?
 *
 * THREE CONVERSION SIGNALS (in order of value):
 *
 *   1. DM trigger rate — comments on a post that matched a DM trigger keyword
 *      divided by post reach. High trigger rate = CTA successfully got people
 *      to take an action (comment a keyword). Formula:
 *        trigger_rate = trigger_matched_comments / reach × 1000  (per 1K reach)
 *
 *   2. DM completion rate — of the DM conversations started, how many reached
 *      'completed' status. High completion rate = the DM flow converted after
 *      the CTA worked. Formula:
 *        completion_rate = completed_conversations / total_conversations_started
 *
 *   3. Lead capture rate — of completed conversations, how many collected at
 *      least one piece of lead data (email, phone, name). The ultimate signal
 *      — someone went from seeing a post to submitting their info.
 *        lead_rate = conversations_with_lead_data / completed_conversations
 *
 * CTA FORMAT CLASSIFICATION (6 buckets):
 *
 *   comment_keyword  — "comment WORD below", "drop WORD in comments", "reply with WORD"
 *                      Classic comment-trigger CTA. Directly feeds DM automation.
 *
 *   link_in_bio      — "link in bio", "tap the link", "check bio for"
 *                      Drives profile visits. Can't measure click directly — tracked
 *                      indirectly via lower trigger_matched rate (no keyword to match).
 *
 *   dm_direct        — "DM me", "send me a message", "message us", "slide into DMs"
 *                      Direct DM request. May not have a keyword trigger but could
 *                      still start conversations if DM automation is broad.
 *
 *   question_cta     — ends with "?" (a question that invites a comment reply)
 *                      "What's your biggest challenge with X?" — comment bait.
 *                      Drives comment volume but may not trigger DM automation
 *                      unless the automation uses broad keyword matching.
 *
 *   save_share       — "save this", "share with someone who", "bookmark this"
 *                      Drives reach amplification signals. Tracked via shares in
 *                      post_metrics — not DM conversions.
 *
 *   generic          — no strong action pattern detected (default bucket)
 *
 * WHAT IT WRITES (signal_weights.cta_effectiveness):
 *   {
 *     "cta_effectiveness": {
 *       "by_format": {
 *         "comment_keyword": {
 *           "trigger_rate":     4.2,   ← per 1K reach (avg across all posts with this CTA type)
 *           "completion_rate":  0.68,  ← fraction: 68% of DM convos completed
 *           "lead_rate":        0.41,  ← fraction: 41% of completed convos captured a lead
 *           "post_count":       12
 *         },
 *         "question_cta": { ... }
 *       },
 *       "best_cta_format":     "comment_keyword",  ← highest composite score
 *       "top_trigger_phrases": ["comment GUIDE", "drop FREE", "reply YES"]
 *     }
 *   }
 *
 * COMPOSITE SCORE (for ranking formats):
 *   composite = trigger_rate × (1 + completion_rate) × (1 + lead_rate)
 *   Rewards CTAs that trigger DMs AND convert those DMs into leads.
 *   A CTA that gets lots of triggers but zero completions scores lower than
 *   one with moderate triggers but high completion.
 *
 * MINIMUM DATA:
 *   — 5 posts with CTA text + metrics to run
 *   — 3 posts per CTA format to include that format in the breakdown
 *
 * WHAT THE LLM SEES (via contextBuilder):
 *   CTA EFFECTIVENESS (learned from your post conversions):
 *   • comment_keyword CTAs: 4.2 DM triggers per 1K reach | 68% complete | 41% capture leads  ← use this
 *   • question CTAs: 1.1 DM triggers per 1K reach | 22% complete
 *   Best format for your audience: comment_keyword
 *
 * Triggered by: signalWeightsWorker.js (weekly, after commentSentimentAgent)
 */

const { supabaseAdmin }     = require('../services/supabaseService');
const { getAgentDirective } = require('../services/agentDirectiveService');

const MIN_POSTS_OVERALL    = 5;
const MIN_POSTS_PER_FORMAT = 3;

// ----------------------------------------------------------------
// classifyCtaFormat — classifies a CTA string into one of 6 buckets.
// Called for every post's CTA text.
// ----------------------------------------------------------------
function classifyCtaFormat(ctaText) {
  if (!ctaText) return 'generic';
  const t = ctaText.toLowerCase().trim();

  // comment_keyword: explicit instruction to comment a specific word/phrase
  if (
    /\b(comment|drop|reply|type|say|write)\b.{0,30}\b(below|in the comments?|down below|"[a-z]+"|'[a-z]+')\b/.test(t) ||
    /\bcomment\s+[A-Z]{2,}\b/.test(ctaText) ||  // "comment GUIDE" — keyword usually uppercase in raw text
    /\b(drop|type|reply)\s+["']?\w+["']?\s+(below|in the comments?)/i.test(t)
  ) {
    return 'comment_keyword';
  }

  // dm_direct: asks user to send a DM directly
  if (
    /\b(dm (me|us)|send (me|us) a (dm|message)|message (me|us)|slide into (my|our) dms?|inbox (me|us))\b/.test(t)
  ) {
    return 'dm_direct';
  }

  // link_in_bio: drives to profile bio link
  if (
    /\b(link (in|in the) bio|tap (the )?link|click (the )?link|check (the )?bio|visit (my|our) bio|bio link)\b/.test(t)
  ) {
    return 'link_in_bio';
  }

  // save_share: asks for saves or shares
  if (
    /\b(save (this|for later|it)|bookmark (this|it)|share (this|with|it)|tag (a friend|someone|a [a-z]+))\b/.test(t)
  ) {
    return 'save_share';
  }

  // question_cta: ends with a question (invites comment replies)
  if (t.endsWith('?')) {
    return 'question_cta';
  }

  return 'generic';
}

// ----------------------------------------------------------------
// extractTriggerPhrases — from posts with high trigger rates, pulls
// the most common 2-3 word patterns from the CTA text itself.
// Gives the LLM concrete examples of what phrasing worked.
// ----------------------------------------------------------------
function extractTriggerPhrases(ctaTexts, topN) {
  const freq = {};

  ctaTexts.forEach(text => {
    if (!text) return;
    const words = text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1);

    for (let len = 2; len <= 3; len++) {
      for (let i = 0; i <= words.length - len; i++) {
        const phrase = words.slice(i, i + len).join(' ');
        freq[phrase] = (freq[phrase] || 0) + 1;
      }
    }
  });

  return Object.entries(freq)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([phrase]) => phrase);
}

// ----------------------------------------------------------------
// runCtaEffectivenessAnalysis — main export.
// ----------------------------------------------------------------
async function runCtaEffectivenessAnalysis(userId) {
  console.log(`[CtaEffectivenessAgent] Analysing CTA effectiveness for user ${userId}...`);

  const directive = await getAgentDirective('ctaEffectivenessAgent', userId);

  const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

  // --- Step 1: Published posts with a CTA in the last 60 days ---
  const { data: posts, error: postsErr } = await supabaseAdmin
    .from('posts')
    .select('id, cta')
    .eq('user_id', userId)
    .eq('status', 'published')
    .gte('published_at', cutoff)
    .not('cta', 'is', null);

  if (postsErr || !posts || posts.length < MIN_POSTS_OVERALL) {
    console.log(`[CtaEffectivenessAgent] Not enough posts with CTAs for ${userId} (${posts?.length || 0}). Skipping.`);
    return;
  }

  const postIds = posts.map(p => p.id);

  // --- Step 2: Fetch reach from post_metrics (normalisation denominator) ---
  const { data: metrics } = await supabaseAdmin
    .from('post_metrics')
    .select('post_id, reach')
    .in('post_id', postIds);

  // Average reach per post (some posts may have multiple metric rows)
  const reachMap = {};
  (metrics || []).forEach(m => {
    if (!reachMap[m.post_id]) reachMap[m.post_id] = { total: 0, count: 0 };
    reachMap[m.post_id].total += (m.reach || 0);
    reachMap[m.post_id].count++;
  });
  const avgReachMap = {};
  Object.entries(reachMap).forEach(([postId, r]) => {
    avgReachMap[postId] = r.count > 0 ? r.total / r.count : 0;
  });

  // --- Step 3: Fetch DM trigger counts from post_comments ---
  // trigger_matched = true means a DM automation keyword was hit on this comment
  const { data: triggerComments } = await supabaseAdmin
    .from('post_comments')
    .select('post_id')
    .in('post_id', postIds)
    .eq('trigger_matched', true);

  // Count triggers per post
  const triggerCountMap = {};
  (triggerComments || []).forEach(c => {
    triggerCountMap[c.post_id] = (triggerCountMap[c.post_id] || 0) + 1;
  });

  // --- Step 4: Fetch DM conversation outcomes per post ---
  // dm_conversations links to dm_automations which links to post_id
  // Two-step: automations for these posts → conversations for those automations
  const { data: automations } = await supabaseAdmin
    .from('dm_automations')
    .select('id, post_id')
    .in('post_id', postIds)
    .eq('user_id', userId);

  const automationIds = (automations || []).map(a => a.id);
  const automationPostMap = {};  // automation_id → post_id
  (automations || []).forEach(a => { automationPostMap[a.id] = a.post_id; });

  // Conversations for these automations
  const convsByPost = {};  // post_id → { total, completed }
  if (automationIds.length > 0) {
    const { data: conversations } = await supabaseAdmin
      .from('dm_conversations')
      .select('automation_id, status')
      .in('automation_id', automationIds);

    (conversations || []).forEach(conv => {
      const postId = automationPostMap[conv.automation_id];
      if (!postId) return;
      if (!convsByPost[postId]) convsByPost[postId] = { total: 0, completed: 0 };
      convsByPost[postId].total++;
      if (conv.status === 'completed') convsByPost[postId].completed++;
    });
  }

  // --- Step 5: Fetch lead capture counts per post ---
  // dm_collected_data → conversation → automation → post
  // We already have completed conversation counts — check if those conversations
  // collected any lead data by querying dm_collected_data scoped to this user
  const leadsCountMap = {};  // post_id → count of conversations that captured ≥1 lead
  if (automationIds.length > 0) {
    const { data: leadData } = await supabaseAdmin
      .from('dm_collected_data')
      .select('conversation_id')
      .eq('user_id', userId);

    if (leadData && leadData.length > 0) {
      // Get distinct conversation_ids that have lead data
      const convsWithLeads = [...new Set(leadData.map(l => l.conversation_id))];

      // Map those conversations back to posts
      if (convsWithLeads.length > 0) {
        const { data: leadConvs } = await supabaseAdmin
          .from('dm_conversations')
          .select('automation_id')
          .in('id', convsWithLeads);

        (leadConvs || []).forEach(conv => {
          const postId = automationPostMap[conv.automation_id];
          if (!postId) return;
          leadsCountMap[postId] = (leadsCountMap[postId] || 0) + 1;
        });
      }
    }
  }

  // --- Step 6: Build per-CTA-format aggregates ---
  const formatBuckets = {};  // format → { trigger_total, reach_total, completions, total_convs, leads, post_count, cta_texts[] }

  posts.forEach(post => {
    const format  = classifyCtaFormat(post.cta);
    const reach   = avgReachMap[post.id] || 0;
    const triggers = triggerCountMap[post.id] || 0;
    const convData = convsByPost[post.id] || { total: 0, completed: 0 };
    const leads   = leadsCountMap[post.id] || 0;

    // Skip posts with zero reach — can't compute rates
    if (reach === 0) return;

    if (!formatBuckets[format]) {
      formatBuckets[format] = {
        trigger_total:     0,
        reach_total:       0,
        completions:       0,
        total_convs:       0,
        leads:             0,
        post_count:        0,
        cta_texts:         []
      };
    }

    const b = formatBuckets[format];
    b.trigger_total  += triggers;
    b.reach_total    += reach;
    b.completions    += convData.completed;
    b.total_convs    += convData.total;
    b.leads          += leads;
    b.post_count++;

    if (post.cta) b.cta_texts.push(post.cta);
  });

  // --- Step 7: Calculate rates and composite score per format ---
  const byFormat = {};
  let bestFormat = null;
  let bestComposite = -1;

  for (const [format, b] of Object.entries(formatBuckets)) {
    if (b.post_count < MIN_POSTS_PER_FORMAT) continue;

    // trigger_rate: DM triggers per 1,000 reach
    const triggerRate     = b.reach_total > 0
      ? Math.round((b.trigger_total / b.reach_total) * 1000 * 10) / 10
      : 0;

    // completion_rate: fraction of DM convos that completed (0–1)
    const completionRate  = b.total_convs > 0
      ? Math.round((b.completions / b.total_convs) * 100) / 100
      : 0;

    // lead_rate: fraction of completed convos that captured a lead (0–1)
    const leadRate        = b.completions > 0
      ? Math.round((b.leads / b.completions) * 100) / 100
      : 0;

    // Composite score for ranking — rewards full-funnel performance
    const composite = triggerRate * (1 + completionRate) * (1 + leadRate);

    byFormat[format] = {
      trigger_rate:     triggerRate,
      completion_rate:  completionRate,
      lead_rate:        leadRate,
      post_count:       b.post_count
    };

    if (composite > bestComposite) {
      bestComposite = composite;
      bestFormat    = format;
    }
  }

  if (Object.keys(byFormat).length === 0) {
    console.log(`[CtaEffectivenessAgent] Not enough per-format data for ${userId}. Skipping.`);
    return;
  }

  // Top trigger phrases from highest-performing CTA texts
  const bestFormatTexts = bestFormat ? (formatBuckets[bestFormat]?.cta_texts || []) : [];
  const topTriggerPhrases = extractTriggerPhrases(bestFormatTexts, 3);

  // --- Step 8: Merge into signal_weights ---
  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('signal_weights')
    .eq('user_id', userId)
    .single();

  const current = (profile?.signal_weights && typeof profile.signal_weights === 'object')
    ? profile.signal_weights
    : {};

  const updated = {
    ...current,
    cta_effectiveness: {
      by_format:          byFormat,
      best_cta_format:    bestFormat,
      top_trigger_phrases: topTriggerPhrases
    },
    cta_effectiveness_updated_at: new Date().toISOString(),
    ...(directive ? { agent_directive_cta: directive } : {})
  };

  const { error: updateErr } = await supabaseAdmin
    .from('user_profiles')
    .update({ signal_weights: updated })
    .eq('user_id', userId);

  if (updateErr) {
    console.error(`[CtaEffectivenessAgent] Failed to save for ${userId}:`, updateErr.message);
    return;
  }

  const formatCount = Object.keys(byFormat).length;
  const bestStr     = bestFormat
    ? `${bestFormat} (${byFormat[bestFormat]?.trigger_rate}/1K reach, ${Math.round((byFormat[bestFormat]?.completion_rate || 0) * 100)}% complete)`
    : 'none';

  console.log(`[CtaEffectivenessAgent] ${userId} — ${formatCount} CTA formats analysed | Best: ${bestStr}`);
}

module.exports = { runCtaEffectivenessAnalysis, classifyCtaFormat };
