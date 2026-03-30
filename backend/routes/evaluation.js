/**
 * routes/evaluation.js
 *
 * FEAT-001: Avatar-Based Content Evaluation System
 *
 * User endpoints:
 *   POST /evaluation/evaluate         — Queue an evaluation job
 *   GET  /evaluation/status/:jobId    — Poll for results
 *   GET  /evaluation/history/:postId  — Past evaluations for a post
 *
 * Admin endpoints:
 *   GET  /evaluation/admin/avatars              — List all avatars
 *   PUT  /evaluation/admin/avatars/:id          — Update avatar prompt/config
 *   GET  /evaluation/admin/suggestions          — Pending prompt suggestions
 *   POST /evaluation/admin/suggestions/:id/approve — Approve + apply prompt change
 *   POST /evaluation/admin/suggestions/:id/reject  — Reject suggestion
 *   PUT  /evaluation/admin/settings             — Update retention_days etc.
 */

const express = require('express');
const router = express.Router();

const { requireAuth }    = require('../middleware/auth');
const { enforceTenancy } = require('../middleware/tenancy');
const { requireAdmin }   = require('../middleware/adminAuth');
const { evaluationLimiter, standardLimiter } = require('../middleware/rateLimit');
const { evaluationQueue } = require('../queues');
const { supabaseAdmin }   = require('../services/supabaseService');
const { cacheSet }         = require('../services/redisService');
const { runMetaAnalysis }  = require('../agents/evaluationMetaAgent');

// All routes require authentication + tenancy
router.use(requireAuth, enforceTenancy);

// ================================================================
// USER ENDPOINTS
// ================================================================

// ----------------------------------------------------------------
// POST /evaluation/evaluate
//
// Queues an evaluation job for a single field. Returns a jobId
// that the frontend polls for results.
//
// Body: { postId, field, fieldContent, mediaUrl? }
// The postType and briefContext are fetched server-side from the post's brief.
// ----------------------------------------------------------------
router.post('/evaluate', evaluationLimiter, async (req, res) => {
  try {
    const { postId, field, fieldContent, mediaUrl } = req.body;
    const userId = req.user.id;

    // Validate required fields
    if (!postId || !field || (!fieldContent && field !== 'media')) {
      return res.status(400).json({ error: 'postId, field, and fieldContent are required.' });
    }

    const validFields = ['hook', 'caption', 'hashtags', 'cta', 'media'];
    if (!validFields.includes(field)) {
      return res.status(400).json({ error: `Invalid field. Must be one of: ${validFields.join(', ')}` });
    }

    // Fetch post's brief metadata server-side (post_type, objective, tone)
    // This prevents the frontend from having to send it and ensures accuracy.
    let postType = null;
    let briefContext = '';

    const { data: post } = await req.db
      .from('posts')
      .select('brief_id, platform')
      .eq('id', postId)
      .single();

    if (post?.brief_id) {
      const { data: brief } = await req.db
        .from('briefs')
        .select('post_type, objective, tone, target_audience, notes')
        .eq('id', post.brief_id)
        .single();

      if (brief) {
        postType = brief.post_type || null;
        briefContext = [
          `Post type: ${brief.post_type || 'not specified'}`,
          `Objective: ${brief.objective || 'not specified'}`,
          `Tone: ${brief.tone || 'not specified'}`,
          `Platform: ${post.platform || 'not specified'}`,
          brief.target_audience ? `Target audience: ${brief.target_audience}` : '',
          brief.notes ? `Additional notes: ${brief.notes}` : ''
        ].filter(Boolean).join('\n');
      }
    }

    // Add job to the evaluation queue
    const job = await evaluationQueue.add(
      'evaluate-field',
      {
        userId,
        postId,
        field,
        fieldContent: fieldContent || '',
        mediaUrl: mediaUrl || null,
        postType,
        briefContext
      },
      {
        // No jobId dedup — users can re-evaluate the same field after edits
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 100 }
      }
    );

    return res.json({ jobId: job.id });

  } catch (err) {
    console.error('[Evaluation] Queue error:', err.message);
    return res.status(500).json({ error: 'Failed to queue evaluation.' });
  }
});

// ----------------------------------------------------------------
// GET /evaluation/status/:jobId
//
// Polls for evaluation results. Frontend calls this every 500ms.
// Returns: { status: 'pending' | 'completed' | 'failed', results? }
// ----------------------------------------------------------------
router.get('/status/:jobId', standardLimiter, async (req, res) => {
  try {
    const job = await evaluationQueue.getJob(req.params.jobId);

    if (!job) {
      return res.status(404).json({ error: 'Evaluation job not found.' });
    }

    const state = await job.getState();

    if (state === 'completed') {
      return res.json({
        status: 'completed',
        results: job.returnvalue || []
      });
    }

    if (state === 'failed') {
      return res.json({
        status: 'failed',
        error: job.failedReason || 'Evaluation failed.'
      });
    }

    // waiting, active, delayed — all "pending" from the user's perspective
    return res.json({ status: 'pending' });

  } catch (err) {
    console.error('[Evaluation] Status poll error:', err.message);
    return res.status(500).json({ error: 'Failed to check evaluation status.' });
  }
});

// ----------------------------------------------------------------
// GET /evaluation/history/:postId
//
// Returns past evaluations for a specific post, grouped by field.
// ----------------------------------------------------------------
router.get('/history/:postId', standardLimiter, async (req, res) => {
  try {
    const { data, error } = await req.db
      .from('evaluation_results')
      .select('id, field, post_type, avatar_id, evaluation_text, suggestions, created_at')
      .eq('post_id', req.params.postId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;

    return res.json({ results: data || [] });

  } catch (err) {
    console.error('[Evaluation] History error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch evaluation history.' });
  }
});

// ================================================================
// ADMIN ENDPOINTS
// ================================================================

// ----------------------------------------------------------------
// GET /evaluation/admin/avatars — list all avatars (active + inactive)
// ----------------------------------------------------------------
router.get('/admin/avatars', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('evaluation_avatars')
      .select('*')
      .order('sort_order', { ascending: true });

    if (error) throw error;
    return res.json({ avatars: data || [] });

  } catch (err) {
    console.error('[Evaluation] Admin avatars error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch avatars.' });
  }
});

// ----------------------------------------------------------------
// PUT /evaluation/admin/avatars/:id — update avatar prompt/config
// ----------------------------------------------------------------
router.put('/admin/avatars/:id', requireAdmin, async (req, res) => {
  try {
    const { name, icon, description, system_prompt, field_focus, post_type_focus, active, sort_order } = req.body;

    const updates = {};
    if (name !== undefined) updates.name = name;
    if (icon !== undefined) updates.icon = icon;
    if (description !== undefined) updates.description = description;
    if (system_prompt !== undefined) updates.system_prompt = system_prompt;
    if (field_focus !== undefined) updates.field_focus = field_focus;
    if (post_type_focus !== undefined) updates.post_type_focus = post_type_focus;
    if (active !== undefined) updates.active = active;
    if (sort_order !== undefined) updates.sort_order = sort_order;
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('evaluation_avatars')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;

    // Invalidate avatar cache so next evaluation uses updated prompt
    await cacheSet('eval_avatars', null, 1);

    return res.json({ avatar: data });

  } catch (err) {
    console.error('[Evaluation] Admin update avatar error:', err.message);
    return res.status(500).json({ error: 'Failed to update avatar.' });
  }
});

// ----------------------------------------------------------------
// GET /evaluation/admin/suggestions — pending prompt suggestions
// ----------------------------------------------------------------
router.get('/admin/suggestions', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('avatar_prompt_suggestions')
      .select('*, evaluation_avatars(name, icon)')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw error;
    return res.json({ suggestions: data || [] });

  } catch (err) {
    console.error('[Evaluation] Admin suggestions error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch suggestions.' });
  }
});

// ----------------------------------------------------------------
// POST /evaluation/admin/suggestions/:id/approve
// Applies the suggested prompt to the avatar and marks it approved.
// ----------------------------------------------------------------
router.post('/admin/suggestions/:id/approve', requireAdmin, async (req, res) => {
  try {
    // Fetch the suggestion
    const { data: suggestion, error: fetchErr } = await supabaseAdmin
      .from('avatar_prompt_suggestions')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (fetchErr || !suggestion) {
      return res.status(404).json({ error: 'Suggestion not found.' });
    }

    // Apply the new prompt to the avatar
    await supabaseAdmin
      .from('evaluation_avatars')
      .update({
        system_prompt: suggestion.suggested_prompt,
        updated_at: new Date().toISOString()
      })
      .eq('id', suggestion.avatar_id);

    // Mark suggestion as approved
    await supabaseAdmin
      .from('avatar_prompt_suggestions')
      .update({
        status: 'approved',
        reviewed_at: new Date().toISOString()
      })
      .eq('id', req.params.id);

    // Invalidate avatar cache
    await cacheSet('eval_avatars', null, 1);

    return res.json({ success: true });

  } catch (err) {
    console.error('[Evaluation] Admin approve error:', err.message);
    return res.status(500).json({ error: 'Failed to approve suggestion.' });
  }
});

// ----------------------------------------------------------------
// POST /evaluation/admin/suggestions/:id/reject
// ----------------------------------------------------------------
router.post('/admin/suggestions/:id/reject', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('avatar_prompt_suggestions')
      .update({
        status: 'rejected',
        reviewed_at: new Date().toISOString()
      })
      .eq('id', req.params.id);

    if (error) throw error;
    return res.json({ success: true });

  } catch (err) {
    console.error('[Evaluation] Admin reject error:', err.message);
    return res.status(500).json({ error: 'Failed to reject suggestion.' });
  }
});

// ----------------------------------------------------------------
// PUT /evaluation/admin/settings — update evaluation settings
// ----------------------------------------------------------------
router.put('/admin/settings', requireAdmin, async (req, res) => {
  try {
    const { retention_days } = req.body;

    if (retention_days !== undefined) {
      const days = parseInt(retention_days, 10);
      if (isNaN(days) || days < 1 || days > 365) {
        return res.status(400).json({ error: 'retention_days must be 1-365.' });
      }

      await supabaseAdmin
        .from('evaluation_settings')
        .upsert({ key: 'retention_days', value: String(days) });
    }

    return res.json({ success: true });

  } catch (err) {
    console.error('[Evaluation] Admin settings error:', err.message);
    return res.status(500).json({ error: 'Failed to update settings.' });
  }
});

// ----------------------------------------------------------------
// POST /evaluation/admin/analyze — trigger meta-agent analysis
// Analyzes all avatar performance and generates prompt suggestions.
// ----------------------------------------------------------------
router.post('/admin/analyze', requireAdmin, async (req, res) => {
  try {
    const results = await runMetaAnalysis();
    return res.json({ results });
  } catch (err) {
    console.error('[Evaluation] Meta-analysis error:', err.message);
    return res.status(500).json({ error: 'Failed to run meta-analysis.' });
  }
});

module.exports = router;
