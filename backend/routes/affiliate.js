/**
 * routes/affiliate.js
 *
 * User-facing affiliate program routes.
 * All routes require authentication. Legacy-gated routes check that
 * the user's subscription tier is 'legacy' before allowing access.
 *
 * Route overview:
 *   GET  /affiliate/dashboard          — summary stats (earnings, referrals, tier)
 *   GET  /affiliate/referrals          — list of referred users + their status
 *   GET  /affiliate/earnings           — paginated earnings history
 *   GET  /affiliate/payouts            — paginated payout history
 *   GET  /affiliate/clawbacks          — clawback history
 *   POST /affiliate/slug               — set a custom referral slug (one-time)
 *   GET  /affiliate/connect-status     — Stripe Connect onboarding status
 *   POST /affiliate/connect            — generate Stripe Connect onboarding link
 *
 *   GET  /affiliate/legacy/slots       — public: slot display data for pricing page
 *   POST /billing/legacy/checkout      — initiate Legacy Stripe checkout (in billing.js)
 */

const express = require('express');
const router  = express.Router();

const { requireAuth } = require('../middleware/auth');
const { supabaseAdmin } = require('../services/supabaseService');
const {
  getLegacySlotDisplay,
  createConnectOnboardingLink,
  setCustomSlug,
  checkAffiliateGoodStanding,
} = require('../services/affiliateService');

// ----------------------------------------------------------------
// Helper: verify the requesting user has an active Legacy subscription.
// Returns { ok: true } or sends a 403 response directly.
// ----------------------------------------------------------------
async function requireLegacy(req, res) {
  const { data: profile, error } = await supabaseAdmin
    .from('user_profiles')
    .select('subscription_tier')
    .eq('user_id', req.user.id)
    .single();

  if (error || !profile) {
    res.status(403).json({ error: 'Unable to verify subscription tier.' });
    return false;
  }

  if (profile.subscription_tier !== 'legacy') {
    res.status(403).json({ error: 'This feature is only available to Legacy members.' });
    return false;
  }

  return true;
}

// ================================================================
// PUBLIC — no auth required
// ================================================================

// ----------------------------------------------------------------
// GET /affiliate/legacy/slots
// Returns slot count data for the public pricing page countdown.
// The frontend never shows the raw numbers — it uses getLegacySlotDisplay()
// logic to show "X spots remaining" (always 25 below real number,
// floor at "1 Remaining!" when ≤ 5 real slots are left).
// ----------------------------------------------------------------
router.get('/legacy/slots', async (req, res) => {
  try {
    const display = await getLegacySlotDisplay();
    return res.json(display);
  } catch (err) {
    console.error('[Affiliate] Slots fetch error:', err.message);
    // Return a safe fallback so the pricing page doesn't break
    return res.json({ displayText: 'Limited spots remaining', urgent: false });
  }
});

// ================================================================
// AUTHENTICATED routes — all require login
// ================================================================

// ----------------------------------------------------------------
// GET /affiliate/dashboard
// Returns a summary for the affiliate dashboard tab:
//   - referral slug + link
//   - total active referrals
//   - current commission tier + rate
//   - pending, eligible, and lifetime earnings
//   - next payout estimate
//   - good standing status
//   - Stripe Connect status
// ----------------------------------------------------------------
router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const isLegacy = await requireLegacy(req, res);
    if (!isLegacy) return; // requireLegacy already sent the 403

    const userId = req.user.id;

    // 1. Fetch the user's referral slug
    const { data: slugRow } = await supabaseAdmin
      .from('referral_slugs')
      .select('slug, is_custom, click_count')
      .eq('user_id', userId)
      .single();

    // 2. Count active referrals (paid invoice in last 35 days)
    const thirtyFiveDaysAgo = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();
    const { count: activeReferrals } = await supabaseAdmin
      .from('referrals')
      .select('id', { count: 'exact', head: true })
      .eq('referrer_id', userId)
      .eq('status', 'active');

    // 3. Aggregate earnings summary
    const { data: earningsSummary } = await supabaseAdmin
      .from('affiliate_earnings')
      .select('status, commission_amount')
      .eq('affiliate_id', userId);

    let pendingEarnings  = 0;
    let eligibleEarnings = 0;
    let lifetimeEarnings = 0;

    for (const row of earningsSummary || []) {
      const amt = row.commission_amount || 0;
      lifetimeEarnings += amt;
      if (row.status === 'pending')  pendingEarnings  += amt;
      if (row.status === 'eligible') eligibleEarnings += amt;
    }

    // 4. Commission rate at current tier
    // Tier: 1-5 active = 15%, 6-10 = 20%, 11+ = 25%
    let commissionRate = 0.15;
    let tierLabel = 'Bronze (1–5 referrals)';
    if (activeReferrals >= 11) {
      commissionRate = 0.25;
      tierLabel = 'Gold (11+ referrals)';
    } else if (activeReferrals >= 6) {
      commissionRate = 0.20;
      tierLabel = 'Silver (6–10 referrals)';
    }

    // 5. Good standing status + Stripe Connect status
    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('stripe_connect_account_id, stripe_connect_onboarded_at, affiliate_suspended, affiliate_suspended_reason')
      .eq('user_id', userId)
      .single();

    const connectOnboarded = !!(profile?.stripe_connect_onboarded_at);
    const suspended        = !!(profile?.affiliate_suspended);

    // 6. Build referral link
    const baseUrl = process.env.FRONTEND_URL || 'https://yourdomain.com';
    const referralLink = slugRow ? `${baseUrl}/ref/${slugRow.slug}` : null;

    return res.json({
      slug: slugRow?.slug || null,
      isCustomSlug: slugRow?.is_custom || false,
      clickCount: slugRow?.click_count || 0,
      referralLink,
      activeReferrals: activeReferrals || 0,
      commissionRate,
      tierLabel,
      pendingEarnings,
      eligibleEarnings,
      lifetimeEarnings,
      connectOnboarded,
      suspended,
      suspendedReason: profile?.affiliate_suspended_reason || null,
    });

  } catch (err) {
    console.error('[Affiliate] Dashboard error:', err.message);
    return res.status(500).json({ error: 'Failed to load affiliate dashboard.' });
  }
});

// ----------------------------------------------------------------
// GET /affiliate/referrals
// Paginated list of referred users and their current status.
// Does NOT expose PII — only plan, status, and signup date.
// ----------------------------------------------------------------
router.get('/referrals', requireAuth, async (req, res) => {
  try {
    const isLegacy = await requireLegacy(req, res);
    if (!isLegacy) return;

    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const from  = (page - 1) * limit;

    const { data, count, error } = await supabaseAdmin
      .from('referrals')
      .select('id, current_plan, status, created_at, cancelled_at', { count: 'exact' })
      .eq('referrer_id', req.user.id)
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1);

    if (error) throw new Error(error.message);

    return res.json({
      referrals: data || [],
      total: count || 0,
      page,
      limit,
    });

  } catch (err) {
    console.error('[Affiliate] Referrals list error:', err.message);
    return res.status(500).json({ error: 'Failed to load referrals.' });
  }
});

// ----------------------------------------------------------------
// GET /affiliate/earnings
// Paginated earnings history. Supports ?status= filter.
// ----------------------------------------------------------------
router.get('/earnings', requireAuth, async (req, res) => {
  try {
    const isLegacy = await requireLegacy(req, res);
    if (!isLegacy) return;

    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(50, parseInt(req.query.limit) || 20);
    const from   = (page - 1) * limit;
    const status = req.query.status; // optional filter: pending, eligible, paid, clawed_back

    let query = supabaseAdmin
      .from('affiliate_earnings')
      .select('id, invoice_amount, commission_rate, commission_amount, referred_plan_at_time, period_month, status, eligible_at, created_at', { count: 'exact' })
      .eq('affiliate_id', req.user.id)
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1);

    // Only apply status filter if it's a valid value
    const validStatuses = ['pending', 'eligible', 'paid', 'clawed_back'];
    if (status && validStatuses.includes(status)) {
      query = query.eq('status', status);
    }

    const { data, count, error } = await query;
    if (error) throw new Error(error.message);

    return res.json({
      earnings: data || [],
      total: count || 0,
      page,
      limit,
    });

  } catch (err) {
    console.error('[Affiliate] Earnings list error:', err.message);
    return res.status(500).json({ error: 'Failed to load earnings.' });
  }
});

// ----------------------------------------------------------------
// GET /affiliate/payouts
// Paginated payout history.
// ----------------------------------------------------------------
router.get('/payouts', requireAuth, async (req, res) => {
  try {
    const isLegacy = await requireLegacy(req, res);
    if (!isLegacy) return;

    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const from  = (page - 1) * limit;

    const { data, count, error } = await supabaseAdmin
      .from('affiliate_payouts')
      .select('id, period_month, gross_amount, clawbacks_deducted, reserve_withheld, stripe_fees, net_amount, status, processed_at, created_at', { count: 'exact' })
      .eq('affiliate_id', req.user.id)
      .order('created_at', { ascending: false })
      .range(from, from + limit - 1);

    if (error) throw new Error(error.message);

    return res.json({
      payouts: data || [],
      total: count || 0,
      page,
      limit,
    });

  } catch (err) {
    console.error('[Affiliate] Payouts list error:', err.message);
    return res.status(500).json({ error: 'Failed to load payouts.' });
  }
});

// ----------------------------------------------------------------
// GET /affiliate/clawbacks
// Clawback history for the current user.
// ----------------------------------------------------------------
router.get('/clawbacks', requireAuth, async (req, res) => {
  try {
    const isLegacy = await requireLegacy(req, res);
    if (!isLegacy) return;

    const { data, error } = await supabaseAdmin
      .from('affiliate_clawbacks')
      .select('id, reason, amount_reversed, created_at')
      .eq('affiliate_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);

    return res.json({ clawbacks: data || [] });

  } catch (err) {
    console.error('[Affiliate] Clawbacks list error:', err.message);
    return res.status(500).json({ error: 'Failed to load clawbacks.' });
  }
});

// ----------------------------------------------------------------
// POST /affiliate/slug
// Allows a Legacy member to set their custom referral slug ONE TIME.
// Body: { slug: "my-brand-name" }
//
// Rules (enforced in affiliateService.setCustomSlug):
//  - 3–40 chars, lowercase letters/numbers/hyphens only
//  - Cannot match reserved words (admin, api, ref, etc.)
//  - Cannot be changed again after setting
//  - Must be unique across all users
// ----------------------------------------------------------------
router.post('/slug', requireAuth, async (req, res) => {
  try {
    const isLegacy = await requireLegacy(req, res);
    if (!isLegacy) return;

    const { slug } = req.body;

    if (!slug || typeof slug !== 'string') {
      return res.status(400).json({ error: 'slug is required.' });
    }

    const result = await setCustomSlug(req.user.id, slug.trim().toLowerCase());
    return res.json(result);

  } catch (err) {
    console.error('[Affiliate] Set slug error:', err.message);
    // Surface user-facing validation errors (e.g. "already taken", "invalid characters")
    return res.status(400).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// GET /affiliate/connect-status
// Returns whether the user has a connected Stripe Connect account
// and whether onboarding is complete.
// ----------------------------------------------------------------
router.get('/connect-status', requireAuth, async (req, res) => {
  try {
    const isLegacy = await requireLegacy(req, res);
    if (!isLegacy) return;

    const { data: profile, error } = await supabaseAdmin
      .from('user_profiles')
      .select('stripe_connect_account_id, stripe_connect_onboarded_at')
      .eq('user_id', req.user.id)
      .single();

    if (error) throw new Error(error.message);

    return res.json({
      hasConnectAccount: !!(profile?.stripe_connect_account_id),
      onboarded: !!(profile?.stripe_connect_onboarded_at),
      onboardedAt: profile?.stripe_connect_onboarded_at || null,
    });

  } catch (err) {
    console.error('[Affiliate] Connect status error:', err.message);
    return res.status(500).json({ error: 'Failed to check Connect status.' });
  }
});

// ----------------------------------------------------------------
// POST /affiliate/connect
// Creates or resumes Stripe Connect onboarding for this user.
// Returns { url } — the frontend redirects the user to Stripe.
//
// If the user already has a Connect account but hasn't finished
// onboarding, a fresh onboarding link is generated for them to continue.
// ----------------------------------------------------------------
router.post('/connect', requireAuth, async (req, res) => {
  try {
    const isLegacy = await requireLegacy(req, res);
    if (!isLegacy) return;

    const { url } = await createConnectOnboardingLink(req.user.id);
    return res.json({ url });

  } catch (err) {
    console.error('[Affiliate] Connect onboarding error:', err.message);
    return res.status(500).json({ error: 'Failed to start Stripe Connect onboarding.' });
  }
});

module.exports = router;
