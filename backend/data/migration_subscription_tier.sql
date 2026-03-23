-- Migration: Add subscription_tier column to user_profiles
--
-- This column lets admins manually override a user's subscription tier
-- without needing a Stripe event. The checkLimit middleware checks this
-- column first; if set, it takes priority over the Stripe subscriptions table.
--
-- Valid values: 'free_trial', 'starter', 'professional', 'enterprise', 'suspended'
-- NULL = no override (fall back to Stripe subscription status)

ALTER TABLE user_profiles
ADD COLUMN IF NOT EXISTS subscription_tier TEXT DEFAULT NULL;

-- Index for fast lookups in checkLimit middleware
CREATE INDEX IF NOT EXISTS idx_user_profiles_subscription_tier
ON user_profiles (user_id, subscription_tier);
