/**
 * routes/posts.js
 *
 * Generated post management: view, edit, approve, schedule, delete.
 * All routes require authentication and tenant enforcement.
 */

const express = require('express');
const router = express.Router();

const { requireAuth } = require('../middleware/auth');
const { enforceTenancy } = require('../middleware/tenancy');
const { standardLimiter } = require('../middleware/rateLimit');
const { supabaseAdmin } = require('../services/supabaseService');

// Apply auth + tenancy to ALL routes in this file
router.use(requireAuth, enforceTenancy);

// ----------------------------------------------------------------
// GET /posts
// List all posts for the current user.
// Optional query params: ?status=draft&platform=instagram&brief_id=uuid
// ----------------------------------------------------------------
router.get('/', standardLimiter, async (req, res) => {
  try {
    let query = req.db
      .from('posts')
      .select('*, briefs(post_type, objective, tone, created_at)')
      .order('created_at', { ascending: false });

    // Apply optional filters from query string
    if (req.query.status)   query = query.eq('status', req.query.status);
    if (req.query.platform) query = query.eq('platform', req.query.platform);
    if (req.query.brief_id) query = query.eq('brief_id', req.query.brief_id);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return res.json({ posts: data });

  } catch (err) {
    console.error('[Posts] List error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// ----------------------------------------------------------------
// GET /posts/:id
// Fetch a single post by ID.
// ----------------------------------------------------------------
router.get('/:id', standardLimiter, async (req, res) => {
  try {
    const { data, error } = await req.db
      .from('posts')
      .select('*, briefs(post_type, objective, tone, target_audience)')
      .eq('id', req.params.id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Post not found' });
    }

    return res.json({ post: data });

  } catch (err) {
    console.error('[Posts] Get error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch post' });
  }
});

// ----------------------------------------------------------------
// PUT /posts/:id
// Inline-edit a post's content fields.
// Allows editing: hook, caption, hashtags, cta, media_id.
// Pass media_id: null to detach media. Cannot change platform,
// brief_id, or status through this route.
// ----------------------------------------------------------------
router.put('/:id', standardLimiter, async (req, res) => {
  const { hook, caption, hashtags, cta, media_id, trim_start_seconds } = req.body;

  // Build update object from only the fields that were sent
  const updates = {};
  if (hook    !== undefined) updates.hook    = hook;
  if (caption !== undefined) updates.caption = caption;
  if (cta     !== undefined) updates.cta     = cta;
  if (hashtags !== undefined) {
    if (!Array.isArray(hashtags)) {
      return res.status(400).json({ error: 'hashtags must be an array of strings' });
    }
    // Strip # prefix from any hashtags that have it
    updates.hashtags = hashtags.map(h => String(h).replace(/^#/, '').trim());
  }
  // media_id can be a UUID (attach) or null (detach). Explicitly check for the key
  // being present so callers can pass null to remove media.
  if ('media_id' in req.body) {
    updates.media_id = media_id || null;
  }
  // trim_start_seconds — where to begin the trim (0 = from start). Must be a non-negative integer.
  if (trim_start_seconds !== undefined) {
    const trimStart = parseInt(trim_start_seconds, 10);
    if (isNaN(trimStart) || trimStart < 0) {
      return res.status(400).json({ error: 'trim_start_seconds must be a non-negative integer' });
    }
    updates.trim_start_seconds = trimStart;
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields provided to update' });
  }

  try {
    const { data, error } = await req.db
      .from('posts')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Post not found or update failed' });
    }

    return res.json({ message: 'Post updated', post: data });

  } catch (err) {
    console.error('[Posts] Update error:', err.message);
    return res.status(500).json({ error: 'Failed to update post' });
  }
});

// ----------------------------------------------------------------
// POST /posts/:id/approve
// Mark a post as approved so it can be published.
// ----------------------------------------------------------------
router.post('/:id/approve', standardLimiter, async (req, res) => {
  try {
    // Verify the post exists and belongs to this user before approving
    const { data: post, error: fetchError } = await req.db
      .from('posts')
      .select('id, status')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    if (post.status === 'published') {
      return res.status(400).json({ error: 'This post is already published' });
    }

    const { data, error } = await req.db
      .from('posts')
      .update({ status: 'approved' })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);

    return res.json({ message: 'Post approved and ready to publish', post: data });

  } catch (err) {
    console.error('[Posts] Approve error:', err.message);
    return res.status(500).json({ error: 'Failed to approve post' });
  }
});

// ----------------------------------------------------------------
// POST /posts/:id/schedule
// Schedule a post for publishing at a specific date and time.
// Body: { scheduled_at: "2025-06-01T10:00:00Z" }
// ----------------------------------------------------------------
router.post('/:id/schedule', standardLimiter, async (req, res) => {
  const { scheduled_at } = req.body;

  if (!scheduled_at) {
    return res.status(400).json({ error: 'scheduled_at (ISO datetime) is required' });
  }

  const scheduledDate = new Date(scheduled_at);
  if (isNaN(scheduledDate.getTime())) {
    return res.status(400).json({ error: 'scheduled_at must be a valid ISO datetime string' });
  }

  // Allow up to 60 seconds in the past so "Publish Now" (scheduled_at = now)
  // is never rejected by a small clock-skew between client and server.
  const sixtySecondsAgo = new Date(Date.now() - 60 * 1000);
  if (scheduledDate < sixtySecondsAgo) {
    return res.status(400).json({ error: 'scheduled_at must be in the future' });
  }

  try {
    const { data, error } = await req.db
      .from('posts')
      .update({ status: 'scheduled', scheduled_at: scheduledDate.toISOString() })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Post not found or scheduling failed' });
    }

    return res.json({ message: 'Post scheduled', post: data });

  } catch (err) {
    console.error('[Posts] Schedule error:', err.message);
    return res.status(500).json({ error: 'Failed to schedule post' });
  }
});

// ----------------------------------------------------------------
// DELETE /posts/:id
// Delete a draft post. Cannot delete published posts.
// ----------------------------------------------------------------
router.delete('/:id', standardLimiter, async (req, res) => {
  try {
    // Check status before deleting — don't allow deleting published posts
    const { data: post, error: fetchError } = await req.db
      .from('posts')
      .select('id, status')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    if (post.status === 'published') {
      return res.status(400).json({ error: 'Published posts cannot be deleted' });
    }

    const { error } = await req.db
      .from('posts')
      .delete()
      .eq('id', req.params.id);

    if (error) throw new Error(error.message);

    return res.json({ message: 'Post deleted' });

  } catch (err) {
    console.error('[Posts] Delete error:', err.message);
    return res.status(500).json({ error: 'Failed to delete post' });
  }
});

module.exports = router;
