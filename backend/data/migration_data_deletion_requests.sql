-- Data Deletion Requests table
-- Stores Meta data deletion callback confirmations so users can check status.
-- Required by Meta App Review for GDPR / data deletion compliance.

CREATE TABLE IF NOT EXISTS data_deletion_requests (
  id                UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  confirmation_code TEXT NOT NULL UNIQUE,
  platform_user_id  TEXT,                       -- Meta user ID from signed_request
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending | completed | failed
  error_message     TEXT,
  requested_at      TIMESTAMPTZ DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

-- Index for status page lookups
CREATE INDEX IF NOT EXISTS idx_deletion_requests_code ON data_deletion_requests(confirmation_code);

-- RLS: This table is accessed by supabaseAdmin only (webhook handler),
-- no user-facing RLS needed. But add a basic policy for safety.
ALTER TABLE data_deletion_requests ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (supabaseAdmin uses service role key)
CREATE POLICY "Service role full access on data_deletion_requests"
  ON data_deletion_requests
  FOR ALL
  USING (true)
  WITH CHECK (true);
