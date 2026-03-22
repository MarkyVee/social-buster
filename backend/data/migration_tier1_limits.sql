-- ================================================================
-- Migration: Add Tier 1 premium feature limits
-- Date: 2026-03-21
--
-- Adds tier_limits rows for the 3 new premium features:
--   - performance_predictor
--   - pain_point_miner
--   - brand_voice_tracker
--
-- All three are gated to Professional and Enterprise tiers.
-- Free Trial and Starter users see an upgrade prompt.
--
-- Safe to re-run: ON CONFLICT DO NOTHING.
-- Run this in Supabase SQL Editor.
-- ================================================================

INSERT INTO tier_limits (tier, feature, limit_value, enabled, label) VALUES
  -- Performance Predictor
  ('free_trial',    'performance_predictor', 0, true, 'Performance predictor'),
  ('starter',       'performance_predictor', 0, true, 'Performance predictor'),
  ('professional',  'performance_predictor', 1, true, 'Performance predictor'),
  ('enterprise',    'performance_predictor', 1, true, 'Performance predictor'),

  -- Pain-Point Miner
  ('free_trial',    'pain_point_miner', 0, true, 'Pain-point miner'),
  ('starter',       'pain_point_miner', 0, true, 'Pain-point miner'),
  ('professional',  'pain_point_miner', 1, true, 'Pain-point miner'),
  ('enterprise',    'pain_point_miner', 1, true, 'Pain-point miner'),

  -- Brand Voice Tracker
  ('free_trial',    'brand_voice_tracker', 0, true, 'Brand voice tracker'),
  ('starter',       'brand_voice_tracker', 0, true, 'Brand voice tracker'),
  ('professional',  'brand_voice_tracker', 1, true, 'Brand voice tracker'),
  ('enterprise',    'brand_voice_tracker', 1, true, 'Brand voice tracker')

ON CONFLICT (tier, feature) DO NOTHING;
