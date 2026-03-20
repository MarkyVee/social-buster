/**
 * routes/automations.js
 *
 * CRUD for DM automations — per-post trigger keywords and DM flows.
 * Also provides lead data viewing and CSV export.
 *
 * Routes:
 *   GET    /api/automations              — list all automations for the user
 *   GET    /api/automations/:id          — get one automation with its steps
 *   POST   /api/automations              — create a new automation (with steps)
 *   PUT    /api/automations/:id          — update an automation (with steps)
 *   DELETE /api/automations/:id          — delete an automation
 *   GET    /api/automations/:id/leads    — list collected leads for an automation
 *   GET    /api/automations/leads/export — CSV export of all leads
 *   GET    /api/automations/stats        — DM usage stats (daily counts, limits)
 *
 * All routes require authentication (auth middleware).
 * All routes use req.db (user-scoped — never supabaseAdmin).
 */

const express = require('express');
const router  = express.Router();
const { requireAuth }    = require('../middleware/auth');
const { enforceTenancy } = require('../middleware/tenancy');
const { supabaseAdmin }  = require('../services/supabaseService');
const { getDailyUsage }  = require('../services/messagingService');

// All routes require authentication + tenant scoping
router.use(requireAuth, enforceTenancy);

// ----------------------------------------------------------------
// GET /automations — list all automations for the current user.
// Includes post title for display and conversation count.
// ----------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { data, error } = await req.db
      .from('dm_automations')
      .select(`
        *,
        posts ( id, hook, platform, status )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Add conversation counts per automation
    for (const automation of (data || [])) {
      const { count } = await req.db
        .from('dm_conversations')
        .select('id', { count: 'exact', head: true })
        .eq('automation_id', automation.id);
      automation.conversation_count = count || 0;

      const { count: completedCount } = await req.db
        .from('dm_conversations')
        .select('id', { count: 'exact', head: true })
        .eq('automation_id', automation.id)
        .eq('status', 'completed');
      automation.completed_count = completedCount || 0;
    }

    res.json({ automations: data || [] });
  } catch (err) {
    console.error('[Automations] List error:', err.message);
    res.status(500).json({ error: 'Failed to list automations' });
  }
});

// ----------------------------------------------------------------
// GET /api/automations/stats — DM usage stats (daily send counts + limits).
// ----------------------------------------------------------------
router.get('/stats', async (req, res) => {
  try {
    const facebook  = await getDailyUsage(req.user.id, 'facebook');
    const instagram = await getDailyUsage(req.user.id, 'instagram');

    // Total conversations
    const { count: totalConversations } = await req.db
      .from('dm_conversations')
      .select('id', { count: 'exact', head: true });

    const { count: activeConversations } = await req.db
      .from('dm_conversations')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active');

    const { count: totalLeads } = await req.db
      .from('dm_collected_data')
      .select('id', { count: 'exact', head: true });

    res.json({
      daily_usage: { facebook, instagram },
      conversations: {
        total:  totalConversations || 0,
        active: activeConversations || 0
      },
      total_leads: totalLeads || 0
    });
  } catch (err) {
    console.error('[Automations] Stats error:', err.message);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// ----------------------------------------------------------------
// GET /api/automations/leads/export — CSV export of all collected leads.
// Query params: automation_id (optional filter), from, to (date range)
// ----------------------------------------------------------------
router.get('/leads/export', async (req, res) => {
  try {
    const { automation_id, from, to } = req.query;

    // Build query for conversations with collected data
    let query = supabaseAdmin
      .from('dm_collected_data')
      .select(`
        field_name,
        field_value,
        collected_at,
        dm_conversations!inner (
          author_handle,
          platform,
          automation_id,
          created_at,
          dm_automations!inner ( name )
        )
      `)
      .eq('user_id', req.user.id);

    if (automation_id) {
      query = query.eq('dm_conversations.automation_id', automation_id);
    }
    if (from) {
      query = query.gte('collected_at', from);
    }
    if (to) {
      query = query.lte('collected_at', to);
    }

    const { data, error } = await query.order('collected_at', { ascending: false });
    if (error) throw error;

    if (!data || data.length === 0) {
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
      return res.send('No leads found');
    }

    // Pivot: group by conversation, then flatten fields into columns
    const byConversation = {};
    const allFields = new Set();

    for (const row of data) {
      const convKey = row.dm_conversations.author_handle + '|' + row.dm_conversations.created_at;
      if (!byConversation[convKey]) {
        byConversation[convKey] = {
          author_handle: row.dm_conversations.author_handle,
          platform:      row.dm_conversations.platform,
          automation:    row.dm_conversations.dm_automations?.name || '',
          date:          row.collected_at,
          fields: {}
        };
      }
      byConversation[convKey].fields[row.field_name] = row.field_value;
      allFields.add(row.field_name);
    }

    // Build CSV
    const fieldCols = [...allFields];
    const headers = ['Date', 'Platform', 'Automation', 'Handle', ...fieldCols];
    const rows = Object.values(byConversation).map(conv => {
      const fieldValues = fieldCols.map(f => csvEscape(conv.fields[f] || ''));
      return [
        csvEscape(conv.date),
        csvEscape(conv.platform),
        csvEscape(conv.automation),
        csvEscape(conv.author_handle),
        ...fieldValues
      ].join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
    res.send(csv);

  } catch (err) {
    console.error('[Automations] CSV export error:', err.message);
    res.status(500).json({ error: 'Failed to export leads' });
  }
});

// ----------------------------------------------------------------
// GET /api/automations/:id — get one automation with its steps.
// ----------------------------------------------------------------
router.get('/:id', async (req, res) => {
  try {
    const { data: automation, error } = await req.db
      .from('dm_automations')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !automation) {
      return res.status(404).json({ error: 'Automation not found' });
    }

    // Load steps
    const { data: steps } = await supabaseAdmin
      .from('dm_automation_steps')
      .select('*')
      .eq('automation_id', automation.id)
      .order('step_order', { ascending: true });

    automation.steps = steps || [];

    res.json({ automation });
  } catch (err) {
    console.error('[Automations] Get error:', err.message);
    res.status(500).json({ error: 'Failed to get automation' });
  }
});

// ----------------------------------------------------------------
// GET /api/automations/:id/leads — list collected leads for one automation.
// ----------------------------------------------------------------
router.get('/:id/leads', async (req, res) => {
  try {
    // Verify the automation belongs to this user
    const { data: automation } = await req.db
      .from('dm_automations')
      .select('id')
      .eq('id', req.params.id)
      .single();

    if (!automation) {
      return res.status(404).json({ error: 'Automation not found' });
    }

    // Get conversations + collected data
    const { data: conversations, error } = await supabaseAdmin
      .from('dm_conversations')
      .select(`
        id, author_handle, platform, status, current_step, created_at,
        dm_collected_data ( field_name, field_value, collected_at )
      `)
      .eq('automation_id', req.params.id)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json({ leads: conversations || [] });
  } catch (err) {
    console.error('[Automations] Leads error:', err.message);
    res.status(500).json({ error: 'Failed to list leads' });
  }
});

// ----------------------------------------------------------------
// POST /api/automations — create a new automation with steps.
//
// Body:
//   post_id          — UUID of the post this automation is for
//   name             — user-friendly label (optional)
//   flow_type        — 'single' | 'multi_step'
//   trigger_keywords — array of keyword strings
//   steps            — array of { message_template, collects_field?, custom_field_label? }
// ----------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    const { post_id, name, flow_type, trigger_keywords, steps } = req.body;

    // Validate required fields
    if (!trigger_keywords || !Array.isArray(trigger_keywords) || trigger_keywords.length === 0) {
      return res.status(400).json({ error: 'At least one trigger keyword is required' });
    }
    if (!steps || !Array.isArray(steps) || steps.length === 0) {
      return res.status(400).json({ error: 'At least one DM step is required' });
    }
    if (!['single', 'multi_step'].includes(flow_type)) {
      return res.status(400).json({ error: 'flow_type must be "single" or "multi_step"' });
    }

    // If post_id provided, verify it belongs to this user
    if (post_id) {
      const { data: post } = await req.db
        .from('posts')
        .select('id')
        .eq('id', post_id)
        .single();

      if (!post) {
        return res.status(404).json({ error: 'Post not found' });
      }
    }

    // Create the automation
    const { data: automation, error: autoError } = await supabaseAdmin
      .from('dm_automations')
      .insert({
        user_id:          req.user.id,
        post_id:          post_id || null,
        name:             name || null,
        flow_type,
        trigger_keywords,
        active:           true
      })
      .select()
      .single();

    if (autoError) throw autoError;

    // Create the steps
    const stepRows = steps.map((step, i) => ({
      automation_id:      automation.id,
      step_order:         i + 1,
      message_template:   step.message_template,
      collects_field:     step.collects_field || null,
      custom_field_label: step.custom_field_label || null
    }));

    const { error: stepsError } = await supabaseAdmin
      .from('dm_automation_steps')
      .insert(stepRows);

    if (stepsError) throw stepsError;

    // Return the full automation with steps
    automation.steps = stepRows;
    res.status(201).json({ automation });

  } catch (err) {
    console.error('[Automations] Create error:', err.message);
    res.status(500).json({ error: 'Failed to create automation' });
  }
});

// ----------------------------------------------------------------
// PUT /api/automations/:id — update an automation and its steps.
// Replaces all steps (delete + re-insert) to simplify reordering.
// ----------------------------------------------------------------
router.put('/:id', async (req, res) => {
  try {
    const { name, flow_type, trigger_keywords, steps, active } = req.body;

    // Verify ownership
    const { data: existing } = await req.db
      .from('dm_automations')
      .select('id')
      .eq('id', req.params.id)
      .single();

    if (!existing) {
      return res.status(404).json({ error: 'Automation not found' });
    }

    // Update the automation fields
    const updateData = { updated_at: new Date().toISOString() };
    if (name !== undefined)             updateData.name = name;
    if (flow_type !== undefined)        updateData.flow_type = flow_type;
    if (trigger_keywords !== undefined) updateData.trigger_keywords = trigger_keywords;
    if (active !== undefined)           updateData.active = active;

    const { data: automation, error: updateError } = await supabaseAdmin
      .from('dm_automations')
      .update(updateData)
      .eq('id', req.params.id)
      .eq('user_id', req.user.id)
      .select()
      .single();

    if (updateError) throw updateError;

    // Replace steps if provided
    if (steps && Array.isArray(steps) && steps.length > 0) {
      // Delete existing steps
      await supabaseAdmin
        .from('dm_automation_steps')
        .delete()
        .eq('automation_id', req.params.id);

      // Insert new steps
      const stepRows = steps.map((step, i) => ({
        automation_id:      req.params.id,
        step_order:         i + 1,
        message_template:   step.message_template,
        collects_field:     step.collects_field || null,
        custom_field_label: step.custom_field_label || null
      }));

      const { error: stepsError } = await supabaseAdmin
        .from('dm_automation_steps')
        .insert(stepRows);

      if (stepsError) throw stepsError;
      automation.steps = stepRows;
    }

    res.json({ automation });

  } catch (err) {
    console.error('[Automations] Update error:', err.message);
    res.status(500).json({ error: 'Failed to update automation' });
  }
});

// ----------------------------------------------------------------
// DELETE /api/automations/:id — delete an automation and all related data.
// Cascade deletes handle steps, conversations, and collected data.
// ----------------------------------------------------------------
router.delete('/:id', async (req, res) => {
  try {
    // Verify ownership
    const { data: existing } = await req.db
      .from('dm_automations')
      .select('id')
      .eq('id', req.params.id)
      .single();

    if (!existing) {
      return res.status(404).json({ error: 'Automation not found' });
    }

    const { error } = await supabaseAdmin
      .from('dm_automations')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);

    if (error) throw error;

    res.json({ success: true });
  } catch (err) {
    console.error('[Automations] Delete error:', err.message);
    res.status(500).json({ error: 'Failed to delete automation' });
  }
});

// ----------------------------------------------------------------
// Helper: escape a value for CSV output
// ----------------------------------------------------------------
function csvEscape(value) {
  if (!value) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

module.exports = router;
