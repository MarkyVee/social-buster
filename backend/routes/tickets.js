/**
 * routes/tickets.js
 *
 * User-facing support ticket routes.
 *
 * Users can:
 *   - Submit a new issue (guided form from Messages page)
 *   - View their own submitted tickets + status updates
 *   - Upload a screenshot for a ticket
 *
 * All routes require authentication (requireAuth).
 * Admin ticket management routes live in routes/admin.js.
 */

const express = require('express');
const router  = express.Router();
const axios   = require('axios');

const { requireAuth }   = require('../middleware/auth');
const { supabaseAdmin } = require('../services/supabaseService');

// All routes require a valid JWT
router.use(requireAuth);

// ----------------------------------------------------------------
// GET /tickets
//
// List the current user's support tickets, newest first.
// ----------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('support_tickets')
      .select('id, feature, what_happened, priority, status, admin_notes, created_at, updated_at, resolved_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return res.json({ tickets: data || [] });

  } catch (err) {
    console.error('[Tickets] List error:', err.message);
    return res.status(500).json({ error: 'Failed to load your tickets' });
  }
});

// ----------------------------------------------------------------
// GET /tickets/:id
//
// Single ticket detail (user can only see their own via RLS + filter).
// ----------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('support_tickets')
      .select('*')
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Ticket not found' });

    return res.json({ ticket: data });

  } catch (err) {
    console.error('[Tickets] Detail error:', err.message);
    return res.status(500).json({ error: 'Failed to load ticket' });
  }
});

// ----------------------------------------------------------------
// POST /tickets
//
// Submit a new support ticket.
// Body: { feature, what_happened, expected, steps?, browser_info?, priority }
// ----------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const { feature, what_happened, expected, steps, browser_info, priority } = req.body;

    // Validate required fields
    if (!feature || !what_happened || !expected) {
      return res.status(400).json({
        error: 'Please fill in: what part of the app, what happened, and what you expected.'
      });
    }

    const validPriorities = ['low', 'medium', 'high', 'critical'];
    const safePriority = validPriorities.includes(priority) ? priority : 'medium';

    const { data, error } = await supabaseAdmin
      .from('support_tickets')
      .insert({
        user_id:       req.user.id,
        user_email:    req.user.email,
        feature,
        what_happened,
        expected,
        steps:         steps || null,
        browser_info:  browser_info || null,
        priority:      safePriority,
        status:        'open'
      })
      .select()
      .single();

    if (error) throw error;

    console.log(`[Tickets] New ticket ${data.id} from ${req.user.email} — ${feature} (${safePriority})`);
    return res.status(201).json({ ticket: data });

  } catch (err) {
    console.error('[Tickets] Create error:', err.message);
    return res.status(500).json({ error: 'Failed to submit your ticket' });
  }
});

// ----------------------------------------------------------------
// POST /tickets/:id/screenshot
//
// Upload a screenshot for an existing ticket.
// Expects raw image body with Content-Type header (image/png, image/jpeg, etc.).
// Stores in Supabase Storage "support-screenshots" bucket.
// ----------------------------------------------------------------
router.post('/:id/screenshot', express.raw({ type: 'image/*', limit: '5mb' }), async (req, res) => {
  try {
    const ticketId = req.params.id;

    // Verify the ticket belongs to this user
    const { data: ticket, error: ticketErr } = await supabaseAdmin
      .from('support_tickets')
      .select('id')
      .eq('id', ticketId)
      .eq('user_id', req.user.id)
      .maybeSingle();

    if (ticketErr) throw ticketErr;
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    if (!req.body || req.body.length === 0) {
      return res.status(400).json({ error: 'No image data received' });
    }

    // Determine file extension from content type
    const contentType = req.headers['content-type'] || 'image/png';
    const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' : 'png';
    const fileName = `${req.user.id}/${ticketId}.${ext}`;

    // Upload to Supabase Storage
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey  = process.env.SUPABASE_SERVICE_ROLE_KEY;

    const uploadRes = await axios.post(
      `${supabaseUrl}/storage/v1/object/support-screenshots/${fileName}`,
      req.body,
      {
        headers: {
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': contentType,
          'x-upsert': 'true'
        },
        timeout: 30000,
        maxContentLength: 5 * 1024 * 1024
      }
    );

    if (uploadRes.status !== 200) {
      throw new Error(`Storage upload returned ${uploadRes.status}`);
    }

    // Build the public URL
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/support-screenshots/${fileName}`;

    // Update the ticket with the screenshot URL
    await supabaseAdmin
      .from('support_tickets')
      .update({ screenshot_url: publicUrl })
      .eq('id', ticketId);

    return res.json({ screenshot_url: publicUrl });

  } catch (err) {
    console.error('[Tickets] Screenshot upload error:', err.message);
    return res.status(500).json({ error: 'Failed to upload screenshot' });
  }
});

module.exports = router;
