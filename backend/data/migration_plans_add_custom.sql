-- ============================================================
-- Social Buster — Add 2 Custom Placeholder Plans
-- Run this in Supabase SQL Editor.
--
-- Adds two hidden placeholder plans (custom_1, custom_2).
-- They will not appear to users (is_active = false) until you
-- enable them from the admin Plans tab after customizing.
-- ============================================================

INSERT INTO plans (tier, name, price_display, period_label, stripe_price_id, features, color, badge, sort_order, is_active) VALUES
  (
    'custom_1',
    'Custom Plan 1',
    '$0',
    '/month',
    NULL,
    '[]',
    '#6366f1',
    NULL,
    4,
    false
  ),
  (
    'custom_2',
    'Custom Plan 2',
    '$0',
    '/month',
    NULL,
    '[]',
    '#6366f1',
    NULL,
    5,
    false
  )
ON CONFLICT (tier) DO NOTHING;
