-- Migration: dm_log table
-- Purpose: Idempotency guard for DM sending. Records each send attempt with a
--          unique key (conversation_id + step_order) so that BullMQ retries after
--          a crash never deliver the same DM twice.
--
-- Run this in Supabase SQL Editor before deploying the updated dmWorker.js.
-- Safe to run multiple times (IF NOT EXISTS on everything).
--
-- Background:
--   Without this table, if the platform API sends a DM successfully but the
--   server crashes before the DB conversation update, BullMQ retries and sends
--   the same DM again. Duplicate DMs are a Meta spam signal that can trigger
--   Page restrictions or permanent API access loss.

-- ----------------------------------------------------------------
-- 1. Create the table
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS dm_log (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  dm_key          TEXT        NOT NULL,   -- '{conversation_id}:{step_order}' — the idempotency key
  conversation_id UUID        NOT NULL,
  step_order      INT         NOT NULL,
  user_id         UUID        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'attempting',  -- attempting | sent | failed
  sent_at         TIMESTAMPTZ,            -- filled in when status becomes 'sent'
  error_message   TEXT,                   -- filled in when status becomes 'failed'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------
-- 2. Unique constraint — the core of the idempotency guarantee.
--    A second INSERT with the same dm_key returns a 23505 conflict error
--    which dmWorker.js catches and uses to detect duplicate attempts.
-- ----------------------------------------------------------------
ALTER TABLE dm_log
  ADD CONSTRAINT dm_log_dm_key_unique UNIQUE (dm_key);

-- ----------------------------------------------------------------
-- 3. Indexes
-- ----------------------------------------------------------------

-- Worker looks up by dm_key on every send
CREATE INDEX IF NOT EXISTS dm_log_dm_key_idx
  ON dm_log (dm_key);

-- Admin queries by conversation
CREATE INDEX IF NOT EXISTS dm_log_conversation_id_idx
  ON dm_log (conversation_id);

-- Per-user history
CREATE INDEX IF NOT EXISTS dm_log_user_id_idx
  ON dm_log (user_id);

-- ----------------------------------------------------------------
-- 4. RLS — service role full access only.
--    This is an internal audit/safety table. Users never query it directly.
-- ----------------------------------------------------------------
ALTER TABLE dm_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access" ON dm_log
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ----------------------------------------------------------------
-- 5. Optional: auto-purge rows older than 30 days to prevent bloat.
--    (Run this separately as a scheduled job or add to activity-cleanup worker.)
--    DELETE FROM dm_log WHERE created_at < NOW() - INTERVAL '30 days';
-- ----------------------------------------------------------------

-- Done. Verify with:
--   SELECT * FROM dm_log LIMIT 5;
