/**
 * data/briefSemantics.js
 *
 * Semantic profiles for brief selections (post type, objective, tone).
 *
 * Used by routes/briefs.js to inject writing style guidance into the LLM
 * prompt at generation time. The frontend (brief.js) holds the full profiles
 * including video clip matching fields (video_energy, ideal_segments, etc.).
 * This file holds only what the LLM needs: llm_style_note per value.
 *
 * When a user submits a brief, the three selected values are looked up here
 * and combined into a single WRITING STYLE GUIDANCE section injected into
 * the user prompt — making every generated post smarter by default.
 */

// ----------------------------------------------------------------
// Post type writing guidance
// Teaches the LLM the narrative structure and content strategy
// appropriate for each type of post.
// ----------------------------------------------------------------
const POST_TYPE_NOTES = {
  educational:
    'Build understanding progressively. Use analogies. Teach one clear concept per post. ' +
    'Avoid information overload — if you can only teach one thing, what is the most valuable?',

  product_launch:
    'Lead with the transformation or result the product creates — not its features. ' +
    'Name the problem it solves in the first line. Build excitement through specificity, ' +
    'not adjectives. Urgency must feel real.',

  behind_the_scenes:
    'Be real and unfiltered. Share the process, the mess, and the learning — not just the ' +
    'highlight reel. First-person perspective creates intimacy. Specific details beat vague ' +
    'impressions every time.',

  lead_generation:
    'Lead with a specific pain point the audience has right now. Promise a clear, concrete ' +
    'outcome — not a vague benefit. Make the CTA extremely specific: "Comment READY" or ' +
    '"DM me the word X" — not "reach out".',

  community_engagement:
    'Make the audience the star, not the brand. Ask a genuine question you actually want ' +
    'answered. The more specific and relatable the question, the more comments it generates. ' +
    'Avoid questions with yes/no answers.',

  promotional:
    'State the offer in the first sentence — never bury it. Use real urgency (actual deadline ' +
    'or limited quantity). Lead with the benefit the audience gets, not the product features. ' +
    'Remove every word of friction between desire and action.',

  story_personal:
    'Open with the moment of tension or turning point — not the backstory. Use specific ' +
    'details: real numbers, real places, real emotions. Vulnerability earns trust faster than ' +
    'expertise. End with the lesson or the invitation.',

  news_update:
    'State the news in the first sentence — never bury the lead. Answer in order: ' +
    'what changed, why it matters to the audience, what they should do now. ' +
    'Brevity signals confidence.'
};

// ----------------------------------------------------------------
// Objective writing guidance
// Shapes the caption structure, CTA style, and hook approach to
// optimize for the specific outcome the user is targeting.
// ----------------------------------------------------------------
const OBJECTIVE_NOTES = {
  engagement:
    'The hook must trigger an immediate emotional reaction — surprise, humor, validation, ' +
    'or a shareable truth. End with a question that is easy to answer in one word or emoji. ' +
    'Rewards and reaction emojis in the CTA ("Drop a ❤️ if this is you") work well here.',

  comments:
    'Make a statement people want to agree with, push back on, or add to. ' +
    '"Controversial but true:" openers and "what would you add?" closers drive comment volume. ' +
    'The post should feel like the start of a conversation, not a finished thought.',

  sharing:
    'Create content that makes people look good or smart for sharing it. High-value information, ' +
    'a relatable truth, or something surprising enough that they want their friends to see it. ' +
    '"Tag someone who needs to hear this" or "Share this with your team" in the CTA.',

  clicks:
    'Tease the full value without giving it all away — open a loop the link closes. ' +
    'Make the CTA specific: "Link in bio to get the free [X]" not just "click the link." ' +
    'The reader should feel they are missing out if they do not click.',

  conversions:
    'Lead with social proof or a specific transformation result. Address the biggest objection ' +
    'before it arises. Urgency must be based on a real constraint (actual deadline, limited spots). ' +
    'Direct, frictionless CTA: book, buy, sign up. No ambiguity about what happens next.',

  awareness:
    'Assume the reader has never heard of this brand. Lead with a universal problem or curiosity ' +
    'hook that transcends niche. Make following, saving, or subscribing feel like an obvious ' +
    'decision. Broad relatability over insider language.',

  community_conversation:
    'Share a genuine opinion or an unpopular truth that invites respectful debate. ' +
    '"I might be wrong — what is your experience?" earns more trust than being certain. ' +
    'Open-ended questions only. The goal is a thread, not a broadcast.'
};

// ----------------------------------------------------------------
// Tone writing guidance
// Shapes sentence structure, word choice, punctuation, and personality
// so every post sounds distinctly like the chosen tone.
// ----------------------------------------------------------------
const TONE_NOTES = {
  professional:
    'Formal but not stiff. Clear, precise language — no slang, no excessive punctuation, ' +
    'no filler phrases. Build credibility through specifics and evidence, not assertions. ' +
    'Contractions are acceptable; exclamation marks are not.',

  friendly:
    'Write like you are talking to a trusted friend, not an audience. Use contractions. ' +
    'Second person throughout ("you", "your"). Short sentences. Light emoji use is welcome. ' +
    'Make the reader feel seen and included, never talked at.',

  bold:
    'Short punchy sentences. No hedging words (perhaps, might, could, maybe, just, sort of). ' +
    'State opinions as facts. Use contrast for impact: "Most people do X. That is wrong." ' +
    'Confidence needs no exclamation marks — avoid them.',

  emotional:
    'Write from a place of genuine feeling. Use specific sensory details — not "I was ' +
    'overwhelmed" but "my hands were shaking." First-person present tense creates immediacy. ' +
    'Leave white space. Let the reader feel something before you tell them what to do.',

  humorous:
    'Subvert expectations: set up an assumption in the first line, flip it in the second. ' +
    'Specificity makes things funnier — "I spent $47 on this" beats "I spent a lot." ' +
    'Understatement usually lands harder than exaggeration. Use emoji sparingly for maximum effect.',

  authoritative:
    'Ground every claim in data, frameworks, or firsthand experience. Make contrarian takes ' +
    'backed by evidence: "Most people believe X — the data says Y." ' +
    'Position as the person who has seen this play out. Never hedge; qualify with evidence instead.',

  inspirational:
    'Paint a vivid picture of what becomes possible — speak to who the reader wants to become, ' +
    'not who they are now. Use "you can" and "you will," never "try" or "maybe." ' +
    'End with a CTA that feels like a gift or an invitation, not a task or obligation.'
};

// ----------------------------------------------------------------
// getStyleNotes — called by routes/briefs.js to build the combined
// writing guidance string injected into the LLM prompt.
// ----------------------------------------------------------------
function getStyleNotes(postType, objective, tone) {
  const parts = [];

  const postNote = POST_TYPE_NOTES[postType];
  const objNote  = OBJECTIVE_NOTES[objective];
  const toneNote = TONE_NOTES[tone];

  if (postNote) parts.push(`Post Type (${postType}): ${postNote}`);
  if (objNote)  parts.push(`Objective (${objective}): ${objNote}`);
  if (toneNote) parts.push(`Tone (${tone}): ${toneNote}`);

  return parts.length > 0 ? parts.join('\n\n') : null;
}

// ----------------------------------------------------------------
// Clip matching profiles — used by POST /media/match-clips to score
// pre-analysed video segments against a brief.
//
// Each profile defines what energy range and pacing styles work best
// for this combination of post type, objective, and tone.
// The match-clips route uses this to filter and rank segments from
// the video_segments table without calling the LLM.
// ----------------------------------------------------------------

// Energy ranges by post type (1-10 scale, from videoAnalysisService)
const POST_TYPE_ENERGY = {
  educational:          { min: 3, max: 7 },  // Calm but present
  product_launch:       { min: 6, max: 10 }, // High energy reveal
  behind_the_scenes:    { min: 3, max: 7 },  // Natural, unscripted feel
  lead_generation:      { min: 5, max: 9 },  // Direct and energetic
  community_engagement: { min: 3, max: 7 },  // Conversational
  promotional:          { min: 6, max: 10 }, // Exciting and urgent
  story_personal:       { min: 2, max: 7 },  // Emotional, not frenetic
  news_update:          { min: 4, max: 8 }   // Clear and crisp
};

// Pacing preferences by post type
const POST_TYPE_PACING = {
  educational:          ['slow', 'moderate'],
  product_launch:       ['fast', 'moderate'],
  behind_the_scenes:    ['slow', 'moderate'],
  lead_generation:      ['moderate', 'fast'],
  community_engagement: ['slow', 'moderate'],
  promotional:          ['fast', 'moderate'],
  story_personal:       ['slow', 'moderate'],
  news_update:          ['moderate', 'fast']
};

// Energy boost/reduction from the chosen objective
const OBJECTIVE_ENERGY_BOOST = {
  engagement:            1,
  comments:              0,
  sharing:               1,
  clicks:                2,
  conversions:           2,
  awareness:             1,
  community_conversation: -1
};

// Energy modifier from tone selection
const TONE_ENERGY_MOD = {
  professional:   -1,
  friendly:        0,
  bold:            2,
  emotional:      -1,
  humorous:        1,
  authoritative:   0,
  inspirational:   1
};

// ----------------------------------------------------------------
// getClipMatchProfile
//
// Returns the ideal energy range and pacing preferences for a clip
// given a brief's post type, objective, and tone.
//
// Called by POST /media/match-clips to filter and rank segments
// from the video_segments table without calling the LLM.
// ----------------------------------------------------------------
function getClipMatchProfile(postType, objective, tone) {
  const baseEnergy  = POST_TYPE_ENERGY[postType]           || { min: 3, max: 8 };
  const energyBoost = (OBJECTIVE_ENERGY_BOOST[objective]   || 0)
                    + (TONE_ENERGY_MOD[tone]                || 0);

  // Shift the energy window while keeping it in [1, 10]
  const min    = Math.max(1, Math.min(9,  baseEnergy.min + energyBoost));
  const max    = Math.max(2, Math.min(10, baseEnergy.max + energyBoost));
  const pacing = POST_TYPE_PACING[postType] || ['moderate'];

  return { energyMin: min, energyMax: max, pacing };
}

// ----------------------------------------------------------------
// scoreMediaForBrief
//
// Scores a single media_items row against a brief context so the
// media picker can show the most relevant files first.
//
// Scoring breakdown (100 pts max):
//   35 pts — platform fit (media tagged for the target platform)
//   30 pts — emotional tone match (media tone aligns with brief tone)
//   20 pts — pacing match (media pacing aligns with post type)
//   15 pts — analysis ready bonus (clip picker will be available)
//
// A score of 0 means "no signals available" — media was added without
// metadata, not that it's a bad match. Items with 0 still appear in
// the list but are sorted to the end.
// ----------------------------------------------------------------

// Map brief tone → emotional_tone keywords we expect to find in media
const TONE_TO_EMOTIONAL_TONE = {
  professional:   ['professional', 'informational', 'authoritative'],
  friendly:       ['friendly', 'warm', 'conversational', 'casual'],
  bold:           ['energetic', 'exciting', 'bold', 'intense'],
  emotional:      ['emotional', 'heartfelt', 'touching', 'sincere'],
  humorous:       ['humorous', 'playful', 'funny', 'lighthearted'],
  authoritative:  ['professional', 'authoritative', 'informational'],
  inspirational:  ['inspiring', 'motivational', 'uplifting', 'empowering']
};

function scoreMediaForBrief(item, { postType, objective, tone, platform }) {
  let score = 0;

  // --- 35 pts: platform fit ---
  // Does this media have the target platform in its platform_fit array?
  if (platform && Array.isArray(item.platform_fit) && item.platform_fit.includes(platform)) {
    score += 35;
  }

  // --- 30 pts: emotional tone match ---
  // Compare the media's emotional_tone string against keywords we expect
  // for this brief tone. Partial match (includes) so 'inspiring' matches
  // 'inspiring content' or 'inspiring/motivational'.
  if (tone && item.emotional_tone) {
    const expectedKeywords = TONE_TO_EMOTIONAL_TONE[tone] || [];
    const mediaTone = item.emotional_tone.toLowerCase();
    const matched = expectedKeywords.some(kw => mediaTone.includes(kw));
    if (matched) score += 30;
  }

  // --- 20 pts: pacing match ---
  // Use the same pacing table as clip matching (post type drives pacing).
  if (postType && item.pacing) {
    const idealPacing = POST_TYPE_PACING[postType] || ['moderate'];
    if (idealPacing.includes(item.pacing)) score += 20;
  }

  // --- 15 pts: analysis ready bonus ---
  // A video with analysis_status === 'ready' means the clip picker will
  // work for it — so it's a more actionable attachment than an unanalyzed file.
  if (item.file_type === 'video' && item.analysis_status === 'ready') {
    score += 15;
  }

  return score;
}

module.exports = { getStyleNotes, getClipMatchProfile, scoreMediaForBrief };
