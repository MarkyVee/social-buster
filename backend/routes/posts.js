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
const { publishQueue, mediaProcessQueue } = require('../queues');

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

    // If media was attached, kick off background processing.
    // This copies the file from its cloud source (Google Drive, etc.) to Supabase
    // Storage so the publish worker can use a simple public URL — no OAuth at publish time.
    if (updates.media_id) {
      try {
        // Check if this item already has a processed URL (e.g. AI-generated images
        // that were backfilled by the SQL migration). Skip if already ready.
        const { data: mediaItem } = await supabaseAdmin
          .from('media_items')
          .select('process_status')
          .eq('id', updates.media_id)
          .single();

        if (mediaItem && mediaItem.process_status !== 'ready') {
          const jobId = `process-media-${updates.media_id}`;

          // Remove any existing failed/completed job with this ID so BullMQ
          // doesn't silently ignore the new add() call (duplicate jobId prevention).
          try {
            const existing = await mediaProcessQueue.getJob(jobId);
            if (existing) {
              const state = await existing.getState();
              if (state !== 'active') await existing.remove();
            }
          } catch (_) { /* non-fatal */ }

          await mediaProcessQueue.add(
            'process-media-item',
            { mediaItemId: updates.media_id },
            { jobId, removeOnComplete: true, removeOnFail: true }
          );
          console.log(`[Posts] Queued media processing for item ${updates.media_id}`);
        }
      } catch (qErr) {
        // Non-fatal: if queueing fails, the worker will catch it at startup via
        // seedPendingMediaProcessing(). The post is still saved correctly.
        console.warn('[Posts] Could not queue media processing:', qErr.message);
      }
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

    // If the post is scheduled for right now (within the next 5 minutes),
    // fire an immediate one-off scan job so it publishes within seconds
    // instead of waiting up to 60s for the next repeatable scan cycle.
    const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
    if (scheduledDate <= fiveMinutesFromNow) {
      try {
        await publishQueue.add('scan-and-publish', {}, { priority: 1 });
      } catch (qErr) {
        // Non-fatal — the repeatable scan will still pick it up within 60s
        console.warn('[Posts] Could not trigger immediate publish scan:', qErr.message);
      }
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
