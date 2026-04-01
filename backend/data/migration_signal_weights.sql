-- migration_signal_weights.sql
--
-- Adds signal_weights JSONB column to user_profiles.
-- This is the foundation of the learning engine — every agent that
-- analyses post performance writes its findings here, and contextBuilder
-- reads them back into every LLM brief generation prompt.
--
-- Structure written by hookPerformanceAgent and toneObjectiveFitAgent:
-- {
--   "hook_formats": {
--     "question": 2.1,      -- 2.1x this user's avg engagement
--     "curiosity": 1.6,
--     "list": 1.2,
--     "statement": 0.9,
--     "story": 0.7
--   },
--   "hook_formats_updated_at": "2026-04-01T...",
--   "hook_post_count": 24,
--   "tone_objective_fit": {
--     "bold_conversions": 1.8,
--     "friendly_engagement": 1.4,
--     "humorous_conversions": 0.4
--   },
--   "tone_objective_updated_at": "2026-04-01T..."
-- }
--
-- Run this as a single block in Supabase SQL Editor.

ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS signal_weights JSONB DEFAULT '{}';

-- Index for fast reads — the column is read on every brief submission
-- via contextBuilder. GIN index handles JSONB key lookups efficiently.
CREATE INDEX IF NOT EXISTS idx_user_profiles_signal_weights
  ON user_profiles USING GIN (signal_weights);

COMMENT ON COLUMN user_profiles.signal_weights IS
  'Per-user learned performance weights from hookPerformanceAgent and toneObjectiveFitAgent.
   Keys: hook_formats (multipliers per hook format), tone_objective_fit (multipliers per tone+objective combo).
   Values > 1.0 mean above this user''s average. Values < 1.0 mean below average.
   Updated weekly. Read by contextBuilder into every LLM prompt.';
