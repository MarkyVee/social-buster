-- ============================================================
-- Social Buster — Affiliate Program Migration
-- Run this in Supabase SQL Editor.
--
-- IMPORTANT: Run the blocks IN ORDER — each table may reference
-- the one before it. Running out of order will cause FK errors.
--
-- Block execution order:
--   1. legacy_cohorts
--   2. legacy_slots
--   3. referral_slugs
--   4. referrals
--   5. referral_plan_history
--   6. affiliate_payouts        ← MUST come before clawbacks
--   7. affiliate_earnings       ← MUST come before clawbacks
--   8. affiliate_clawbacks      ← references payouts + earnings
--   9. affiliate_reserve_releases
--  10. affiliate_status_log
--  11. ALTER TABLE user_profiles
--  12. claim_legacy_slot RPC function
--
-- Safe to re-run — all CREATE IF NOT EXISTS guards are in place.
--
-- RLS NOTE: All service role policies use USING (true) WITH CHECK (true)
-- NOT auth.role() = 'service_role' — that pattern is broken in
-- this Supabase setup. See ISSUE-029.
-- ============================================================


-- ============================================================
-- BLOCK 1: legacy_cohorts
-- One row per cohort year (2025, 2026, etc).
-- Each year has its own locked Stripe Price ID.
-- Existing subscribers are NEVER moved to a new cohort price.
-- ============================================================
CREATE TABLE IF NOT EXISTS legacy_cohorts (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  cohort_year      INT  NOT NULL UNIQUE,            -- e.g. 2026
  price_monthly    INT  NOT NULL,                   -- cents, e.g. 5900 = $59/mo
  stripe_price_id  TEXT NOT NULL,                   -- Stripe Price object ID for this cohort
  is_current       BOOLEAN NOT NULL DEFAULT false,  -- only one row is true at a time
  created_at       TIMESTAMPTZ DEFAULT now()
);

-- Only one cohort can be "current" at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_legacy_cohorts_current
  ON legacy_cohorts (is_current)
  WHERE is_current = true;

ALTER TABLE legacy_cohorts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access to legacy_cohorts" ON legacy_cohorts;
CREATE POLICY "Service role full access to legacy_cohorts"
  ON legacy_cohorts FOR ALL USING (true) WITH CHECK (true);


-- ============================================================
-- BLOCK 2: legacy_slots
-- Single-row table tracking slot cap and usage.
-- Uses SELECT FOR UPDATE in application code to prevent
-- race conditions on simultaneous Legacy signups.
-- ============================================================
CREATE TABLE IF NOT EXISTS legacy_slots (
  id           UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  slot_cap     INT NOT NULL DEFAULT 100,   -- admin-set total limit
  slots_used   INT NOT NULL DEFAULT 0,     -- atomic counter
  updated_at   TIMESTAMPTZ DEFAULT now(),
  -- DB-level guard: slots_used can never exceed slot_cap
  CONSTRAINT slots_used_lte_cap CHECK (slots_used <= slot_cap),
  CONSTRAINT slots_used_non_negative CHECK (slots_used >= 0)
);

-- Seed the single row on first run
INSERT INTO legacy_slots (slot_cap, slots_used)
VALUES (100, 0)
ON CONFLICT DO NOTHING;

ALTER TABLE legacy_slots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access to legacy_slots" ON legacy_slots;
CREATE POLICY "Service role full access to legacy_slots"
  ON legacy_slots FOR ALL USING (true) WITH CHECK (true);

-- Public read so the pricing page can show the countdown without auth
DROP POLICY IF EXISTS "Public can read legacy_slots" ON legacy_slots;
CREATE POLICY "Public can read legacy_slots"
  ON legacy_slots FOR SELECT USING (true);


-- ============================================================
-- BLOCK 3: referral_slugs
-- One row per Legacy member. Slug is immutable after the user
-- sets a custom value. Auto-generated slug is set at account
-- creation. Slug -> user_id mapping is server-side only.
-- ============================================================
CREATE TABLE IF NOT EXISTS referral_slugs (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id        UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  slug           TEXT NOT NULL UNIQUE,
  is_custom      BOOLEAN NOT NULL DEFAULT false, -- false = auto-generated, true = user-set
  click_count    INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ DEFAULT now(),
  customized_at  TIMESTAMPTZ                     -- null until user sets custom slug
);

CREATE INDEX IF NOT EXISTS idx_referral_slugs_slug ON referral_slugs (slug);
CREATE INDEX IF NOT EXISTS idx_referral_slugs_user ON referral_slugs (user_id);

ALTER TABLE referral_slugs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access to referral_slugs" ON referral_slugs;
CREATE POLICY "Service role full access to referral_slugs"
  ON referral_slugs FOR ALL USING (true) WITH CHECK (true);

-- Users can read their own slug (for displaying their link)
DROP POLICY IF EXISTS "Users can read own slug" ON referral_slugs;
CREATE POLICY "Users can read own slug"
  ON referral_slugs FOR SELECT USING (auth.uid() = user_id);


-- ============================================================
-- BLOCK 4: referrals
-- One row per referred signup. Tracks the relationship between
-- referrer (affiliate) and the user they brought in.
-- Includes fraud detection fields.
-- ============================================================
CREATE TABLE IF NOT EXISTS referrals (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  referrer_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  referred_user_id      UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE RESTRICT,
  referred_plan_at_signup TEXT NOT NULL,            -- plan tier when they signed up
  current_plan          TEXT NOT NULL,              -- updated on every plan change
  status                TEXT NOT NULL DEFAULT 'active', -- active, cancelled, fraud_flagged
  ip_at_signup          TEXT,                       -- for fraud review
  device_fingerprint    TEXT,                       -- for fraud review
  cookie_ip             TEXT,                       -- IP when referral cookie was set
  referrer_url          TEXT,                       -- URL referrer when cookie was set
  created_at            TIMESTAMPTZ DEFAULT now(),
  cancelled_at          TIMESTAMPTZ,
  fraud_flagged_at      TIMESTAMPTZ,
  fraud_flag_reason     TEXT,
  CONSTRAINT referrals_status_check CHECK (status IN ('active', 'cancelled', 'fraud_flagged'))
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer   ON referrals (referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred   ON referrals (referred_user_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status     ON referrals (status);
CREATE INDEX IF NOT EXISTS idx_referrals_created    ON referrals (created_at DESC);

ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access to referrals" ON referrals;
CREATE POLICY "Service role full access to referrals"
  ON referrals FOR ALL USING (true) WITH CHECK (true);


-- ============================================================
-- BLOCK 5: referral_plan_history
-- Immutable log of every plan change on a referred user.
-- Used by admin audit log and commission recalculation.
-- Never delete rows from this table.
-- ============================================================
CREATE TABLE IF NOT EXISTS referral_plan_history (
  id                        UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  referral_id               UUID NOT NULL REFERENCES referrals(id) ON DELETE RESTRICT,
  old_plan                  TEXT NOT NULL,
  new_plan                  TEXT NOT NULL,
  changed_at                TIMESTAMPTZ DEFAULT now(),
  commission_rate_at_change NUMERIC(5,4)  -- affiliate's tier rate at that moment (e.g. 0.2000)
);

CREATE INDEX IF NOT EXISTS idx_plan_history_referral ON referral_plan_history (referral_id);
CREATE INDEX IF NOT EXISTS idx_plan_history_changed  ON referral_plan_history (changed_at DESC);

ALTER TABLE referral_plan_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access to referral_plan_history" ON referral_plan_history;
CREATE POLICY "Service role full access to referral_plan_history"
  ON referral_plan_history FOR ALL USING (true) WITH CHECK (true);


-- ============================================================
-- BLOCK 6: affiliate_payouts
-- IMPORTANT: This must come BEFORE affiliate_clawbacks and
-- affiliate_reserve_releases — both tables reference this one.
--
-- One row per monthly payout attempt. Tracks gross, deductions,
-- net, Stripe transfer ID, and the verified Connect account ID
-- used at payout time (for fraud audit trail).
-- ============================================================
CREATE TABLE IF NOT EXISTS affiliate_payouts (
  id                          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  affiliate_id                UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  period_month                TEXT NOT NULL,        -- YYYY-MM earnings this covers
  gross_amount                INT  NOT NULL,        -- cents before deductions
  clawbacks_deducted          INT  NOT NULL DEFAULT 0, -- cents
  reserve_withheld            INT  NOT NULL DEFAULT 0, -- 10% reserve cents
  stripe_fees                 INT  NOT NULL DEFAULT 0, -- cents
  net_amount                  INT  NOT NULL,        -- cents actually paid out
  stripe_transfer_id          TEXT,                 -- Stripe payout reference (null until processed)
  stripe_connect_account_id   TEXT,                 -- verified Connect account ID at payout time
  status                      TEXT NOT NULL DEFAULT 'pending',
  hold_reason                 TEXT,                 -- null unless status = held
  processed_at                TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT payouts_status_check CHECK (status IN ('pending', 'processing', 'paid', 'held', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_payouts_affiliate ON affiliate_payouts (affiliate_id);
CREATE INDEX IF NOT EXISTS idx_payouts_status    ON affiliate_payouts (status);
CREATE INDEX IF NOT EXISTS idx_payouts_period    ON affiliate_payouts (period_month);

ALTER TABLE affiliate_payouts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access to affiliate_payouts" ON affiliate_payouts;
CREATE POLICY "Service role full access to affiliate_payouts"
  ON affiliate_payouts FOR ALL USING (true) WITH CHECK (true);

-- Affiliates can read their own payouts
DROP POLICY IF EXISTS "Affiliates can read own payouts" ON affiliate_payouts;
CREATE POLICY "Affiliates can read own payouts"
  ON affiliate_payouts FOR SELECT USING (auth.uid() = affiliate_id);


-- ============================================================
-- BLOCK 7: affiliate_earnings
-- IMPORTANT: This must come BEFORE affiliate_clawbacks —
-- clawbacks reference this table.
--
-- One row per invoice payment from a referred user.
-- stripe_invoice_id is the idempotency key — prevents double-
-- crediting if the same Stripe webhook fires twice.
-- status moves: pending -> eligible -> paid | clawed_back
-- ============================================================
CREATE TABLE IF NOT EXISTS affiliate_earnings (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  referral_id           UUID NOT NULL REFERENCES referrals(id) ON DELETE RESTRICT,
  affiliate_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  stripe_invoice_id     TEXT NOT NULL UNIQUE,       -- idempotency key
  invoice_amount        INT  NOT NULL,              -- cents — what referred user paid
  commission_rate       NUMERIC(5,4) NOT NULL,      -- e.g. 0.2000
  commission_amount     INT  NOT NULL,              -- cents earned (floor of invoice_amount * rate)
  affiliate_tier_at_time INT NOT NULL,              -- number of active referrals at invoice time
  referred_plan_at_time TEXT NOT NULL,              -- referred user's plan at invoice time
  period_month          TEXT NOT NULL,              -- YYYY-MM — which month this accrues to
  status                TEXT NOT NULL DEFAULT 'pending', -- pending, eligible, paid, clawed_back
  eligible_at           TIMESTAMPTZ,               -- when 30-day window opens (set on creation)
  created_at            TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT earnings_status_check CHECK (status IN ('pending', 'eligible', 'paid', 'clawed_back'))
);

CREATE INDEX IF NOT EXISTS idx_earnings_affiliate    ON affiliate_earnings (affiliate_id);
CREATE INDEX IF NOT EXISTS idx_earnings_referral     ON affiliate_earnings (referral_id);
CREATE INDEX IF NOT EXISTS idx_earnings_period       ON affiliate_earnings (period_month);
CREATE INDEX IF NOT EXISTS idx_earnings_status       ON affiliate_earnings (status);
CREATE INDEX IF NOT EXISTS idx_earnings_eligible_at  ON affiliate_earnings (eligible_at);

ALTER TABLE affiliate_earnings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access to affiliate_earnings" ON affiliate_earnings;
CREATE POLICY "Service role full access to affiliate_earnings"
  ON affiliate_earnings FOR ALL USING (true) WITH CHECK (true);

-- Affiliates can read their own earnings
DROP POLICY IF EXISTS "Affiliates can read own earnings" ON affiliate_earnings;
CREATE POLICY "Affiliates can read own earnings"
  ON affiliate_earnings FOR SELECT USING (auth.uid() = affiliate_id);


-- ============================================================
-- BLOCK 8: affiliate_clawbacks
-- IMPORTANT: Runs AFTER affiliate_payouts and affiliate_earnings.
-- Both tables must exist before this one is created.
--
-- One row per reversed commission. Immutable — never delete.
-- Linked to the earning that was reversed and the payout it
-- was deducted from (null until applied at payout time).
-- ============================================================
CREATE TABLE IF NOT EXISTS affiliate_clawbacks (
  id                      UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  affiliate_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  earning_id              UUID NOT NULL REFERENCES affiliate_earnings(id) ON DELETE RESTRICT,
  reason                  TEXT NOT NULL,            -- chargeback, refund, fraud
  stripe_event_id         TEXT NOT NULL UNIQUE,     -- source Stripe dispute/refund event
  amount_reversed         INT  NOT NULL,            -- cents
  deducted_from_payout_id UUID REFERENCES affiliate_payouts(id), -- null until applied at payout time
  created_at              TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clawbacks_affiliate ON affiliate_clawbacks (affiliate_id);
CREATE INDEX IF NOT EXISTS idx_clawbacks_earning   ON affiliate_clawbacks (earning_id);
CREATE INDEX IF NOT EXISTS idx_clawbacks_created   ON affiliate_clawbacks (created_at DESC);

ALTER TABLE affiliate_clawbacks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access to affiliate_clawbacks" ON affiliate_clawbacks;
CREATE POLICY "Service role full access to affiliate_clawbacks"
  ON affiliate_clawbacks FOR ALL USING (true) WITH CHECK (true);

-- Affiliates can read their own clawbacks (dashboard display only)
DROP POLICY IF EXISTS "Affiliates can read own clawbacks" ON affiliate_clawbacks;
CREATE POLICY "Affiliates can read own clawbacks"
  ON affiliate_clawbacks FOR SELECT USING (auth.uid() = affiliate_id);


-- ============================================================
-- BLOCK 9: affiliate_reserve_releases
-- Tracks when the 10% clawback reserve from a prior payout
-- is released back to the affiliate (after 60 days clean).
-- ============================================================
CREATE TABLE IF NOT EXISTS affiliate_reserve_releases (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  affiliate_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  payout_id         UUID NOT NULL REFERENCES affiliate_payouts(id) ON DELETE RESTRICT, -- original payout
  amount            INT  NOT NULL,                  -- cents released
  release_payout_id UUID REFERENCES affiliate_payouts(id), -- payout it was added to (null = pending release)
  released_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reserve_releases_affiliate ON affiliate_reserve_releases (affiliate_id);
CREATE INDEX IF NOT EXISTS idx_reserve_releases_payout    ON affiliate_reserve_releases (payout_id);

ALTER TABLE affiliate_reserve_releases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access to affiliate_reserve_releases" ON affiliate_reserve_releases;
CREATE POLICY "Service role full access to affiliate_reserve_releases"
  ON affiliate_reserve_releases FOR ALL USING (true) WITH CHECK (true);


-- ============================================================
-- BLOCK 10: affiliate_status_log
-- Immutable audit log of every status change for every affiliate.
-- Never delete rows. Used by admin audit view.
-- ============================================================
CREATE TABLE IF NOT EXISTS affiliate_status_log (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  affiliate_id  UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  event_type    TEXT NOT NULL,  -- good_standing_lost, reinstated, suspended, connect_deauthorized,
                                --   fraud_flagged, tier_changed, payout_held, payout_released
  old_value     TEXT,
  new_value     TEXT,
  reason        TEXT,
  acted_by      UUID,           -- admin user_id, or null for system-triggered events
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_status_log_affiliate ON affiliate_status_log (affiliate_id);
CREATE INDEX IF NOT EXISTS idx_status_log_type      ON affiliate_status_log (event_type);
CREATE INDEX IF NOT EXISTS idx_status_log_created   ON affiliate_status_log (created_at DESC);

ALTER TABLE affiliate_status_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Service role full access to affiliate_status_log" ON affiliate_status_log;
CREATE POLICY "Service role full access to affiliate_status_log"
  ON affiliate_status_log FOR ALL USING (true) WITH CHECK (true);


-- ============================================================
-- BLOCK 11: user_profiles — add Legacy-related columns
-- cohort_year: which year's pricing they locked in
-- stripe_connect_account_id: their connected Stripe account
-- affiliate_suspended: true if admin has suspended payouts
-- ============================================================
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS cohort_year                  INT,
  ADD COLUMN IF NOT EXISTS legacy_stripe_price_id       TEXT,    -- locked Stripe price at signup
  ADD COLUMN IF NOT EXISTS stripe_connect_account_id    TEXT,    -- their Stripe Connect account
  ADD COLUMN IF NOT EXISTS stripe_connect_onboarded_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS affiliate_suspended          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS affiliate_suspended_reason   TEXT,
  ADD COLUMN IF NOT EXISTS affiliate_suspended_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS referral_slug_id             UUID REFERENCES referral_slugs(id);


-- ============================================================
-- BLOCK 12: claim_legacy_slot RPC function
-- Called by affiliateService.claimLegacySlot() at checkout.
-- Uses SELECT FOR UPDATE to prevent race conditions when two
-- people try to claim the last slot at the exact same time.
-- If no slots remain, raises an exception (caught in the service).
-- ============================================================
CREATE OR REPLACE FUNCTION claim_legacy_slot()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_cap  INT;
  v_used INT;
BEGIN
  -- Lock the single row so concurrent checkouts wait their turn
  SELECT slot_cap, slots_used
    INTO v_cap, v_used
    FROM legacy_slots
   FOR UPDATE;

  IF v_used >= v_cap THEN
    RAISE EXCEPTION 'Legacy slots are sold out (cap=%, used=%)', v_cap, v_used;
  END IF;

  UPDATE legacy_slots
     SET slots_used = slots_used + 1,
         updated_at = now();
END;
$$;
