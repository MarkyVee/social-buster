/**
 * routes/automations.js
 *
 * CRUD for DM automations — per-post trigger keywords and DM flows.
 * Also provides lead data viewing and CSV export.
 *
 * Routes:
 *   GET    /api/automations              — list all automations for the user
 *   GET    /api/automations/stats        — DM usage stats (daily counts, limits)
 *   GET    /api/automations/dashboard    — computed KPIs (conversion, funnel, trends, keyword perf)
 *   GET    /api/automations/leads/export — CSV export of all leads
 *   GET    /api/automations/leads        — all collected leads (single query, no N+1)
 *   GET    /api/automations/:id          — get one automation with its steps
 *   GET    /api/automations/:id/leads    — list collected leads for one automation
 *   POST   /api/automations              — create a new automation (with steps)
 *   PUT    /api/automations/:id          — update an automation (with steps)
 *   DELETE /api/automations/:id          — delete an automation
 *
 * All routes require authentication (auth middleware).
 * All routes use req.db (user-scoped — never supabaseAdmin).
 */

const express = require('express');
const router  = express.Router();
const { requireAuth }    = require('../middleware/auth');
const { enforceTenancy } = require('../middleware/tenancy');
const { checkLimit }     = require('../middleware/checkLimit');
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
// GET /api/automations/dashboard — computed KPIs for the DM dashboard.
//
// Returns: conversion_rate, funnel (status breakdown), per-automation
// performance, daily trend (last 14 days), keyword performance.
// All computed server-side so the frontend doesn't need N+1 queries.
// ----------------------------------------------------------------
router.get('/dashboard', async (req, res) => {
  try {
    // Fetch all conversations for this user in one query
    const { data: conversations, error: convErr } = await req.db
      .from('dm_conversations')
      .select('id, automation_id, status, platform, created_at, last_reply_at');

    if (convErr) throw convErr;

    const allConvs = conversations || [];

    // --- Funnel: count by status ---
    const funnel = { active: 0, completed: 0, expired: 0, opted_out: 0, failed: 0 };
    allConvs.forEach(c => {
      if (funnel[c.status] !== undefined) funnel[c.status]++;
    });
    const totalConvs = allConvs.length;
    const conversionRate = totalConvs > 0
      ? Math.round((funnel.completed / totalConvs) * 100)
      : 0;

    // --- Daily trend: conversations started per day (last 14 days) ---
    const dailyTrend = [];
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
      const day = new Date(now);
      day.setDate(day.getDate() - i);
      const dateStr = day.toISOString().slice(0, 10); // YYYY-MM-DD
      const count = allConvs.filter(c =>
        c.created_at && c.created_at.slice(0, 10) === dateStr
      ).length;
      dailyTrend.push({ date: dateStr, count });
    }

    // --- Per-automation performance ---
    const { data: automations, error: autoErr } = await req.db
      .from('dm_automations')
      .select('id, name, trigger_keywords, flow_type, active, posts ( platform )');

    if (autoErr) throw autoErr;

    const automationPerf = (automations || []).map(a => {
      const autoConvs = allConvs.filter(c => c.automation_id === a.id);
      const completed = autoConvs.filter(c => c.status === 'completed').length;
      const total = autoConvs.length;
      return {
        id:              a.id,
        name:            a.name || 'Unnamed',
        platform:        a.posts?.platform || '—',
        flow_type:       a.flow_type,
        active:          a.active,
        keywords:        a.trigger_keywords || [],
        total:           total,
        completed:       completed,
        expired:         autoConvs.filter(c => c.status === 'expired').length,
        opted_out:       autoConvs.filter(c => c.status === 'opted_out').length,
        conversion_rate: total > 0 ? Math.round((completed / total) * 100) : 0
      };
    });

    // --- Keyword performance (aggregate across all automations) ---
    // Map each keyword to the automations that use it, sum their conversations
    const keywordMap = {};
    for (const a of automationPerf) {
      for (const kw of a.keywords) {
        const key = kw.toLowerCase().trim();
        if (!keywordMap[key]) {
          keywordMap[key] = { keyword: kw, total: 0, completed: 0 };
        }
        keywordMap[key].total += a.total;
        keywordMap[key].completed += a.completed;
      }
    }
    const keywordPerf = Object.values(keywordMap)
      .map(k => ({
        ...k,
        conversion_rate: k.total > 0 ? Math.round((k.completed / k.total) * 100) : 0
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    // --- Platform breakdown ---
    const platformBreakdown = {};
    allConvs.forEach(c => {
      if (!platformBreakdown[c.platform]) {
        platformBreakdown[c.platform] = { total: 0, completed: 0 };
      }
      platformBreakdown[c.platform].total++;
      if (c.status === 'completed') platformBreakdown[c.platform].completed++;
    });

    // --- Leads count ---
    const { count: totalLeads } = await req.db
      .from('dm_collected_data')
      .select('id', { count: 'exact', head: true });

    // --- Average time to completion (completed conversations only) ---
    const completedConvs = allConvs.filter(c => c.status === 'completed' && c.last_reply_at && c.created_at);
    let avgCompletionMinutes = null;
    if (completedConvs.length > 0) {
      const totalMs = completedConvs.reduce((sum, c) => {
        return sum + (new Date(c.last_reply_at) - new Date(c.created_at));
      }, 0);
      avgCompletionMinutes = Math.round((totalMs / completedConvs.length) / 60000);
    }

    // --- Daily usage ---
    const facebook  = await getDailyUsage(req.user.id, 'facebook');
    const instagram = await getDailyUsage(req.user.id, 'instagram');

    res.json({
      summary: {
        total_conversations: totalConvs,
        total_leads:         totalLeads || 0,
        conversion_rate:     conversionRate,
        avg_completion_min:  avgCompletionMinutes,
        active_automations:  automationPerf.filter(a => a.active).length,
        total_automations:   automationPerf.length
      },
      funnel,
      daily_trend:     dailyTrend,
      automations:     automationPerf,
      keywords:        keywordPerf,
      platforms:       platformBreakdown,
      daily_usage:     { facebook, instagram }
    });
  } catch (err) {
    console.error('[Automations] Dashboard error:', err.message);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// ----------------------------------------------------------------
// GET /api/automations/leads/export — CSV export of all collected leads.
// Query params: automation_id (optional filter), from, to (date range)
// ----------------------------------------------------------------
router.get('/leads/export', checkLimit('dm_lead_capture'), async (req, res) => {
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
// GET /api/automations/leads — list ALL collected leads for the user.
// Replaces the old N+1 pattern where the frontend looped per automation.
// Must be defined BEFORE /:id so Express doesn't match "leads" as an ID.
// ----------------------------------------------------------------
router.get('/leads', async (req, res) => {
  try {
    const { data: conversations, error } = await supabaseAdmin
      .from('dm_conversations')
      .select(`
        id, author_handle, platform, status, current_step, created_at,
        automation_id,
        dm_automations!inner ( name ),
        dm_collected_data ( field_name, field_value, collected_at )
      `)
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false })
      .limit(200);

    if (error) throw error;

    // Flatten automation name into each lead
    const leads = (conversations || []).map(c => ({
      ...c,
      automation_name: c.dm_automations?.name || 'Unnamed',
      dm_automations: undefined // remove nested object from response
    }));

    res.json({ leads });
  } catch (err) {
    console.error('[Automations] All leads error:', err.message);
    res.status(500).json({ error: 'Failed to list leads' });
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
router.post('/', checkLimit('comment_monitoring'), async (req, res) => {
  try {
    const { post_id, name, flow_type, trigger_keywords, steps, resource_url } = req.body;

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
        resource_url:     resource_url || null,
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
    const { name, flow_type, trigger_keywords, steps, active, resource_url } = req.body;

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
    if (resource_url !== undefined)     updateData.resource_url = resource_url;

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
