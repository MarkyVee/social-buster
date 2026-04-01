-- ================================================================
-- Social Buster — Activity Log Migration
-- Run this in Supabase SQL Editor.
--
-- Creates one table: activity_log
-- One row per auditable user event.
-- Auto-cleaned after 90 days by the nightly activityCleanupWorker.
-- ================================================================

CREATE TABLE IF NOT EXISTS activity_log (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  event_type  TEXT        NOT NULL,
  metadata    JSONB       NOT NULL DEFAULT '{}',
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-user queries (admin user detail view, user self-read)
CREATE INDEX IF NOT EXISTS idx_activity_log_user_created
  ON activity_log (user_id, created_at DESC);

-- Admin feed filtered by event type
CREATE INDEX IF NOT EXISTS idx_activity_log_event_created
  ON activity_log (event_type, created_at DESC);

-- Admin feed date-range queries
CREATE INDEX IF NOT EXISTS idx_activity_log_created
  ON activity_log (created_at DESC);

-- ----------------------------------------------------------------
-- RLS
-- All writes go through supabaseAdmin (service role bypasses RLS).
-- Authenticated users can read only their own rows.
-- ----------------------------------------------------------------
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on activity_log" ON activity_log;
CREATE POLICY "Service role full access on activity_log"
  ON activity_log FOR ALL
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Users can read own activity" ON activity_log;
CREATE POLICY "Users can read own activity"
  ON activity_log FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);
