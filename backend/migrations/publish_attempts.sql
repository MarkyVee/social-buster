-- Migration: publish_attempts table
-- Purpose: Write-ahead intent log for publishing. Records each attempt BEFORE
--          calling the platform API so crash recovery can determine whether a
--          post was actually published (status='sent') vs just stuck (status='attempting').
--
-- Run this in Supabase SQL Editor before deploying the updated publishingAgent.js.
--
-- Safe to run multiple times (IF NOT EXISTS on everything).

-- ----------------------------------------------------------------
-- 1. Create the table
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS publish_attempts (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id          UUID        NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id          UUID        NOT NULL,
  platform         TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'attempting',  -- attempting | sent | failed
  attempt_number   INT         NOT NULL DEFAULT 1,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ,
  platform_post_id TEXT,        -- filled in on 'sent' — the ID returned by the platform API
  error_message    TEXT         -- filled in on 'failed'
);

-- ----------------------------------------------------------------
-- 2. Indexes for the queries in publishingAgent.js
-- ----------------------------------------------------------------

-- Stale recovery looks up by post_id + status='sent'
CREATE INDEX IF NOT EXISTS publish_attempts_post_id_idx
  ON publish_attempts (post_id);

-- Optional: admin queries filtering by status
CREATE INDEX IF NOT EXISTS publish_attempts_status_idx
  ON publish_attempts (status);

-- Optional: per-user history
CREATE INDEX IF NOT EXISTS publish_attempts_user_id_idx
  ON publish_attempts (user_id);

-- ----------------------------------------------------------------
-- 3. RLS — service role can read/write everything.
--    Users should not have direct access to this table (internal audit log).
-- ----------------------------------------------------------------
ALTER TABLE publish_attempts ENABLE ROW LEVEL SECURITY;

-- Service role (backend workers) has full access
CREATE POLICY "service_role_full_access" ON publish_attempts
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ----------------------------------------------------------------
-- Done. Verify with:
--   SELECT * FROM publish_attempts LIMIT 5;
-- ----------------------------------------------------------------
