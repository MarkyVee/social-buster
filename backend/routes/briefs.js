/**
 * routes/briefs.js
 *
 * Brief submission and AI post generation.
 * All routes require authentication and tenant enforcement.
 */

const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const { enforceTenancy } = require('../middleware/tenancy');
const { aiLimiter, standardLimiter } = require('../middleware/rateLimit');
const { checkLimit } = require('../middleware/checkLimit');
const { generatePosts } = require('../services/llmService');
const { supabaseAdmin, getUserProfile } = require('../services/supabaseService');
const { cacheGet } = require('../services/redisService');
const { getStyleNotes } = require('../data/briefSemantics');

// Apply auth + tenancy to ALL routes in this file
router.use(requireAuth, enforceTenancy);

// Valid options for each brief field — used for server-side validation
const VALID_POST_TYPES = ['educational', 'product_launch', 'behind_the_scenes', 'lead_generation', 'community_engagement', 'promotional', 'story_personal', 'news_update'];
const VALID_OBJECTIVES = ['engagement', 'comments', 'sharing', 'clicks', 'conversions', 'awareness', 'community_conversation'];
const VALID_TONES      = ['professional', 'friendly', 'bold', 'emotional', 'humorous', 'authoritative', 'inspirational'];
const VALID_PLATFORMS  = ['instagram', 'facebook', 'tiktok', 'linkedin', 'x', 'threads', 'whatsapp', 'telegram'];

// ----------------------------------------------------------------
// POST /briefs
// Submit a brief, call the LLM, save generated posts, return all.
//
// This is the most important endpoint in the platform.
// Steps:
// 1. Validate the brief fields
// 2. Save the brief to the database (status: 'generating')
// 3. Pull user's intelligence cache and profile for prompt context
// 4. Call the LLM to generate 3 post options per platform
// 5. Save all generated posts to the database
// 6. Update brief status to 'complete'
// 7. Return the brief and all generated posts
// ----------------------------------------------------------------
router.post('/', aiLimiter, checkLimit('briefs_per_month'), async (req, res) => {
  const { post_type, objective, tone, platforms, notes } = req.body;
  const userId = req.userId;

  // --- Validate required fields ---
  const errors = [];
  if (!post_type || !VALID_POST_TYPES.includes(post_type.toLowerCase())) {
    errors.push('Invalid or missing post_type');
  }
  if (!objective || !VALID_OBJECTIVES.includes(objective.toLowerCase())) {
    errors.push('Invalid or missing objective');
  }
  if (!tone || !VALID_TONES.includes(tone.toLowerCase())) {
    errors.push('Invalid or missing tone');
  }

  if (!platforms || !Array.isArray(platforms) || platforms.length === 0) {
    errors.push('At least one platform must be selected');
  }

  if (platforms) {
    const invalidPlatforms = platforms.filter(p => !VALID_PLATFORMS.includes(p.toLowerCase()));
    if (invalidPlatforms.length > 0) {
      errors.push(`Invalid platforms: ${invalidPlatforms.join(', ')}`);
    }
  }

  if (errors.length > 0) {
    return res.status(400).json({ error: errors.join('. ') });
  }

  // Normalise to lowercase
  const briefData = {
    post_type:       post_type.toLowerCase(),
    objective:       objective.toLowerCase(),
    tone:            tone.toLowerCase(),
    platforms:       platforms.map(p => p.toLowerCase()),
    notes:           notes?.trim() || null
  };

  let briefId = null;

  try {
    // --- Step 1: Fetch user profile (needed before insert to derive target_audience) ---
    let userProfile = {};
    try {
      userProfile = await getUserProfile(userId);
    } catch {
      // Non-fatal — we'll proceed without profile context
    }

    // Derive target_audience from the user's saved profile fields.
    // This replaces the old free-text field and gives the LLM richer,
    // consistent context without requiring the user to type it every time.
    const audienceParts = [
      userProfile.target_age_range,
      userProfile.target_gender && userProfile.target_gender !== 'all' ? userProfile.target_gender : null,
      userProfile.audience_location,
      userProfile.industry
    ].filter(Boolean);
    briefData.target_audience = audienceParts.length > 0 ? audienceParts.join(', ') : 'General audience';

    // --- Step 2: Save brief with 'generating' status ---
    const { data: brief, error: briefError } = await supabaseAdmin
      .from('briefs')
      .insert({ user_id: userId, ...briefData, status: 'generating' })
      .select()
      .single();

    if (briefError) throw new Error(`Failed to save brief: ${briefError.message}`);
    briefId = brief.id;

    // Pull intelligence cache from Redis (non-fatal if missing)
    let intelligence = null;
    try {
      intelligence = await cacheGet(`intelligence:${userId}`);
    } catch {
      // Cache miss is fine — LLM will use best practices instead
    }

    // Look up semantic writing guidance for the selected post type, objective, and tone.
    // This injects targeted LLM style instructions into every generation prompt,
    // producing noticeably better output without any extra user input.
    const styleNotes = getStyleNotes(briefData.post_type, briefData.objective, briefData.tone);

    const userContext = {
      user_id:      userId,   // Needed by contextBuilder to pull cross-agent data
      brand_name:   userProfile.brand_name,
      industry:     userProfile.industry,
      brand_voice:  userProfile.brand_voice,
      intelligence: intelligence ? JSON.stringify(intelligence, null, 2) : null,
      style_notes:  styleNotes
    };

    // --- Step 3: Call the LLM ---
    const generatedPosts = await generatePosts(brief, userContext);

    if (!generatedPosts || generatedPosts.length === 0) {
      throw new Error('AI generation returned no posts. Please try again.');
    }

    // --- Step 4: Save all generated posts to the database ---
    const postsToInsert = generatedPosts.map(post => ({
      user_id:         userId,
      brief_id:        briefId,
      platform:        post.platform,
      option_number:   post.option_number,
      hook:            post.hook,
      caption:         post.caption,
      hashtags:        post.hashtags,
      cta:             post.cta,
      // Store media recommendation as a note in the record
      // (actual media linking happens in Phase 4)
      status:          'draft'
    }));

    const { data: savedPosts, error: postsError } = await supabaseAdmin
      .from('posts')
      .insert(postsToInsert)
      .select();

    if (postsError) throw new Error(`Failed to save generated posts: ${postsError.message}`);

    // Attach media_recommendation to returned posts (stored in LLM output, not DB yet)
    const postsWithMedia = savedPosts.map(savedPost => {
      const matchingGenerated = generatedPosts.find(
        g => g.platform === savedPost.platform && g.option_number === savedPost.option_number
      );
      return {
        ...savedPost,
        media_recommendation: matchingGenerated?.media_recommendation || null,
        why_this_works:       matchingGenerated?.why_this_works       || null
      };
    });

    // --- Step 5: Mark brief as complete ---
    await supabaseAdmin
      .from('briefs')
      .update({ status: 'complete' })
      .eq('id', briefId);

    return res.status(201).json({
      message: 'Posts generated successfully',
      brief: { ...brief, status: 'complete' },
      posts: postsWithMedia
    });

  } catch (err) {
    console.error('[Briefs] Generation error:', err.message);

    // Mark the brief as failed so the user knows something went wrong
    if (briefId) {
      try {
        await supabaseAdmin
          .from('briefs')
          .update({ status: 'error' })
          .eq('id', briefId);
      } catch { /* Don't throw if this update also fails */ }
    }

    // Give the user a clear, actionable error message
    const userMessage = err.message.includes('AI model is not reachable')
      ? err.message
      : 'Post generation failed. Please try again in a moment.';

    return res.status(500).json({ error: userMessage, details: err.message });
  }
});

// ----------------------------------------------------------------
// GET /briefs
// List all briefs for the current user, newest first.
// ----------------------------------------------------------------
router.get('/', standardLimiter, async (req, res) => {
  try {
    const { data, error } = await req.db
      .from('briefs')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);

    return res.json({ briefs: data });

  } catch (err) {
    console.error('[Briefs] List error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch briefs' });
  }
});

// ----------------------------------------------------------------
// GET /briefs/:id
// Fetch a single brief and all its generated post options.
// ----------------------------------------------------------------
router.get('/:id', standardLimiter, async (req, res) => {
  try {
    // Fetch the brief (RLS ensures this belongs to the current user)
    const { data: brief, error: briefError } = await req.db
      .from('briefs')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (briefError || !brief) {
      return res.status(404).json({ error: 'Brief not found' });
    }

    // Fetch all posts associated with this brief
    const { data: posts, error: postsError } = await req.db
      .from('posts')
      .select('*')
      .eq('brief_id', req.params.id)
      .order('platform')
      .order('option_number');

    if (postsError) throw new Error(postsError.message);

    return res.json({ brief, posts: posts || [] });

  } catch (err) {
    console.error('[Briefs] Get error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch brief' });
  }
});

// ----------------------------------------------------------------
// DELETE /briefs/:id
// Delete a brief and its associated posts (cascade handles posts).
// ----------------------------------------------------------------
router.delete('/:id', standardLimiter, async (req, res) => {
  try {
    const { error } = await req.db
      .from('briefs')
      .delete()
      .eq('id', req.params.id);

    if (error) throw new Error(error.message);

    return res.json({ message: 'Brief deleted' });

  } catch (err) {
    console.error('[Briefs] Delete error:', err.message);
    return res.status(500).json({ error: 'Failed to delete brief' });
  }
});

module.exports = router;
