/**
 * routes/posts.js
 *
 * Generated post management: view, edit, approve, schedule, delete.
 * All routes require authentication and tenant enforcement.
 */

const express = require('express');
const router = express.Router();

// Platform specs for content validation (character limits, etc.)
const PLATFORM_SPECS = require('../../frontend/public/data/platformSpecs.json');

const { requireAuth } = require('../middleware/auth');
const { enforceTenancy } = require('../middleware/tenancy');
const { standardLimiter } = require('../middleware/rateLimit');
const { checkLimit }     = require('../middleware/checkLimit');
const { supabaseAdmin } = require('../services/supabaseService');
const { publishQueue, mediaProcessQueue, mediaAnalysisQueue } = require('../queues');

// Apply auth + tenancy to ALL routes in this file
router.use(requireAuth, enforceTenancy);

// ----------------------------------------------------------------
// GET /posts/dashboard-trends
// Returns 7-day daily counts for sparkline charts on the main dashboard.
// ----------------------------------------------------------------
router.get('/dashboard-trends', standardLimiter, async (req, res) => {
  try {
    // Build array of last 7 day strings (YYYY-MM-DD)
    const now = new Date();
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }

    // Fetch posts created in the last 7 days
    const { data: posts } = await req.db
      .from('posts')
      .select('status, published_at, created_at')
      .gte('created_at', days[0] + 'T00:00:00Z');

    // Fetch DM conversations from last 7 days
    const { data: convs } = await req.db
      .from('dm_conversations')
      .select('created_at, status')
      .gte('created_at', days[0] + 'T00:00:00Z');

    // Helper: count items per day by filter
    const countPerDay = (items, filterFn, dateField) =>
      days.map(d => ({
        date: d,
        count: (items || []).filter(item => filterFn(item) && item[dateField]?.slice(0, 10) === d).length
      }));

    const published = countPerDay(posts, p => p.status === 'published', 'published_at');
    const scheduled = countPerDay(posts, p => ['scheduled', 'approved'].includes(p.status), 'created_at');
    const conversations = countPerDay(convs, () => true, 'created_at');
    const leads = countPerDay(convs, c => c.status === 'completed', 'created_at');

    // Compute delta (today vs yesterday)
    const delta = (arr) => {
      const today = arr[arr.length - 1].count;
      const yesterday = arr[arr.length - 2].count;
      return { today, yesterday, change: today - yesterday };
    };

    res.json({
      published:     { trend: published,     ...delta(published) },
      scheduled:     { trend: scheduled,     ...delta(scheduled) },
      conversations: { trend: conversations, ...delta(conversations) },
      leads:         { trend: leads,         ...delta(leads) }
    });
  } catch (err) {
    console.error('[Posts] Dashboard trends error:', err.message);
    res.status(500).json({ error: 'Failed to load trends' });
  }
});

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

    // If media was attached, kick off background jobs for processing and analysis.
    if (updates.media_id) {
      try {
        const { data: mediaItem } = await supabaseAdmin
          .from('media_items')
          .select('process_status, file_type, analysis_status')
          .eq('id', updates.media_id)
          .single();

        // ── Media processing (copy to Supabase Storage) ──
        // Skip if already ready (e.g. AI-generated images are ready from creation).
        if (mediaItem && mediaItem.process_status !== 'ready') {
          const jobId = `process-media-${updates.media_id}`;
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

        // ── Video analysis (extract chapter thumbnails + vision tags) ──
        // Only queue analysis for videos that haven't been analyzed yet.
        // 'ready' means analysis is done — skip it. 'analyzing' means it's
        // currently running — skip it. Only 'pending' and 'failed' need work.
        // Without this check, re-attaching an already-analyzed video to a new
        // post would re-run the full FFmpeg analysis unnecessarily.
        if (mediaItem && mediaItem.file_type === 'video'
            && mediaItem.analysis_status !== 'ready'
            && mediaItem.analysis_status !== 'analyzing') {
          try {
            const analysisJobId = `analyze-video-${updates.media_id}`;
            const existingAnalysis = await mediaAnalysisQueue.getJob(analysisJobId);
            if (existingAnalysis) {
              const state = await existingAnalysis.getState();
              if (state !== 'active') await existingAnalysis.remove();
            }
            await mediaAnalysisQueue.add(
              'analyze-video',
              { mediaItemId: updates.media_id },
              { jobId: analysisJobId }
            );
            console.log(`[Posts] Queued video analysis for item ${updates.media_id}`);
          } catch (aErr) {
            console.warn('[Posts] Could not queue video analysis:', aErr.message);
          }
        }

      } catch (qErr) {
        // Non-fatal — startup seeders will catch missed jobs on next restart.
        console.warn('[Posts] Could not queue media jobs:', qErr.message);
      }
    }

    // Check text lengths against platform specs and return warnings
    const warnings = validatePostText(data);
    return res.json({ message: 'Post updated', post: data, warnings });

  } catch (err) {
    console.error('[Posts] Update error:', err.message);
    return res.status(500).json({ error: 'Failed to update post' });
  }
});

// ----------------------------------------------------------------
// POST /posts/:id/approve
// Mark a post as approved so it can be published.
// ----------------------------------------------------------------
router.post('/:id/approve', standardLimiter, checkLimit('scheduled_queue_size'), async (req, res) => {
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
router.post('/:id/schedule', standardLimiter, checkLimit('scheduled_queue_size'), async (req, res) => {
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
        // 2-second delay gives the DB write time to commit before the scan runs.
        // Without this, the priority job can run before the post is visible in the DB,
        // find nothing, and complete empty — leaving the post for the next 60s cycle.
        await publishQueue.add('scan-and-publish', {}, { priority: 1, delay: 2000 });
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
// POST /posts/:id/pause
// Pauses a scheduled or approved post so the publishing worker skips it.
// The scheduled_at timestamp is preserved so the user can resume later.
// ----------------------------------------------------------------
router.post('/:id/pause', standardLimiter, async (req, res) => {
  try {
    const { data: post, error: fetchError } = await req.db
      .from('posts')
      .select('id, status')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    if (!['scheduled', 'approved', 'publishing'].includes(post.status)) {
      return res.status(400).json({
        error: `Cannot pause a post with status "${post.status}". Only scheduled or publishing posts can be paused.`
      });
    }

    const { data, error } = await req.db
      .from('posts')
      .update({ status: 'paused' })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);

    return res.json({ message: 'Post paused', post: data });

  } catch (err) {
    console.error('[Posts] Pause error:', err.message);
    return res.status(500).json({ error: 'Failed to pause post' });
  }
});

// ----------------------------------------------------------------
// POST /posts/:id/resume
// Resumes a paused post by setting it back to scheduled.
// If the scheduled_at is in the past, the worker picks it up on the next cycle.
// ----------------------------------------------------------------
router.post('/:id/resume', standardLimiter, async (req, res) => {
  try {
    const { data: post, error: fetchError } = await req.db
      .from('posts')
      .select('id, status, scheduled_at')
      .eq('id', req.params.id)
      .single();

    if (fetchError || !post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    if (post.status !== 'paused') {
      return res.status(400).json({
        error: `Cannot resume a post with status "${post.status}". Only paused posts can be resumed.`
      });
    }

    const { data, error } = await req.db
      .from('posts')
      .update({ status: 'scheduled' })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);

    // If the post is due now or in the past, fire an immediate publish scan
    const scheduledAt = new Date(post.scheduled_at);
    const fiveMinutesFromNow = new Date(Date.now() + 5 * 60 * 1000);
    if (scheduledAt <= fiveMinutesFromNow) {
      try {
        const { publishQueue } = require('../queues');
        await publishQueue.add('scan-and-publish', {}, { priority: 1, delay: 2000 });
      } catch (qErr) {
        console.warn('[Posts] Could not trigger immediate publish scan:', qErr.message);
      }
    }

    return res.json({ message: 'Post resumed', post: data });

  } catch (err) {
    console.error('[Posts] Resume error:', err.message);
    return res.status(500).json({ error: 'Failed to resume post' });
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

// ----------------------------------------------------------------
// validatePostText
// Checks a post's text fields against the platform's character limits
// from platformSpecs.json. Returns an array of warning strings.
// ----------------------------------------------------------------
function validatePostText(post) {
  const warnings = [];
  const spec = PLATFORM_SPECS[post.platform];
  if (!spec?.text) return warnings;

  // YouTube has separate title/description limits
  if (spec.text.title && spec.text.description) {
    const titleLen = (post.hook || '').length;
    const descLen = [post.caption, _hashtagString(post.hashtags), post.cta]
      .filter(Boolean).join('\n\n').length;
    if (titleLen > spec.text.title) {
      warnings.push(`Title is ${titleLen}/${spec.text.title} chars for ${post.platform}`);
    }
    if (descLen > spec.text.description) {
      warnings.push(`Description is ${descLen}/${spec.text.description} chars for ${post.platform}`);
    }
    return warnings;
  }

  // All other platforms: combined text limit
  if (spec.text.combined) {
    const fields = spec.text.fields || ['hook', 'caption', 'hashtags', 'cta'];
    const parts = fields.map(f => {
      if (f === 'hashtags') return _hashtagString(post.hashtags);
      return post[f] || '';
    });
    const totalLen = parts.filter(Boolean).join('\n\n').length;
    if (totalLen > spec.text.combined) {
      warnings.push(`${spec.text.label || 'Text'} is ${totalLen}/${spec.text.combined} chars for ${post.platform}`);
    }
  }

  return warnings;
}

// Helper: convert hashtags array to display string
function _hashtagString(hashtags) {
  if (!Array.isArray(hashtags) || !hashtags.length) return '';
  return hashtags.map(h => `#${h}`).join(' ');
}

module.exports = router;
