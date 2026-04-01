/**
 * agents/commentSentimentAgent.js
 *
 * Layer 2 Learning Agent — Comment Signal Analysis.
 *
 * WHAT THIS DOES:
 * commentAgent.js already ingests and stores comments with a basic
 * positive/neutral/negative sentiment tag. This agent goes further:
 * it reads those stored comments, applies richer intent classification
 * (question / request / complaint / praise / curiosity), then correlates
 * each signal back to the *type of post* that generated it.
 *
 * The result tells the LLM things like:
 *   "educational posts generate 3.2x more questions than average — your
 *    audience is in learning mode when you post how-to content."
 *   "promotional posts generate 1.8x more requests ('where can I buy?') —
 *    your audience is converting."
 *   "controversial posts generate 2.4x more complaints — avoid for your niche."
 *
 * INTENT CLASSIFICATION (5 buckets):
 *   question   — comment ends with "?" or contains question words (how, why, where, when, what, who, can you, do you)
 *   request    — contains buying/info-seeking signals (where to buy, how much, link, price, DM me, send me)
 *   complaint  — matches negative keywords or frustration patterns
 *   praise     — matches positive keywords (love, amazing, thank you, etc.)
 *   curiosity  — open-ended interest without clear question or purchase signal
 *                (tell me more, interesting, I never knew, didn't know that)
 *
 * WHY THIS IS VALUABLE:
 *   — A post that gets lots of QUESTIONS means the topic resonated but left
 *     the audience wanting more → signal to create follow-up content
 *   — A post that gets lots of REQUESTS means purchase intent is high →
 *     signal to increase promotional content around that topic/time
 *   — A post that gets lots of COMPLAINTS → avoid that tone/topic combo
 *   — This data compounds: the more comments ingested, the more reliable
 *     the signal. Even 20-30 comments is enough to start seeing patterns.
 *
 * WHAT IT WRITES (signal_weights.comment_signals):
 *   {
 *     "comment_signals": {
 *       "by_post_type": {
 *         "educational":  { "question": 3.2, "praise": 1.4, "request": 0.8 },
 *         "promotional":  { "request": 1.8, "praise": 1.1 }
 *       },
 *       "by_tone": {
 *         "bold":         { "praise": 2.1, "curiosity": 1.3 },
 *         "controversial":{ "complaint": 2.4 }
 *       },
 *       "top_question_topics":  ["pricing", "how to", "where to find"],
 *       "top_request_topics":   ["pricing", "demo", "link"]
 *     }
 *   }
 *
 * MULTIPLIER FORMULA:
 *   For each post_type × intent combo:
 *     ratio = (intent_count_for_type / total_comments_for_type)
 *           / (intent_count_overall / total_comments_overall)
 *   ratio > 1.0 = this post type generates MORE of this intent than average
 *   ratio < 1.0 = this post type generates LESS of this intent than average
 *   Only ratios above MIN_RATIO_THRESHOLD (0.5) or below its inverse are stored
 *   to avoid cluttering signal_weights with noise.
 *
 * MINIMUM DATA:
 *   — 20 total comments with intent data to run (enough for ratios to be meaningful)
 *   — 5 comments per post_type to include that type in the breakdown
 *
 * TOPIC EXTRACTION:
 *   Simple n-gram frequency — no LLM needed. Pulls the 3 most common
 *   2-3 word phrases from question and request comments as topic hints.
 *
 * Triggered by: signalWeightsWorker.js (weekly, after postTypeCalendarAgent)
 */

const { supabaseAdmin }     = require('../services/supabaseService');
const { getAgentDirective } = require('../services/agentDirectiveService');

const MIN_COMMENTS_OVERALL  = 20;
const MIN_COMMENTS_PER_TYPE = 5;
const MIN_RATIO_THRESHOLD   = 0.5;  // Only store ratios outside 0.5–2.0 range
const MAX_RATIO_THRESHOLD   = 2.0;
const TOP_TOPICS            = 3;

// ----------------------------------------------------------------
// classifyIntent — assigns a comment text to one intent bucket.
// Returns: 'question' | 'request' | 'complaint' | 'praise' | 'curiosity'
//
// Order matters: question and request are checked first because they
// represent high-value signals (intent to learn / intent to buy).
// ----------------------------------------------------------------
function classifyIntent(text) {
  if (!text) return 'curiosity';
  const t = text.toLowerCase().trim();

  // Question: ends with "?" or contains explicit question openers
  if (
    t.endsWith('?') ||
    /\b(how (do|can|does|did|would|should)|why (is|are|do|would)|where (can|do|is|are)|when (is|are|do|can)|what (is|are|do|can)|who (is|are|can)|can you|do you (have|offer|ship|sell)|is there)\b/.test(t)
  ) {
    return 'question';
  }

  // Request: purchase or info-seeking signals
  if (
    /\b(where (to buy|can i get|to find|to order)|how much|what('s| is) the price|how to (get|order|buy|sign up)|send (me|the link)|dm me|drop (the )?link|link (in bio|please|pls)|price|pricing|cost|available|get (this|yours|it)|i want (this|one|it)|need (this|one|it)|sign me up|how (do i|can i) (get|join|buy|order))\b/.test(t)
  ) {
    return 'request';
  }

  // Complaint: frustration or negative feedback signals
  if (
    /\b(hate|terrible|awful|horrible|worst|scam|fake|ridiculous|disappointed|waste|broken|doesn'?t work|rip.?off|misleading|false|lies?|stop|unfollow|spam|clickbait|not true|wrong|incorrect|doesn'?t make sense)\b/.test(t)
  ) {
    return 'complaint';
  }

  // Praise: positive reinforcement
  if (
    /\b(love|amazing|awesome|fantastic|excellent|perfect|wonderful|helpful|thank(s| you)|incredible|brilliant|superb|outstanding|great (post|content|tip|advice)|so (good|helpful|useful|true)|this is (so|really|exactly)|exactly what i (needed|was looking for)|saved (me|my)|changed (my|the)|mind blown|game.?changer)\b/.test(t)
  ) {
    return 'praise';
  }

  // Default: curiosity / neutral interest
  return 'curiosity';
}

// ----------------------------------------------------------------
// extractTopics — pulls the most frequent 2-3 word phrases from
// a list of comment texts. Used for top_question_topics and
// top_request_topics — gives admin a quick read on *what* the
// audience is asking/requesting without reading every comment.
// ----------------------------------------------------------------
function extractTopics(commentTexts, topN) {
  const freq = {};

  commentTexts.forEach(text => {
    if (!text) return;
    const words = text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);

    // Count 2-grams and 3-grams
    for (let len = 2; len <= 3; len++) {
      for (let i = 0; i <= words.length - len; i++) {
        const phrase = words.slice(i, i + len).join(' ');
        // Skip phrases made entirely of stop words
        if (/^(the|and|for|are|this|that|you|your|how|what|can|its|with|have|was|but|not|from|they|will|more|all|been|has|she|her|his|him|who|did|does|where|when|why|which|there|their|them|then|than|into|over|after|just|like|some|would|could|should|very|also|about|would|should|said|each|many|such|much|even|most|these|those|both|here|been)(\s(the|and|for|are|this|that|you|your|how|what|can|its|with|have|was|but|not|from|they|will|more|all|been|has|she|her|his|him|who|did|does|where|when|why|which|there|their|them|then|than|into|over|after|just|like|some|would|could|should|very|also|about|would|should|said|each|many|such|much|even|most|these|those|both|here|been))*$/.test(phrase)) continue;
        freq[phrase] = (freq[phrase] || 0) + 1;
      }
    }
  });

  return Object.entries(freq)
    .filter(([, count]) => count >= 2)  // Must appear at least twice
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([phrase]) => phrase);
}

// ----------------------------------------------------------------
// runCommentSentimentAnalysis — main export.
// ----------------------------------------------------------------
async function runCommentSentimentAnalysis(userId) {
  console.log(`[CommentSentimentAgent] Analysing comment signals for user ${userId}...`);

  const directive = await getAgentDirective('commentSentimentAgent', userId);

  const cutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

  // --- Step 1: Get post_comments for this user's posts in last 60 days ---
  // We join via posts to scope to this user (post_comments has post_id, not user_id).
  // Two-step query: posts first, then comments — avoids PostgREST FK join issues.
  const { data: posts, error: postsErr } = await supabaseAdmin
    .from('posts')
    .select('id, brief_id')
    .eq('user_id', userId)
    .eq('status', 'published')
    .gte('published_at', cutoff);

  if (postsErr || !posts || posts.length === 0) {
    console.log(`[CommentSentimentAgent] No posts for ${userId}. Skipping.`);
    return;
  }

  const postIds = posts.map(p => p.id);

  const { data: comments, error: commentsErr } = await supabaseAdmin
    .from('post_comments')
    .select('post_id, comment_text, sentiment')
    .in('post_id', postIds)
    .not('comment_text', 'is', null);

  if (commentsErr || !comments || comments.length < MIN_COMMENTS_OVERALL) {
    console.log(`[CommentSentimentAgent] Not enough comments for ${userId} (${comments?.length || 0}). Skipping.`);
    return;
  }

  // --- Step 2: Fetch post_type from briefs for posts that have one ---
  const briefIds = [...new Set(posts.map(p => p.brief_id).filter(Boolean))];
  const briefMap = {};  // post_id → { post_type, tone }

  if (briefIds.length > 0) {
    const { data: briefs } = await supabaseAdmin
      .from('briefs')
      .select('id, post_type, tone')
      .in('id', briefIds);

    (briefs || []).forEach(b => { briefMap[b.id] = { post_type: b.post_type, tone: b.tone }; });
  }

  // Build post_id → brief metadata map for quick lookup
  const postMeta = {};
  posts.forEach(p => {
    if (p.brief_id && briefMap[p.brief_id]) {
      postMeta[p.id] = briefMap[p.brief_id];
    }
  });

  // --- Step 3: Classify each comment's intent ---
  const classified = comments.map(c => ({
    post_id:    c.post_id,
    intent:     classifyIntent(c.comment_text),
    text:       c.comment_text,
    post_type:  postMeta[c.post_id]?.post_type || null,
    tone:       postMeta[c.post_id]?.tone       || null
  }));

  const total = classified.length;

  // --- Step 4: Calculate overall intent distribution ---
  const overallIntentCounts = {};
  classified.forEach(c => {
    overallIntentCounts[c.intent] = (overallIntentCounts[c.intent] || 0) + 1;
  });

  // --- Step 5: Build per-post-type and per-tone intent ratios ---
  // Group comments by post_type
  const byPostType = {};
  const byTone     = {};

  classified.forEach(c => {
    if (c.post_type) {
      if (!byPostType[c.post_type]) byPostType[c.post_type] = [];
      byPostType[c.post_type].push(c);
    }
    if (c.tone) {
      if (!byTone[c.tone]) byTone[c.tone] = [];
      byTone[c.tone].push(c);
    }
  });

  // For each post_type, calculate ratio vs overall baseline for each intent
  const commentSignalsByPostType = {};
  for (const [postType, typeComments] of Object.entries(byPostType)) {
    if (typeComments.length < MIN_COMMENTS_PER_TYPE) continue;

    const typeTotal = typeComments.length;
    const typeIntentCounts = {};
    typeComments.forEach(c => {
      typeIntentCounts[c.intent] = (typeIntentCounts[c.intent] || 0) + 1;
    });

    const ratios = {};
    for (const [intent, typeCount] of Object.entries(typeIntentCounts)) {
      const typeRate    = typeCount / typeTotal;
      const overallRate = (overallIntentCounts[intent] || 0) / total;
      if (overallRate === 0) continue;

      const ratio = Math.round((typeRate / overallRate) * 10) / 10;  // 1 decimal place
      // Only store signals that deviate meaningfully from average
      if (ratio < MIN_RATIO_THRESHOLD || ratio > MAX_RATIO_THRESHOLD) {
        ratios[intent] = ratio;
      } else if (ratio >= 1.3) {
        // Also store moderate overperformance — useful positive signal
        ratios[intent] = ratio;
      }
    }

    if (Object.keys(ratios).length > 0) {
      commentSignalsByPostType[postType] = ratios;
    }
  }

  // Same ratio calculation for tone
  const commentSignalsByTone = {};
  for (const [tone, toneComments] of Object.entries(byTone)) {
    if (toneComments.length < MIN_COMMENTS_PER_TYPE) continue;

    const toneTotal = toneComments.length;
    const toneIntentCounts = {};
    toneComments.forEach(c => {
      toneIntentCounts[c.intent] = (toneIntentCounts[c.intent] || 0) + 1;
    });

    const ratios = {};
    for (const [intent, toneCount] of Object.entries(toneIntentCounts)) {
      const toneRate    = toneCount / toneTotal;
      const overallRate = (overallIntentCounts[intent] || 0) / total;
      if (overallRate === 0) continue;

      const ratio = Math.round((toneRate / overallRate) * 10) / 10;
      if (ratio < MIN_RATIO_THRESHOLD || ratio >= 1.3) {
        ratios[intent] = ratio;
      }
    }

    if (Object.keys(ratios).length > 0) {
      commentSignalsByTone[tone] = ratios;
    }
  }

  // --- Step 6: Extract top topic phrases from question + request comments ---
  const questionTexts = classified.filter(c => c.intent === 'question').map(c => c.text);
  const requestTexts  = classified.filter(c => c.intent === 'request').map(c => c.text);

  const topQuestionTopics = extractTopics(questionTexts, TOP_TOPICS);
  const topRequestTopics  = extractTopics(requestTexts,  TOP_TOPICS);

  // --- Step 7: Merge into signal_weights ---
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
    comment_signals: {
      by_post_type:        commentSignalsByPostType,
      by_tone:             commentSignalsByTone,
      top_question_topics: topQuestionTopics,
      top_request_topics:  topRequestTopics
    },
    comment_signals_updated_at:    new Date().toISOString(),
    comment_signals_total_comments: total,
    ...(directive ? { agent_directive_comments: directive } : {})
  };

  const { error: updateErr } = await supabaseAdmin
    .from('user_profiles')
    .update({ signal_weights: updated })
    .eq('user_id', userId);

  if (updateErr) {
    console.error(`[CommentSentimentAgent] Failed to save for ${userId}:`, updateErr.message);
    return;
  }

  const typeCount    = Object.keys(commentSignalsByPostType).length;
  const toneCount    = Object.keys(commentSignalsByTone).length;
  const topQStr      = topQuestionTopics.join(', ') || 'none';
  const topReqStr    = topRequestTopics.join(', ')  || 'none';

  console.log(`[CommentSentimentAgent] ${userId} — ${total} comments analysed | ${typeCount} post types | ${toneCount} tones | Top questions: ${topQStr} | Top requests: ${topReqStr}`);
}

module.exports = { runCommentSentimentAnalysis, classifyIntent };
