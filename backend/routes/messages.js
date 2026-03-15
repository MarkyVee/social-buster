/**
 * routes/messages.js
 *
 * User-facing messaging routes.
 *
 * Users can:
 *   - View messages sent to them from admin (direct or broadcast to all)
 *   - Send messages to admin (support requests, questions)
 *   - Reply to admin messages
 *   - Mark messages as read
 *
 * All routes require authentication (requireAuth).
 * Admin messaging routes live in routes/admin.js.
 */

const express = require('express');
const router  = express.Router();

const { requireAuth }   = require('../middleware/auth');
const { supabaseAdmin } = require('../services/supabaseService');

// All routes require a valid JWT
router.use(requireAuth);

// ----------------------------------------------------------------
// GET /messages
//
// User's inbox or sent messages.
// Query: ?type=inbox (default) | sent
//
// inbox — direct messages from admin + admin broadcasts
// sent  — messages this user sent to admin (including replies)
// ----------------------------------------------------------------
router.get('/', async (req, res) => {
  const userId = req.user.id;
  const type   = req.query.type || 'inbox';

  try {
    let query;

    if (type === 'sent') {
      // All messages/replies this user has sent to admin
      query = supabaseAdmin
        .from('admin_messages')
        .select('id, subject, body, is_broadcast, read_at, parent_id, created_at, sender_email')
        .eq('sender_id', userId)
        .eq('sender_type', 'user')
        .is('parent_id', null)          // top-level messages only (replies appear in threads)
        .order('created_at', { ascending: false });

    } else {
      // Inbox: direct messages to this user + all admin broadcasts
      query = supabaseAdmin
        .from('admin_messages')
        .select('id, subject, body, is_broadcast, read_at, parent_id, created_at, sender_email')
        .eq('sender_type', 'admin')
        .is('parent_id', null)
        .or(`recipient_id.eq.${userId},is_broadcast.eq.true`)
        .order('created_at', { ascending: false });
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return res.json({ messages: data || [] });

  } catch (err) {
    console.error('[Messages] List error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// ----------------------------------------------------------------
// GET /messages/unread-count
//
// Returns the number of unread direct messages from admin.
// Used for the notification badge in the sidebar.
// Always returns 200 with { unread: N } — badge just shows 0 on error.
// ----------------------------------------------------------------
router.get('/unread-count', async (req, res) => {
  const userId = req.user.id;

  try {
    const { count, error } = await supabaseAdmin
      .from('admin_messages')
      .select('*', { count: 'exact', head: true })
      .eq('sender_type', 'admin')
      .eq('recipient_id', userId)
      .is('read_at', null);

    if (error) throw new Error(error.message);

    return res.json({ unread: count || 0 });

  } catch (err) {
    console.error('[Messages] Unread count error:', err.message);
    return res.json({ unread: 0 }); // non-fatal — badge just shows 0
  }
});

// ----------------------------------------------------------------
// GET /messages/:id
//
// Single message + all replies in the thread.
// Auto-marks direct admin→user messages as read when opened.
// ----------------------------------------------------------------
router.get('/:id', async (req, res) => {
  const userId    = req.user.id;
  const messageId = req.params.id;

  try {
    // Fetch root message — must be accessible to this user
    const { data: message, error: msgErr } = await supabaseAdmin
      .from('admin_messages')
      .select('id, subject, body, sender_type, is_broadcast, recipient_id, read_at, parent_id, created_at, sender_email')
      .eq('id', messageId)
      .or(`recipient_id.eq.${userId},is_broadcast.eq.true,sender_id.eq.${userId}`)
      .single();

    if (msgErr || !message) {
      return res.status(404).json({ error: 'Message not found' });
    }

    // Auto-mark as read when the user opens a direct message from admin
    if (message.sender_type === 'admin' && message.recipient_id === userId && !message.read_at) {
      await supabaseAdmin
        .from('admin_messages')
        .update({ read_at: new Date().toISOString() })
        .eq('id', messageId);
      message.read_at = new Date().toISOString();
    }

    // Fetch replies in chronological order for threaded view
    const { data: replies } = await supabaseAdmin
      .from('admin_messages')
      .select('id, body, sender_type, sender_email, created_at')
      .eq('parent_id', messageId)
      .order('created_at', { ascending: true });

    return res.json({ message, replies: replies || [] });

  } catch (err) {
    console.error('[Messages] Get error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch message' });
  }
});

// ----------------------------------------------------------------
// POST /messages
//
// User sends a new message to admin (support request, question).
// Body: { subject: string, body: string }
// ----------------------------------------------------------------
router.post('/', async (req, res) => {
  const userId = req.user.id;
  const { subject, body } = req.body;

  if (!subject?.trim()) return res.status(400).json({ error: 'Subject is required' });
  if (!body?.trim())    return res.status(400).json({ error: 'Message body is required' });

  try {
    const { data, error } = await supabaseAdmin
      .from('admin_messages')
      .insert({
        sender_type:  'user',
        sender_id:    userId,
        sender_email: req.user.email,
        recipient_id: null,        // null = goes to admin inbox
        is_broadcast: false,
        subject:      subject.trim().slice(0, 255),
        body:         body.trim()
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    console.log(`[Messages] New message from ${req.user.email}: "${subject}"`);
    return res.status(201).json({ message: data });

  } catch (err) {
    console.error('[Messages] Send error:', err.message);
    return res.status(500).json({ error: 'Failed to send message' });
  }
});

// ----------------------------------------------------------------
// POST /messages/:id/reply
//
// User replies to an admin message.
// Body: { body: string }
// ----------------------------------------------------------------
router.post('/:id/reply', async (req, res) => {
  const userId   = req.user.id;
  const parentId = req.params.id;
  const { body } = req.body;

  if (!body?.trim()) return res.status(400).json({ error: 'Reply body is required' });

  try {
    // Verify parent message exists and is accessible to this user
    const { data: parent, error: parentErr } = await supabaseAdmin
      .from('admin_messages')
      .select('id, subject, recipient_id, is_broadcast')
      .eq('id', parentId)
      .or(`recipient_id.eq.${userId},is_broadcast.eq.true,sender_id.eq.${userId}`)
      .single();

    if (parentErr || !parent) {
      return res.status(404).json({ error: 'Message not found' });
    }

    const { data, error } = await supabaseAdmin
      .from('admin_messages')
      .insert({
        sender_type:  'user',
        sender_id:    userId,
        sender_email: req.user.email,
        recipient_id: null,
        is_broadcast: false,
        subject:      `Re: ${parent.subject}`,
        body:         body.trim(),
        parent_id:    parentId
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    return res.status(201).json({ reply: data });

  } catch (err) {
    console.error('[Messages] Reply error:', err.message);
    return res.status(500).json({ error: 'Failed to send reply' });
  }
});

// ----------------------------------------------------------------
// PUT /messages/:id/read
//
// Explicitly mark a direct message as read (from list view).
// Auto-read also happens on GET /:id when message is opened.
// ----------------------------------------------------------------
router.put('/:id/read', async (req, res) => {
  const userId    = req.user.id;
  const messageId = req.params.id;

  try {
    const { error } = await supabaseAdmin
      .from('admin_messages')
      .update({ read_at: new Date().toISOString() })
      .eq('id', messageId)
      .eq('recipient_id', userId)
      .is('read_at', null);

    if (error) throw new Error(error.message);

    return res.json({ ok: true });

  } catch (err) {
    console.error('[Messages] Mark read error:', err.message);
    return res.status(500).json({ error: 'Failed to mark message as read' });
  }
});

module.exports = router;
