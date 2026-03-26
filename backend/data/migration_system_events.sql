-- ================================================================
-- System Events Table
-- Persistent diagnostic event log for the watchdog monitoring system.
--
-- Stores anomalies, health score snapshots, auto-pause events,
-- and system warnings so the admin dashboard can show historical
-- trends and drill into root causes.
--
-- Run this in Supabase SQL Editor.
-- ================================================================

-- 1. Create the system_events table
CREATE TABLE IF NOT EXISTS system_events (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  event_type    TEXT NOT NULL,          -- 'anomaly', 'health_snapshot', 'auto_pause', 'auto_resume', 'warning', 'error'
  severity      TEXT NOT NULL DEFAULT 'info',  -- 'info', 'warning', 'critical'
  category      TEXT,                   -- 'api_rate', 'queue_backlog', 'job_failure', 'loop_detect', 'worker_dead', 'system'
  title         TEXT NOT NULL,          -- Short summary (e.g., "Instagram API loop detected for user abc")
  details       JSONB DEFAULT '{}',     -- Structured payload: user_id, queue, counts, thresholds, etc.
  confidence    INTEGER,                -- Health confidence score 0-100 at time of event
  resolved      BOOLEAN DEFAULT false,  -- Has this been acknowledged/resolved?
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- 2. Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_system_events_type_created
  ON system_events (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_system_events_severity_created
  ON system_events (severity, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_system_events_resolved
  ON system_events (resolved, created_at DESC);

-- 3. Auto-cleanup: delete events older than 90 days (run periodically or via cron)
-- This is a helper function the watchdog can call to prevent unbounded growth.
CREATE OR REPLACE FUNCTION cleanup_old_system_events()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM system_events
  WHERE created_at < now() - INTERVAL '90 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- 4. System pause state table — tracks whether the system is paused
CREATE TABLE IF NOT EXISTS system_state (
  key           TEXT PRIMARY KEY,
  value         JSONB DEFAULT '{}',
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- Seed the pause state
INSERT INTO system_state (key, value)
VALUES ('pause', '{"paused": false, "reason": null, "paused_at": null, "paused_by": null}')
ON CONFLICT (key) DO NOTHING;

-- 5. Enable RLS on both tables (admin-only access)
ALTER TABLE system_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_state ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (workers use supabaseAdmin)
CREATE POLICY "Service role full access on system_events"
  ON system_events FOR ALL
  USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on system_state"
  ON system_state FOR ALL
  USING (true) WITH CHECK (true);
