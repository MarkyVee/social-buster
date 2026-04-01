-- migration_agent_directives.sql
--
-- Creates the admin_agent_directives table used by agentDirectiveService.js.
--
-- Run this in Supabase SQL Editor before deploying the admin directive UI.
--
-- After running: agentDirectiveService.js will be activated (stub removed).
--
-- AGENT NAMES (valid values for agent_name column, or '*' for all agents):
--   hookPerformanceAgent, hookTrendAgent, toneObjectiveFitAgent,
--   postTypeCalendarAgent, commentSentimentAgent, ctaEffectivenessAgent,
--   contentFatigueAgent, platformAlgorithmAgent,
--   briefOptimizationAgent, contentGapAgent
--   * = applies to all agents

CREATE TABLE IF NOT EXISTS admin_agent_directives (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Which agent this directive applies to. Use '*' for all agents.
  agent_name    TEXT NOT NULL DEFAULT '*',

  -- Which user this directive applies to.
  -- NULL = applies to ALL users. Set to a specific user_id to target one user.
  user_id       UUID REFERENCES auth.users(id) ON DELETE CASCADE,

  -- The directive text injected into agent runs.
  -- Write in plain English. Agents that store it in signal_weights will have it
  -- surfaced by contextBuilder at generation time.
  -- Example: "Weight weekday morning posts more heavily for B2B audiences."
  directive     TEXT NOT NULL,

  -- Human-readable label so the admin knows what this directive does at a glance.
  label         TEXT NOT NULL DEFAULT '',

  -- Toggle on/off without deleting.
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for the resolution-order query in agentDirectiveService.js
CREATE INDEX IF NOT EXISTS idx_agent_directives_lookup
  ON admin_agent_directives (is_active, agent_name, user_id);

-- RLS: admin access only (service role used by backend — no user-facing access needed)
ALTER TABLE admin_agent_directives ENABLE ROW LEVEL SECURITY;

-- Service role (backend) can do everything
CREATE POLICY "service_role_all" ON admin_agent_directives
  FOR ALL USING (true) WITH CHECK (true);
