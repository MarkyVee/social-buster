/**
 * routes/email.js
 *
 * Admin-only routes for the bulk email system.
 *
 * Two resources:
 *   Groups    — recipient lists (filter-based or manual)
 *   Campaigns — email blasts (subject + body → group)
 *
 * All routes require admin auth. All queries use supabaseAdmin
 * (admin-only tables, no RLS).
 *
 * Routes:
 *   GET    /email/groups              — list all groups
 *   POST   /email/groups              — create a group
 *   GET    /email/groups/:id          — get one group
 *   PUT    /email/groups/:id          — update a group
 *   DELETE /email/groups/:id          — delete a group
 *   GET    /email/groups/:id/preview  — resolve group → list of matching users
 *
 *   GET    /email/campaigns           — list all campaigns
 *   POST   /email/campaigns           — create a campaign (draft)
 *   GET    /email/campaigns/:id       — get campaign + delivery logs
 *   POST   /email/campaigns/:id/send  — trigger send via BullMQ
 */

const express = require('express');
const router  = express.Router();

const { requireAuth }        = require('../middleware/auth');
const { requireAdmin }       = require('../middleware/adminAuth');
const { supabaseAdmin }      = require('../services/supabaseService');
const { resolveGroupMembers } = require('../services/emailGroupResolver');
const { emailQueue }         = require('../queues');

// All routes in this file require admin access
router.use(requireAuth, requireAdmin);

// ================================================================
// GROUPS
// ================================================================

// ----------------------------------------------------------------
// GET /email/groups — list all groups, newest first
// ----------------------------------------------------------------
router.get('/groups', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('email_groups')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ groups: data || [] });

  } catch (err) {
    console.error('[Email] Failed to list groups:', err.message);
    res.status(500).json({ error: 'Failed to load email groups' });
  }
});

// ----------------------------------------------------------------
// POST /email/groups — create a new group
// Body: { name, description, group_type, filter_criteria, manual_user_ids }
// ----------------------------------------------------------------
router.post('/groups', async (req, res) => {
  try {
    const { name, description, group_type, filter_criteria, manual_user_ids } = req.body;

    if (!name || !group_type) {
      return res.status(400).json({ error: 'name and group_type are required' });
    }
    if (!['filter', 'manual'].includes(group_type)) {
      return res.status(400).json({ error: 'group_type must be "filter" or "manual"' });
    }

    const { data, error } = await supabaseAdmin
      .from('email_groups')
      .insert({
        name,
        description: description || null,
        group_type,
        filter_criteria: group_type === 'filter' ? (filter_criteria || {}) : {},
        manual_user_ids: group_type === 'manual' ? (manual_user_ids || []) : []
      })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ group: data });

  } catch (err) {
    console.error('[Email] Failed to create group:', err.message);
    res.status(500).json({ error: 'Failed to create email group' });
  }
});

// ----------------------------------------------------------------
// GET /email/groups/:id — get one group
// ----------------------------------------------------------------
router.get('/groups/:id', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('email_groups')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Group not found' });

    res.json({ group: data });

  } catch (err) {
    console.error('[Email] Failed to get group:', err.message);
    res.status(500).json({ error: 'Failed to load email group' });
  }
});

// ----------------------------------------------------------------
// PUT /email/groups/:id — update a group
// Body: partial fields { name, description, group_type, filter_criteria, manual_user_ids }
// ----------------------------------------------------------------
router.put('/groups/:id', async (req, res) => {
  try {
    const updates = {};
    const { name, description, group_type, filter_criteria, manual_user_ids } = req.body;

    if (name !== undefined)             updates.name = name;
    if (description !== undefined)      updates.description = description;
    if (group_type !== undefined)       updates.group_type = group_type;
    if (filter_criteria !== undefined)  updates.filter_criteria = filter_criteria;
    if (manual_user_ids !== undefined)  updates.manual_user_ids = manual_user_ids;
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('email_groups')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.json({ group: data });

  } catch (err) {
    console.error('[Email] Failed to update group:', err.message);
    res.status(500).json({ error: 'Failed to update email group' });
  }
});

// ----------------------------------------------------------------
// DELETE /email/groups/:id — delete a group
// ----------------------------------------------------------------
router.delete('/groups/:id', async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('email_groups')
      .delete()
      .eq('id', req.params.id);

    if (error) throw error;
    res.json({ success: true });

  } catch (err) {
    console.error('[Email] Failed to delete group:', err.message);
    res.status(500).json({ error: 'Failed to delete email group' });
  }
});

// ----------------------------------------------------------------
// GET /email/groups/:id/preview — resolve group members
// Returns the list of users that would receive emails.
// ----------------------------------------------------------------
router.get('/groups/:id/preview', async (req, res) => {
  try {
    const { data: group, error } = await supabaseAdmin
      .from('email_groups')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const result = await resolveGroupMembers(group);
    res.json(result);

  } catch (err) {
    console.error('[Email] Failed to preview group:', err.message);
    res.status(500).json({ error: 'Failed to preview group members' });
  }
});

// ================================================================
// CAMPAIGNS
// ================================================================

// ----------------------------------------------------------------
// GET /email/campaigns — list all campaigns with group name, newest first
// ----------------------------------------------------------------
router.get('/campaigns', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('email_campaigns')
      .select('*, email_groups(name)')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Flatten the group name into the campaign object for easier frontend use
    const campaigns = (data || []).map(c => ({
      ...c,
      group_name: c.email_groups?.name || '(deleted group)',
      email_groups: undefined  // remove the nested object
    }));

    res.json({ campaigns });

  } catch (err) {
    console.error('[Email] Failed to list campaigns:', err.message);
    res.status(500).json({ error: 'Failed to load email campaigns' });
  }
});

// ----------------------------------------------------------------
// POST /email/campaigns — create a new campaign (status = 'draft')
// Body: { group_id, subject, body }
// ----------------------------------------------------------------
router.post('/campaigns', async (req, res) => {
  try {
    const { group_id, subject, body } = req.body;

    if (!group_id || !subject || !body) {
      return res.status(400).json({ error: 'group_id, subject, and body are required' });
    }

    // Verify the group exists
    const { data: group, error: groupErr } = await supabaseAdmin
      .from('email_groups')
      .select('id')
      .eq('id', group_id)
      .single();

    if (groupErr || !group) {
      return res.status(400).json({ error: 'Group not found' });
    }

    const { data, error } = await supabaseAdmin
      .from('email_campaigns')
      .insert({ group_id, subject, body, status: 'draft' })
      .select()
      .single();

    if (error) throw error;
    res.status(201).json({ campaign: data });

  } catch (err) {
    console.error('[Email] Failed to create campaign:', err.message);
    res.status(500).json({ error: 'Failed to create email campaign' });
  }
});

// ----------------------------------------------------------------
// GET /email/campaigns/:id — get campaign detail + delivery logs
// ----------------------------------------------------------------
router.get('/campaigns/:id', async (req, res) => {
  try {
    const { data: campaign, error: campErr } = await supabaseAdmin
      .from('email_campaigns')
      .select('*, email_groups(name)')
      .eq('id', req.params.id)
      .single();

    if (campErr) throw campErr;
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Fetch delivery logs
    const { data: logs, error: logErr } = await supabaseAdmin
      .from('email_campaign_logs')
      .select('*')
      .eq('campaign_id', req.params.id)
      .order('sent_at', { ascending: false });

    if (logErr) throw logErr;

    res.json({
      campaign: {
        ...campaign,
        group_name: campaign.email_groups?.name || '(deleted group)',
        email_groups: undefined
      },
      logs: logs || []
    });

  } catch (err) {
    console.error('[Email] Failed to get campaign:', err.message);
    res.status(500).json({ error: 'Failed to load email campaign' });
  }
});

// ----------------------------------------------------------------
// POST /email/campaigns/:id/send — trigger the campaign send
//
// Guards:
//   - Campaign must be in 'draft' or 'failed' status
//   - Prevents double-send if already 'sending' or 'sent'
// ----------------------------------------------------------------
router.post('/campaigns/:id/send', async (req, res) => {
  try {
    const { data: campaign, error: fetchErr } = await supabaseAdmin
      .from('email_campaigns')
      .select('id, status')
      .eq('id', req.params.id)
      .single();

    if (fetchErr) throw fetchErr;
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    // Only allow sending from draft or failed (re-send after fixing issue)
    if (!['draft', 'failed'].includes(campaign.status)) {
      return res.status(400).json({
        error: `Campaign is already "${campaign.status}" — cannot send again`
      });
    }

    // Update status to 'sending' (acts as a lock against double-clicks)
    await supabaseAdmin
      .from('email_campaigns')
      .update({ status: 'sending' })
      .eq('id', campaign.id);

    // Queue the send job
    await emailQueue.add(
      'send-campaign',
      { campaignId: campaign.id },
      { jobId: `send-campaign-${campaign.id}` }
    );

    res.json({ success: true, message: 'Campaign queued for sending' });

  } catch (err) {
    console.error('[Email] Failed to send campaign:', err.message);
    res.status(500).json({ error: 'Failed to send campaign' });
  }
});

module.exports = router;
