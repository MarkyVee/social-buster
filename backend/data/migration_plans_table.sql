-- ============================================================
-- Social Buster — Plans Table Migration
-- Run this in Supabase SQL Editor.
-- ============================================================

-- Stores subscription plan display info + Stripe price IDs.
-- Admin edits these from the dashboard — frontend reads via API.
CREATE TABLE IF NOT EXISTS plans (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tier            TEXT NOT NULL UNIQUE,          -- 'starter', 'professional', 'enterprise'
  name            TEXT NOT NULL,                 -- Display name: 'Starter', 'Professional', etc.
  price_display   TEXT NOT NULL DEFAULT '$0',    -- What users see: '$29', '$199', etc.
  period_label    TEXT NOT NULL DEFAULT '/month',-- '/month', '/year', etc.
  stripe_price_id TEXT,                          -- Stripe price ID: 'price_xxx' (null = not purchasable)
  features        JSONB NOT NULL DEFAULT '[]',   -- Array of feature strings shown on the card
  color           TEXT NOT NULL DEFAULT '#6366f1',-- Hex color for the card accent
  badge           TEXT,                          -- Optional badge like 'Most Popular' (null = no badge)
  sort_order      INT NOT NULL DEFAULT 0,        -- Display order (lower = first)
  is_active       BOOLEAN NOT NULL DEFAULT true, -- Toggle plan visibility without deleting
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- Only the service role can read/write plans (admin-only table)
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access to plans" ON plans;
CREATE POLICY "Service role full access to plans"
  ON plans FOR ALL
  USING (auth.role() = 'service_role');

-- Public read access so the frontend can fetch plan cards without auth
DROP POLICY IF EXISTS "Public can read active plans" ON plans;
CREATE POLICY "Public can read active plans"
  ON plans FOR SELECT
  USING (is_active = true);

-- Auto-update updated_at
DROP TRIGGER IF EXISTS set_plans_updated_at ON plans;
CREATE TRIGGER set_plans_updated_at
  BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Seed the 3 default plans
INSERT INTO plans (tier, name, price_display, period_label, stripe_price_id, features, color, badge, sort_order) VALUES
  (
    'starter',
    'Starter',
    '$29',
    '/month',
    NULL,
    '["20 AI post generations/month", "30 AI image generations/month", "4 social platforms", "25 posts in queue", "Comment monitoring"]',
    '#6366f1',
    NULL,
    1
  ),
  (
    'professional',
    'Professional',
    '$79',
    '/month',
    NULL,
    '["Unlimited AI generations", "Unlimited AI images", "All 7 platforms", "Unlimited post queue", "Lead capture DMs", "Full media library", "Intelligence dashboard"]',
    '#0d9488',
    'Most Popular',
    2
  ),
  (
    'enterprise',
    'Enterprise',
    '$199',
    '/month',
    NULL,
    '["Everything in Professional", "Priority support", "Custom onboarding call", "SLA guarantee", "Unlimited platforms"]',
    '#7c3aed',
    NULL,
    3
  )
ON CONFLICT (tier) DO NOTHING;
