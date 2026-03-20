-- ============================================================
-- MIGRATION: DM Automations
-- Date: 2026-03-20
--
-- Adds 4 new tables for the comment-to-DM automation system:
--   1. dm_automations      — per-post automation config (trigger keywords, flow type)
--   2. dm_automation_steps  — ordered steps in a DM flow
--   3. dm_conversations     — tracks conversation state per commenter
--   4. dm_collected_data    — lead data collected during multi-step flows
--
-- Also adds author_platform_id to the existing comments table
-- (needed to send DMs — this is the commenter's PSID/IGSID).
--
-- Run this in: Supabase → SQL Editor → paste and execute.
-- ============================================================

-- ---- 1. Add author_platform_id to comments ----
-- This stores the commenter's platform-scoped user ID (PSID for Facebook,
-- IGSID for Instagram). Required for sending DMs — @username is not enough.
ALTER TABLE comments ADD COLUMN IF NOT EXISTS author_platform_id TEXT;


-- ---- 2. dm_automations ----
-- Per-post DM automation rules. Each published post can have one or more
-- automations with different trigger keywords and DM flows.
CREATE TABLE IF NOT EXISTS dm_automations (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  post_id         UUID REFERENCES posts(id) ON DELETE CASCADE,
  name            TEXT,                              -- User-friendly label ("Free guide automation")
  flow_type       TEXT NOT NULL DEFAULT 'single',    -- 'single' | 'multi_step'
  trigger_keywords TEXT[] NOT NULL DEFAULT '{}',     -- Array of keyword phrases
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dm_automations_user_id ON dm_automations(user_id);
CREATE INDEX IF NOT EXISTS idx_dm_automations_post_id ON dm_automations(post_id);

ALTER TABLE dm_automations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own dm_automations" ON dm_automations;
DROP POLICY IF EXISTS "Service role full access to dm_automations" ON dm_automations;

CREATE POLICY "Users can manage own dm_automations"
  ON dm_automations FOR ALL
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to dm_automations"
  ON dm_automations FOR ALL
  USING (auth.role() = 'service_role');


-- ---- 3. dm_automation_steps ----
-- Steps in a DM flow. Single-message flows have 1 step.
-- Multi-step flows have N steps executed in order.
CREATE TABLE IF NOT EXISTS dm_automation_steps (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  automation_id   UUID NOT NULL REFERENCES dm_automations(id) ON DELETE CASCADE,
  step_order      INTEGER NOT NULL DEFAULT 1,        -- 1-based sequence
  message_template TEXT NOT NULL,                     -- DM text. Supports {{name}} placeholders.
  collects_field  TEXT,                               -- NULL for final/single step. 'email', 'phone', 'name', 'custom'
  custom_field_label TEXT,                            -- Label when collects_field = 'custom'
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dm_steps_automation ON dm_automation_steps(automation_id);

ALTER TABLE dm_automation_steps ENABLE ROW LEVEL SECURITY;

-- Steps are accessed through automation_id join (already user-scoped).
-- Service role only for direct access.
DROP POLICY IF EXISTS "Service role full access to dm_automation_steps" ON dm_automation_steps;

CREATE POLICY "Service role full access to dm_automation_steps"
  ON dm_automation_steps FOR ALL
  USING (auth.role() = 'service_role');


-- ---- 4. dm_conversations ----
-- Tracks the state of each DM conversation with a commenter.
-- One row per (automation, commenter) pair. The unique index prevents
-- the same person from being DM'd twice for the same automation.
CREATE TABLE IF NOT EXISTS dm_conversations (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  automation_id   UUID NOT NULL REFERENCES dm_automations(id) ON DELETE CASCADE,
  platform        TEXT NOT NULL,
  platform_user_id TEXT NOT NULL,                     -- Commenter's PSID (Facebook) or IGSID (Instagram)
  author_handle   TEXT,                               -- @username for display
  current_step    INTEGER NOT NULL DEFAULT 1,
  status          TEXT NOT NULL DEFAULT 'active',     -- 'active' | 'completed' | 'expired' | 'opted_out'
  last_message_at TIMESTAMPTZ,                        -- When we last sent a DM (for 24hr window)
  last_reply_at   TIMESTAMPTZ,                        -- When commenter last replied (resets 24hr window)
  window_expires_at TIMESTAMPTZ,                      -- Computed: last user interaction + 24 hours
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dm_conversations_user_id ON dm_conversations(user_id);
CREATE INDEX IF NOT EXISTS idx_dm_conversations_automation ON dm_conversations(automation_id);
CREATE INDEX IF NOT EXISTS idx_dm_conversations_platform_user ON dm_conversations(platform_user_id, automation_id);

-- Prevent same person from being DM'd twice for the same automation
CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_conversations_unique
  ON dm_conversations(automation_id, platform_user_id);

ALTER TABLE dm_conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own dm_conversations" ON dm_conversations;
DROP POLICY IF EXISTS "Service role full access to dm_conversations" ON dm_conversations;

CREATE POLICY "Users can view own dm_conversations"
  ON dm_conversations FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to dm_conversations"
  ON dm_conversations FOR ALL
  USING (auth.role() = 'service_role');


-- ---- 5. dm_collected_data ----
-- Lead data collected during multi-step conversations.
-- One row per field per conversation. Flexible schema — any field name works.
CREATE TABLE IF NOT EXISTS dm_collected_data (
  id              UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES dm_conversations(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  field_name      TEXT NOT NULL,                      -- 'email', 'phone', 'name', or custom label
  field_value     TEXT NOT NULL,
  collected_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dm_collected_user ON dm_collected_data(user_id);
CREATE INDEX IF NOT EXISTS idx_dm_collected_conv ON dm_collected_data(conversation_id);

ALTER TABLE dm_collected_data ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own dm_collected_data" ON dm_collected_data;
DROP POLICY IF EXISTS "Service role full access to dm_collected_data" ON dm_collected_data;

CREATE POLICY "Users can view own dm_collected_data"
  ON dm_collected_data FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to dm_collected_data"
  ON dm_collected_data FOR ALL
  USING (auth.role() = 'service_role');


-- ============================================================
-- DONE. Verify with:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'public'
--   AND table_name LIKE 'dm_%';
-- Should return: dm_automations, dm_automation_steps, dm_conversations, dm_collected_data
-- ============================================================
