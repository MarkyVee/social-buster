-- ================================================================
-- Migration: Single Session Enforcement
-- Date: 2026-03-22
--
-- Adds active_session_id to user_profiles so the backend can
-- enforce one active session per user account.
-- When a user logs in from a new device, the old session is
-- automatically invalidated.
-- ================================================================

-- Add the column (nullable — existing users get null until next login)
ALTER TABLE user_profiles
ADD COLUMN IF NOT EXISTS active_session_id TEXT DEFAULT NULL;

-- Index for fast lookups in the auth middleware
CREATE INDEX IF NOT EXISTS idx_user_profiles_session
ON user_profiles (user_id, active_session_id);
