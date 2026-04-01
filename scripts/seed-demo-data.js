/**
 * scripts/seed-demo-data.js
 *
 * Seeds a demo user account with realistic data for sales demos.
 * Run before a demo. Clean up after with --clean flag.
 *
 * WHAT IT SEEDS:
 *   - evaluation_results  : 12 evaluations per avatar (60 total) across
 *                           post types so meta-agent threshold is met
 *   - post_metrics        : good engagement numbers on each seeded post
 *   - signal_weights      : populated intelligence data on the user profile
 *                           so the Intelligence Dashboard looks rich
 *   - avatar_prompt_suggestions : one pending suggestion ready to approve live
 *
 * HOW TO USE:
 *   node scripts/seed-demo-data.js --user=<USER_ID>
 *   node scripts/seed-demo-data.js --user=<USER_ID> --clean
 *
 * REQUIREMENTS:
 *   - A real user account must already exist (create one in the app first)
 *   - That user must have at least 3 published posts (the script uses real post IDs)
 *   - Run from the project root
 *
 * NEVER run this against a real paying user. Demo account only.
 */

'use strict';

const path = require('node:path');
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/.env') });

const { createClient } = require(
  path.join(__dirname, '../backend/node_modules/@supabase/supabase-js')
);

// ----------------------------------------------------------------
// Supabase admin client (service role — bypasses RLS)
// ----------------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ----------------------------------------------------------------
// Parse args
// ----------------------------------------------------------------
const args   = process.argv.slice(2);
const userId = (args.find(a => a.startsWith('--user=')) || '').replace('--user=', '');
const clean  = args.includes('--clean');

if (!userId) {
  console.error('\nUsage:');
  console.error('  node scripts/seed-demo-data.js --user=<USER_ID>');
  console.error('  node scripts/seed-demo-data.js --user=<USER_ID> --clean\n');
  process.exit(1);
}

// ----------------------------------------------------------------
// Demo content — realistic evaluation text per field
// ----------------------------------------------------------------
const EVAL_TEMPLATES = {
  hook: [
    { text: 'Strong pattern interrupt. The question format creates immediate curiosity gap. Consider making the stakes clearer in the first 3 words.', suggestions: [{ field: 'hook', issue: 'Stakes unclear', replacement: 'Still struggling with X? Here\'s what actually works.' }] },
    { text: 'Bold claim hook lands well. Specificity (the number) adds credibility. Test a version with a stronger emotional trigger word.', suggestions: [] },
    { text: 'Relatable opening but loses momentum after the first line. The payoff promise needs to come sooner.', suggestions: [{ field: 'hook', issue: 'Payoff too late', replacement: 'The exact system I used to 3x results in 30 days.' }] },
  ],
  caption: [
    { text: 'Good story arc. CTA placement at end is standard — test putting a soft CTA in the middle for longer captions. Emoji use is appropriate.', suggestions: [] },
    { text: 'Caption is doing too much work. Pick one core message. The third paragraph weakens the overall impact.', suggestions: [{ field: 'caption', issue: 'Diluted message', replacement: 'Remove paragraph 3 — let the CTA land harder.' }] },
    { text: 'Conversational tone matches the audience well. The list format improves scannability. Strong finish.', suggestions: [] },
  ],
  hashtags: [
    { text: '3 niche tags, 2 mid-range, 1 broad — good ratio. Avoid #business (too competitive, 0.1% reach chance). Replace with a more targeted alternative.', suggestions: [{ field: 'hashtags', issue: 'Tag too broad', replacement: 'Replace #business with #smallbusinesstips' }] },
    { text: 'Hashtag mix is well-balanced. The branded tag is a smart long-term play. Consider adding one location-based tag.', suggestions: [] },
    { text: 'Too many broad tags diluting reach. Focus on 5 highly relevant niche tags instead of 15 mixed ones.', suggestions: [{ field: 'hashtags', issue: 'Too many broad tags', replacement: 'Cut to 5 niche-specific tags only.' }] },
  ],
  cta: [
    { text: 'Clear ask. "Comment LINK below" is a proven trigger format. The urgency element ("today only") adds conversion pressure without feeling spammy.', suggestions: [] },
    { text: 'CTA is too passive. "Let me know" doesn\'t drive action. Use a specific keyword trigger or a direct question that demands a yes/no response.', suggestions: [{ field: 'cta', issue: 'Passive CTA', replacement: 'Comment "READY" below and I\'ll send you the guide.' }] },
    { text: 'Strong CTA. The social proof element before the ask ("500+ people already have this") reduces friction. Good placement after the value delivery.', suggestions: [] },
  ],
};

const POST_TYPES  = ['educational', 'promotional', 'storytelling', 'engagement'];
const FIELDS      = ['hook', 'caption', 'hashtags', 'cta'];

// ----------------------------------------------------------------
// Realistic signal_weights for a healthy demo account
// ----------------------------------------------------------------
const DEMO_SIGNAL_WEIGHTS = {
  hook_formats: {
    question:   1.82,
    bold_claim: 1.54,
    story:      1.31,
    list:       0.94,
    how_to:     1.12
  },
  hook_trends: {
    question:   { direction: 'up',     ratio: 1.28, recent_avg: 4.1, prior_avg: 3.2 },
    bold_claim: { direction: 'stable', ratio: 1.03, recent_avg: 3.8, prior_avg: 3.7 },
    list:       { direction: 'down',   ratio: 0.81, recent_avg: 2.6, prior_avg: 3.2 }
  },
  tone_objective_fit: {
    bold_conversions:          1.74,
    bold_awareness:            1.45,
    conversational_engagement: 1.61,
    conversational_awareness:  1.38,
    professional_conversions:  1.22,
    educational_engagement:    1.55
  },
  best_hours: {
    overall:      [9, 12, 18],
    best_days:    [2, 3, 4],
    by_post_type: {
      educational: { best_hours: [9, 10], best_days: [2, 4] },
      promotional: { best_hours: [12, 18], best_days: [3, 5] }
    }
  },
  comment_signals: {
    by_post_type: {
      educational: { question: 3.2, request: 2.1, praise: 1.4 },
      promotional: { question: 0.8, complaint: 1.3, praise: 0.9 },
      storytelling: { praise: 2.8, curiosity: 2.3 }
    },
    by_tone: {
      bold:           { question: 2.1, request: 1.8 },
      conversational: { praise: 2.4, curiosity: 1.9 }
    },
    top_question_topics:  ['pricing options', 'how to get started', 'what tools do you use'],
    top_request_topics:   ['free template', 'link to resource', 'step by step guide']
  },
  cta_effectiveness: {
    by_format: {
      comment_keyword: { trigger_rate: 4.2, completion_rate: 0.68, lead_rate: 0.34 },
      dm_direct:       { trigger_rate: 2.1, completion_rate: 0.81, lead_rate: 0.52 },
      link_in_bio:     { trigger_rate: 1.4, completion_rate: 0.22, lead_rate: 0.11 }
    },
    best_cta_format:    'comment_keyword',
    top_trigger_phrases: ['comment LINK', 'DM me FREE', 'type YES below']
  },
  content_fatigue: {
    by_hook_format: {
      list:        { fatigued: true,  frequency: 0.41, engagement_decline: 0.23 },
      question:    { fatigued: false, frequency: 0.28, engagement_decline: 0 },
      bold_claim:  { fatigued: false, frequency: 0.22, engagement_decline: 0 }
    },
    by_post_type: {
      promotional: { fatigued: true,  frequency: 0.55, engagement_decline: 0.31 },
      educational: { fatigued: false, frequency: 0.25, engagement_decline: 0 }
    },
    by_tone: {
      professional: { fatigued: true, frequency: 0.38, engagement_decline: 0.18 }
    },
    fatigue_warnings: [
      'List hooks used in 41% of recent posts — engagement down 23%. Consider rotating formats.',
      'Promotional content at 55% of posts — audience fatigue detected. Mix in educational content.',
      'Professional tone declining — try bold or conversational for your next 3 posts.'
    ]
  },
  algorithm_alerts: [
    {
      platform:   'instagram',
      cohort_key: 'marketing_b2b_us',
      reach_suppression: { detected: true, severity: 'medium', affected_pct: 0.64, decline_pct: 0.22 },
      format_signals: {
        reels: { type: 'boost',   multiplier: 2.3 },
        carousel: { type: 'boost', multiplier: 1.7 },
        static: { type: 'penalty', multiplier: 0.6 }
      }
    }
  ],
  brief_optimization: {
    recommended_hook_format: 'question',
    recommended_post_type:   'educational',
    recommended_tone:        'bold',
    recommended_cta_format:  'comment_keyword',
    recommended_post_day:    2,
    recommended_post_hour:   9,
    composite_score:         3.2,
    avoid_patterns:          ['list hooks', 'promotional posts', 'professional tone'],
    signal_count:            8,
    confidence:              'high'
  },
  content_gaps: [
    {
      type:     'post_type_gap',
      gap:      'educational',
      evidence: 'generates 3.2x more question comments but only 8% of your recent posts',
      action:   'Create more educational content — your audience is in learning mode'
    },
    {
      type:     'topic_gap',
      gap:      'pricing options',
      evidence: 'most commonly appears in your question comments but not addressed in any recent post',
      action:   'Address pricing directly in a future post — your audience keeps asking about it'
    },
    {
      type:     'cta_gap',
      gap:      'comment_keyword',
      evidence: 'your best-performing CTA format (4.2 DM triggers/1K reach) — you only use it in 12% of posts',
      action:   'Use a comment keyword CTA in your next post to activate your DM automation'
    }
  ],
  brief_optimization_updated_at:  new Date().toISOString(),
  content_gaps_updated_at:        new Date().toISOString(),
  content_fatigue_updated_at:     new Date().toISOString(),
  comment_signals_updated_at:     new Date().toISOString(),
  cta_effectiveness_updated_at:   new Date().toISOString(),
  hook_formats_updated_at:        new Date().toISOString()
};

// ----------------------------------------------------------------
// clean — removes everything seeded by this script for this user
// ----------------------------------------------------------------
async function cleanDemoData() {
  console.log(`\nCleaning demo data for user ${userId}...`);

  // Delete evaluation results seeded by this script (tagged with job_id prefix)
  const { error: evalErr } = await supabase
    .from('evaluation_results')
    .delete()
    .eq('user_id', userId)
    .like('job_id', 'demo-seed-%');

  if (evalErr) console.warn('  evaluation_results clean error:', evalErr.message);
  else console.log('  evaluation_results cleaned');

  // Delete pending prompt suggestions seeded by this script
  const { error: sugErr } = await supabase
    .from('avatar_prompt_suggestions')
    .delete()
    .eq('metrics_basis->seeded_by', '"demo-seed-script"');

  if (sugErr) console.warn('  avatar_prompt_suggestions clean error:', sugErr.message);
  else console.log('  avatar_prompt_suggestions cleaned');

  // Delete seeded comments (tagged with demo-seed- prefix on platform_comment_id)
  const { error: cmtErr } = await supabase
    .from('comments')
    .delete()
    .eq('user_id', userId)
    .like('platform_comment_id', 'demo-seed-%');
  if (cmtErr) console.warn('  comments clean error:', cmtErr.message);
  else console.log('  comments cleaned');

  // Delete seeded post_metrics — fetch published post IDs first
  const { data: userPosts } = await supabase
    .from('posts')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'published');
  if (userPosts?.length) {
    const ids = userPosts.map(p => p.id);
    const { error: pmErr } = await supabase.from('post_metrics').delete().in('post_id', ids).eq('user_id', userId);
    if (pmErr) console.warn('  post_metrics clean error:', pmErr.message);
    else console.log('  post_metrics cleaned');
  }

  // Reset signal_weights to null
  const { error: swErr } = await supabase
    .from('user_profiles')
    .update({ signal_weights: null })
    .eq('user_id', userId);

  if (swErr) console.warn('  signal_weights reset error:', swErr.message);
  else console.log('  signal_weights reset to null');

  console.log('\nClean complete.');
}

// ----------------------------------------------------------------
// main — seeds all demo data
// ----------------------------------------------------------------
async function main() {
  if (clean) {
    await cleanDemoData();
    return;
  }

  console.log(`\nSeeding demo data for user ${userId}...`);

  // 1. Fetch active avatars
  const { data: avatars, error: avatarErr } = await supabase
    .from('evaluation_avatars')
    .select('id, name, icon, field_focus, post_type_focus')
    .eq('active', true)
    .order('sort_order');

  if (avatarErr || !avatars?.length) {
    console.error('No active avatars found. Run migration_evaluation_system.sql first.');
    process.exit(1);
  }
  console.log(`  Found ${avatars.length} active avatars`);

  // 2. Fetch real published posts for this user (need real post_ids)
  const { data: posts, error: postErr } = await supabase
    .from('posts')
    .select('id, brief_id')
    .eq('user_id', userId)
    .eq('status', 'published')
    .limit(20);

  if (postErr || !posts?.length) {
    console.error('No published posts found for this user.');
    console.error('Publish at least 3 posts first, then re-run.');
    process.exit(1);
  }
  console.log(`  Found ${posts.length} published posts`);

  // Get post types from briefs
  const briefIds = [...new Set(posts.map(p => p.brief_id).filter(Boolean))];
  const briefMap = {};
  if (briefIds.length > 0) {
    const { data: briefs } = await supabase
      .from('briefs')
      .select('id, post_type')
      .in('id', briefIds);
    (briefs || []).forEach(b => { briefMap[b.id] = b.post_type; });
  }

  // 3. Seed evaluation_results — 12 per avatar spread across posts
  console.log('\n  Seeding evaluation_results...');
  const evalRows = [];
  const now = new Date();

  for (const avatar of avatars) {
    // Determine which fields this avatar covers
    const fields = avatar.field_focus?.length > 0
      ? avatar.field_focus.filter(f => FIELDS.includes(f))
      : FIELDS;

    let evalCount = 0;

    // Cycle through posts and fields to reach 12+ evaluations per avatar
    for (let i = 0; evalCount < 12; i++) {
      const post      = posts[i % posts.length];
      const field     = fields[i % fields.length];
      const postType  = briefMap[post.brief_id] || POST_TYPES[i % POST_TYPES.length];
      const template  = EVAL_TEMPLATES[field][i % EVAL_TEMPLATES[field].length];

      // Spread created_at over the last 30 days for realistic history
      const daysAgo   = Math.floor(Math.random() * 28) + 1;
      const createdAt = new Date(now - daysAgo * 24 * 60 * 60 * 1000).toISOString();

      evalRows.push({
        user_id:         userId,
        post_id:         post.id,
        field,
        post_type:       postType,
        avatar_id:       avatar.id,
        job_id:          `demo-seed-${avatar.id}-${i}`,
        evaluation_text: template.text,
        suggestions:     template.suggestions,
        created_at:      createdAt
      });

      evalCount++;
    }
  }

  const { error: evalInsertErr } = await supabase
    .from('evaluation_results')
    .insert(evalRows);

  if (evalInsertErr) {
    console.error('  Failed to insert evaluation_results:', evalInsertErr.message);
    process.exit(1);
  }
  console.log(`  Inserted ${evalRows.length} evaluation results (${Math.round(evalRows.length / avatars.length)} per avatar)`);

  // 4. Seed post_metrics for each post so meta-agent has performance data
  console.log('\n  Seeding post_metrics...');

  // First delete any previously seeded metrics for these posts to avoid duplicates
  const postIds = posts.map(p => p.id);
  await supabase.from('post_metrics').delete().in('post_id', postIds).eq('user_id', userId);

  // Build rows — two platforms per post (instagram + facebook) so the chart has both
  const metricRows = [];
  posts.forEach((post, i) => {
    const base = new Date(now - i * 3 * 24 * 60 * 60 * 1000).toISOString();
    metricRows.push({
      post_id:     post.id,
      user_id:     userId,
      platform:    'instagram',
      likes:        180 + (i * 23),
      comments:     34  + (i * 7),
      shares:       12  + (i * 3),
      reach:        2800 + (i * 340),
      impressions:  3400 + (i * 410),
      recorded_at:  base
    });
    metricRows.push({
      post_id:     post.id,
      user_id:     userId,
      platform:    'facebook',
      likes:        95  + (i * 14),
      comments:     18  + (i * 4),
      shares:       22  + (i * 5),
      reach:        1900 + (i * 210),
      impressions:  2200 + (i * 260),
      recorded_at:  base
    });
  });

  const { error: metricsErr } = await supabase
    .from('post_metrics')
    .insert(metricRows);

  if (metricsErr) console.warn('  post_metrics insert warning:', metricsErr.message);
  else console.log(`  Inserted metrics for ${posts.length} posts (instagram + facebook)`);

  // 5. Seed signal_weights on user_profiles
  console.log('\n  Seeding signal_weights...');
  const { error: swErr } = await supabase
    .from('user_profiles')
    .update({ signal_weights: DEMO_SIGNAL_WEIGHTS })
    .eq('user_id', userId);

  if (swErr) {
    console.error('  Failed to update signal_weights:', swErr.message);
  } else {
    console.log('  signal_weights populated (8 signal categories)');
  }

  // 6. Seed one pending prompt suggestion so admin can approve it live
  console.log('\n  Seeding pending prompt suggestion...');
  const targetAvatar = avatars[0]; // Use the first avatar (Scroll-Stopper)

  const { error: sugErr } = await supabase
    .from('avatar_prompt_suggestions')
    .insert({
      avatar_id:        targetAvatar.id,
      suggested_prompt: `You are ${targetAvatar.name}, an expert content evaluator specialising in scroll-stopping hooks for social media.

When evaluating hooks, focus on:
1. Pattern interrupt strength — does it stop the scroll in the first 3 words?
2. Curiosity gap — does it create a question the audience NEEDS answered?
3. Specificity — does it use concrete numbers, names, or timeframes?
4. Stakes — are the consequences of ignoring this post clear?
5. Platform fit — does the tone match the platform (Instagram vs LinkedIn vs TikTok)?

For each hook, rate it 1-10 and give ONE specific rewrite that improves the weakest element.
Be direct and brief. Creators want actionable feedback, not praise.`,
      reason: 'Analysis of 47 evaluations shows suggestions that include specific rewrites are applied 3.2x more often than text-only feedback. Adding a mandatory rewrite format to the prompt should significantly improve suggestion acceptance rate.',
      status: 'pending',
      metrics_basis: {
        total_evaluations: 47,
        published_count:   31,
        avg_metrics:       { avgLikes: 203, avgComments: 41, avgReach: 3140 },
        confidence:        0.87,
        key_changes:       [
          'Added mandatory 1-10 rating for consistency',
          'Added specific rewrite requirement — removes vague feedback',
          'Added platform fit consideration — avatar was giving generic advice'
        ],
        seeded_by: 'demo-seed-script'
      }
    });

  if (sugErr) console.warn('  prompt suggestion warning:', sugErr.message);
  else console.log(`  Created 1 pending prompt suggestion for ${targetAvatar.icon} ${targetAvatar.name}`);

  // 7. Seed comments with realistic sentiment distribution
  console.log('\n  Seeding comments...');

  // First remove any previously seeded comments so re-runs stay clean
  await supabase.from('comments').delete().eq('user_id', userId).like('platform_comment_id', 'demo-seed-%');

  const DEMO_COMMENTS = [
    // positive
    { text: 'This is exactly what I needed to hear today, thank you!', sentiment: 'positive', handle: 'sarah_m_creative' },
    { text: 'Wow, incredible post. Saving this for later 🔥', sentiment: 'positive', handle: 'jdotmarketing' },
    { text: 'You always deliver the best content. Keep it up!', sentiment: 'positive', handle: 'the_real_brandbuilder' },
    { text: 'Game changer info right here. Shared with my whole team.', sentiment: 'positive', handle: 'coachriley_biz' },
    { text: 'Love this so much. Been following you for years ❤️', sentiment: 'positive', handle: 'emiliarose.co' },
    { text: 'This strategy doubled my engagement last month, can confirm!', sentiment: 'positive', handle: 'growthhackr99' },
    { text: "Best post I've seen this week hands down 👏", sentiment: 'positive', handle: 'digi_don' },
    { text: 'Following for more tips like this. Absolutely gold.', sentiment: 'positive', handle: 'karenbuilds' },
    { text: 'Screenshotted and sent to my business partner immediately.', sentiment: 'positive', handle: 'twinsfounders' },
    { text: "You explained this better than any course I've paid for!", sentiment: 'positive', handle: 'learner_liz' },
    // neutral
    { text: 'Interesting take. How long does this approach typically take to show results?', sentiment: 'neutral', handle: 'markusweber_digital' },
    { text: 'What tool do you use for this?', sentiment: 'neutral', handle: 'techie_tara' },
    { text: 'Does this work for B2B or only B2C?', sentiment: 'neutral', handle: 'salesforce_sam' },
    { text: 'Can you share the template you mentioned?', sentiment: 'neutral', handle: 'priya_v_mktg' },
    { text: 'How often do you post to maintain this kind of engagement?', sentiment: 'neutral', handle: 'consistency_king' },
    { text: 'Is this platform-specific or does it apply everywhere?', sentiment: 'neutral', handle: 'omnichannel_omar' },
    // negative
    { text: 'Not sure this would work for my niche, feels too generic.', sentiment: 'negative', handle: 'skeptical_steve' },
    { text: 'Tried this before and got zero results tbh', sentiment: 'negative', handle: 'been_there_done_that' },
    { text: 'Clickbait title, the content didn\'t really deliver on the promise.', sentiment: 'negative', handle: 'honest_reviewer_hq' },
  ];

  const commentRows = [];
  const platforms = ['instagram', 'facebook'];
  DEMO_COMMENTS.forEach((c, i) => {
    const post = posts[i % posts.length];
    const platform = platforms[i % 2];
    // Spread ingestion times across last 14 days
    const ingestedAt = new Date(now - (i * 16 * 60 * 60 * 1000)).toISOString();
    commentRows.push({
      user_id:             userId,
      post_id:             post.id,
      platform,
      platform_comment_id: `demo-seed-${userId.slice(0, 8)}-${i}`,
      comment_text:        c.text,
      author_handle:       c.handle,
      sentiment:           c.sentiment,
      trigger_matched:     false,
      dm_sent:             false,
      ingested_at:         ingestedAt
    });
  });

  const { error: commentsErr } = await supabase.from('comments').insert(commentRows);
  if (commentsErr) console.warn('  comments insert warning:', commentsErr.message);
  else console.log(`  Inserted ${commentRows.length} comments (10 positive, 6 neutral, 3 negative)`);

  // ── Summary ──
  console.log(`
════════════════════════════════════════════════
DEMO SEED COMPLETE
════════════════════════════════════════════════
User:         ${userId}
Avatars:      ${avatars.length} active
Evaluations:  ${evalRows.length} seeded (${Math.round(evalRows.length / avatars.length)} per avatar)
Posts:        ${posts.length} with metrics
Comments:     ${commentRows.length} seeded (10 positive, 6 neutral, 3 negative)
Signal data:  8 categories populated
Suggestions:  1 pending (ready to approve live)

DEMO FLOW:
  1. Open Admin → Avatars tab
     → Roster shows evaluation counts per avatar
  2. Click "Analyze & Suggest Improvements"
     → Meta-agent now has enough data to run (12+ evals per avatar)
  3. A pending suggestion appears — approve it live
  4. Open Admin → Users → click demo user
     → Context Inspector shows full signal_weights
  5. Open Intelligence Dashboard as the demo user
     → All 8 signal sections are populated

TO CLEAN UP AFTER DEMO:
  node scripts/seed-demo-data.js --user=${userId} --clean
════════════════════════════════════════════════
`);
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
