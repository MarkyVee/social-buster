-- ============================================================
-- MIGRATION: Feature Visibility Toggle
-- Date: 2026-04-01
--
-- Adds is_globally_visible to tier_limits.
--
-- When FALSE: the feature is hidden from ALL users regardless of
-- their subscription tier. Data is still collected silently.
-- Admin flips to TRUE when ready to announce the feature.
--
-- When TRUE (default for existing features): behaviour is unchanged —
-- tier access rules apply as normal.
--
-- Run in: Supabase → SQL Editor → paste and execute.
-- ============================================================

ALTER TABLE tier_limits
  ADD COLUMN IF NOT EXISTS is_globally_visible BOOLEAN NOT NULL DEFAULT FALSE;

-- Existing live features should be visible immediately.
-- Dark / not-yet-announced features will be set to FALSE via admin UI.
UPDATE tier_limits SET is_globally_visible = TRUE
WHERE feature IN (
  'briefs_per_month',
  'ai_images_per_month',
  'platforms_connected',
  'scheduled_queue_size',
  'comment_monitoring',
  'dm_lead_capture',
  'intelligence_dashboard',
  'performance_predictor',
  'pain_point_miner',
  'brand_voice_tracker'
);

-- All other rows (future dark-data features seeded later) stay FALSE.

COMMENT ON COLUMN tier_limits.is_globally_visible IS
  'When FALSE, feature is hidden from all users regardless of tier. '
  'Admin flips to TRUE to announce a new feature. '
  'Data collection always runs regardless of this flag.';
