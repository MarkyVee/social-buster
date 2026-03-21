-- ================================================================
-- Email System Migration
-- Run in Supabase SQL Editor
--
-- Creates 3 tables for admin bulk email:
--   email_groups          — recipient groups (filter-based or manual)
--   email_campaigns       — email blasts (subject + body + group)
--   email_campaign_logs   — per-recipient delivery log
--
-- These are admin-only tables — no RLS needed.
-- ================================================================

-- 1. Email groups — defines a recipient list
CREATE TABLE IF NOT EXISTS email_groups (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  description      TEXT,
  group_type       TEXT NOT NULL CHECK (group_type IN ('filter', 'manual')),
  filter_criteria  JSONB DEFAULT '{}'::jsonb,      -- used when group_type = 'filter'
  manual_user_ids  UUID[] DEFAULT '{}',             -- used when group_type = 'manual'
  created_at       TIMESTAMPTZ DEFAULT now(),
  updated_at       TIMESTAMPTZ DEFAULT now()
);

-- 2. Email campaigns — a single email blast targeting one group
CREATE TABLE IF NOT EXISTS email_campaigns (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id         UUID REFERENCES email_groups(id) ON DELETE SET NULL,
  subject          TEXT NOT NULL,
  body             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sending', 'sent', 'failed')),
  total_count      INT DEFAULT 0,
  sent_count       INT DEFAULT 0,
  failed_count     INT DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT now(),
  sent_at          TIMESTAMPTZ
);

-- 3. Email campaign logs — per-recipient delivery status
CREATE TABLE IF NOT EXISTS email_campaign_logs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      UUID NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
  user_id          UUID,
  email            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'bounced')),
  error_message    TEXT,
  sent_at          TIMESTAMPTZ
);

-- Index for fast campaign log lookups
CREATE INDEX IF NOT EXISTS idx_email_campaign_logs_campaign_id ON email_campaign_logs(campaign_id);

-- Index for fast group lookups by type
CREATE INDEX IF NOT EXISTS idx_email_groups_type ON email_groups(group_type);
