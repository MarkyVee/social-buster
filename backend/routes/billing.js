/**
 * routes/billing.js
 *
 * Stripe billing and subscription management routes.
 *
 * IMPORTANT: /billing/webhook must receive the RAW request body
 * (not JSON-parsed) so Stripe's signature verification works.
 * This is handled in server.js before the JSON body parser runs.
 */

const express = require('express');
const router = express.Router();

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const {
  createCheckoutSession,
  createPortalSession,
  cancelSubscription,
  downgradeToFree,
  changePlan,
  createStripeCustomer,
} = require('../services/stripeService');
const { supabaseAdmin } = require('../services/supabaseService');
const { requireAuth } = require('../middleware/auth');
const { standardLimiter } = require('../middleware/rateLimit');
const { getAllLimits } = require('../middleware/checkLimit');
const {
  getLegacySlotDisplay,
  getCurrentLegacyCohort,
  parseReferralCookie,
} = require('../services/affiliateService');

// Apply standard rate limiting to all billing routes
router.use(standardLimiter);

// ----------------------------------------------------------------
// GET /billing/plans
// Returns all active subscription plans from the database.
// Public route — no auth required.
// ----------------------------------------------------------------
router.get('/plans', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('plans')
      .select('tier, name, price_display, period_label, features, color, badge, sort_order, logo_url')
      .eq('is_active', true)
      .order('sort_order');

    if (error) throw new Error(error.message);

    return res.json({ plans: data || [] });

  } catch (err) {
    console.error('[Billing] Plans fetch error:', err.message);
    // Fallback to empty array — don't crash the page
    return res.json({ plans: [] });
  }
});

// ----------------------------------------------------------------
// GET /billing/status
// Returns the current user's subscription status and plan.
// ----------------------------------------------------------------
router.get('/status', requireAuth, async (req, res) => {
  try {
    // 1. Check for admin override in user_profiles first.
    //    Admin can manually set a user's tier via the Admin Dashboard,
    //    which takes priority over whatever Stripe says.
    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('subscription_tier')
      .eq('user_id', req.user.id)
      .single();

    const adminOverride = profile?.subscription_tier || null;

    // 2. Get the Stripe subscription (if any)
    const { data, error } = await supabaseAdmin
      .from('subscriptions')
      .select('plan, status, current_period_end')
      .eq('user_id', req.user.id)
      .single();

    // If no subscription row exists (user registered before billing was set up),
    // return a default free_trial status instead of 404.
    // This prevents the frontend from breaking for pre-billing users.
    if (error || !data) {
      console.warn(`[Billing] No subscription found for user ${req.user.id} — error: ${error?.message || 'no row'}`);
      return res.json({
        subscription: {
          plan:               adminOverride || 'free_trial',
          status:             'active',
          current_period_end: null,
          admin_override:     !!adminOverride
        }
      });
    }

    // If admin override exists, use it instead of the Stripe plan
    if (adminOverride) {
      data.plan           = adminOverride;
      data.admin_override = true;
    }

    return res.json({ subscription: data });

  } catch (err) {
    console.error('[Billing] Status error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch subscription status' });
  }
});

// ----------------------------------------------------------------
// GET /billing/my-limits
// Returns the tier limits for the current user's plan.
// Used by the frontend to enforce caps (e.g. platform checkboxes).
// ----------------------------------------------------------------
router.get('/my-limits', requireAuth, async (req, res) => {
  try {
    // Determine the user's tier (same logic as checkLimit middleware)
    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('subscription_tier')
      .eq('user_id', req.user.id)
      .single();

    let tier = profile?.subscription_tier || null;

    if (!tier) {
      const { data: sub } = await supabaseAdmin
        .from('subscriptions')
        .select('plan, status')
        .eq('user_id', req.user.id)
        .single();

      const activePlan = (sub?.status === 'active' || sub?.status === 'trialing')
        ? (sub?.plan || 'free')
        : 'free';
      tier = activePlan === 'free' ? 'free_trial' : activePlan;
    }

    // Get all limits and filter to this tier
    const allLimits = await getAllLimits();
    const myLimits = {};
    for (const row of allLimits) {
      if (row.tier === tier) {
        myLimits[row.feature] = {
          enabled:     row.enabled,
          limit_value: row.limit_value,
          label:       row.label
        };
      }
    }

    return res.json({ tier, limits: myLimits });

  } catch (err) {
    console.error('[Billing] My-limits error:', err.message);
    return res.json({ tier: 'free_trial', limits: {} });
  }
});

// ----------------------------------------------------------------
// POST /billing/subscribe
// Creates a Stripe Checkout session for a plan upgrade.
// Returns a URL for the frontend to redirect the user to.
// Body: { plan: 'starter' | 'professional' | 'enterprise' }
// ----------------------------------------------------------------
router.post('/subscribe', requireAuth, async (req, res) => {
  const { plan } = req.body;

  if (!plan) {
    return res.status(400).json({ error: 'Plan is required' });
  }

  try {
    const session = await createCheckoutSession(req.user.id, plan);
    return res.json({ checkoutUrl: session.url });

  } catch (err) {
    console.error('[Billing] Subscribe error:', err.message, err.stack);
    return res.status(500).json({ error: err.message || 'Failed to create checkout session' });
  }
});

// ----------------------------------------------------------------
// POST /billing/portal
// Opens the Stripe Customer Portal for self-service management.
// Returns a URL for the frontend to redirect the user to.
// ----------------------------------------------------------------
router.post('/portal', requireAuth, async (req, res) => {
  try {
    const session = await createPortalSession(req.user.id);
    return res.json({ portalUrl: session.url });

  } catch (err) {
    console.error('[Billing] Portal error:', err.message);
    return res.status(500).json({ error: 'Failed to open billing portal' });
  }
});

// ----------------------------------------------------------------
// POST /billing/change
// Change the user's plan (upgrade or downgrade).
// Body: { plan: 'starter' | 'professional' | 'enterprise' }
// ----------------------------------------------------------------
router.post('/change', requireAuth, async (req, res) => {
  const { plan } = req.body;

  if (!plan) {
    return res.status(400).json({ error: 'Plan is required' });
  }

  try {
    await changePlan(req.user.id, plan);
    return res.json({ success: true, message: `Plan changed to ${plan}` });

  } catch (err) {
    console.error('[Billing] Plan change error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to change plan' });
  }
});

// ----------------------------------------------------------------
// POST /billing/cancel
// Cancel the user's subscription at the end of the current period.
// ----------------------------------------------------------------
router.post('/cancel', requireAuth, async (req, res) => {
  try {
    await cancelSubscription(req.user.id);
    return res.json({ success: true, message: 'Subscription will cancel at end of billing period' });

  } catch (err) {
    console.error('[Billing] Cancel error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to cancel subscription' });
  }
});

// ----------------------------------------------------------------
// POST /billing/downgrade-free
// Immediately cancels the Stripe subscription and reverts to free_trial.
// Used when a paid user clicks "Downgrade to Free".
// ----------------------------------------------------------------
router.post('/downgrade-free', requireAuth, async (req, res) => {
  try {
    await downgradeToFree(req.user.id);
    return res.json({ success: true, message: 'Downgraded to Free Trial' });

  } catch (err) {
    console.error('[Billing] Downgrade error:', err.message);
    return res.status(500).json({ error: err.message || 'Failed to downgrade' });
  }
});

// ----------------------------------------------------------------
// GET /billing/legacy/info
// Public route — returns the current Legacy cohort pricing and
// the slot display data (for the pricing page countdown).
// No auth required so the landing/pricing page can show this.
// ----------------------------------------------------------------
router.get('/legacy/info', async (req, res) => {
  try {
    const [cohort, slotDisplay] = await Promise.all([
      getCurrentLegacyCohort(),
      getLegacySlotDisplay(),
    ]);

    if (!cohort) {
      return res.json({ available: false, slotDisplay });
    }

    return res.json({
      available: true,
      cohortYear: cohort.cohort_year,
      priceMonthly: cohort.price_monthly,    // cents — e.g. 5900 = $59/mo
      slotDisplay,
    });

  } catch (err) {
    console.error('[Billing] Legacy info error:', err.message);
    return res.status(500).json({ error: 'Failed to load Legacy info.' });
  }
});

// ----------------------------------------------------------------
// POST /billing/legacy/checkout
// Initiates a Stripe Checkout session for Legacy membership.
//
// How it differs from the normal /billing/subscribe flow:
//  - Uses the current cohort's locked Stripe Price ID (not a plan lookup)
//  - Passes checkout_type: "legacy" in metadata so the webhook knows
//    to run the slot claim + referral recording logic
//  - Passes the referral cookie value in metadata so the webhook can
//    record the referral relationship without reading cookies server-side
//  - Passes cohort_year + stripe_price_id so the webhook can lock them
//    on the user's profile
//  - The user must be logged in (requires auth)
//  - If slots are already sold out, returns 409 before creating a session
// ----------------------------------------------------------------
router.post('/legacy/checkout', requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;

    // 1. Verify the user is not already a Legacy member
    const { data: profile } = await supabaseAdmin
      .from('user_profiles')
      .select('subscription_tier')
      .eq('user_id', userId)
      .single();

    if (profile?.subscription_tier === 'legacy') {
      return res.status(400).json({ error: 'You are already a Legacy member.' });
    }

    // 2. Verify slots are still available (pre-check — real atomic claim happens in webhook)
    const slotDisplay = await getLegacySlotDisplay();
    if (slotDisplay.soldOut) {
      return res.status(409).json({
        error: 'Legacy membership is sold out.',
        soldOut: true,
      });
    }

    // 3. Get the current cohort pricing
    const cohort = await getCurrentLegacyCohort();
    if (!cohort || !cohort.stripe_price_id) {
      return res.status(503).json({ error: 'Legacy membership is not currently available.' });
    }

    // 4. Look up or create the user's Stripe customer ID
    let { data: sub } = await supabaseAdmin
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .single();

    if (!sub?.stripe_customer_id) {
      const { data: authData } = await supabaseAdmin.auth.admin.getUserById(userId);
      const email = authData?.user?.email;
      if (!email) throw new Error('Could not find user email to create Stripe customer');

      const customer = await createStripeCustomer(userId, email);
      sub = { stripe_customer_id: customer.id };
    }

    // 5. Read the referral cookie (if present) so we can pass it to the webhook
    //    via session metadata. The webhook will use it to record the referral.
    //    We store the raw cookie value — parseReferralCookie() verifies the HMAC.
    const referralCookieRaw = req.cookies['sb_ref'] || '';

    // 6. Create the Stripe Checkout session for Legacy
    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    const session = await stripe.checkout.sessions.create({
      customer: sub.stripe_customer_id,
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: cohort.stripe_price_id, quantity: 1 }],
      success_url: `${baseUrl}/#settings?payment=legacy_success`,
      cancel_url:  `${baseUrl}/#settings?payment=cancelled`,
      // All metadata is read by the checkout.session.completed webhook handler
      metadata: {
        checkout_type:    'legacy',
        user_id:          userId,
        cohort_year:      String(cohort.cohort_year),
        stripe_price_id:  cohort.stripe_price_id,
        referral_cookie:  referralCookieRaw,       // passed to webhook for referral recording
        ip_at_signup:     req.ip || '',
      },
    });

    return res.json({ checkoutUrl: session.url });

  } catch (err) {
    console.error('[Billing] Legacy checkout error:', err.message);
    return res.status(500).json({ error: 'Failed to create Legacy checkout session.' });
  }
});

// NOTE: The webhook handler is mounted directly in server.js as
// app.post('/billing/webhook', ...) BEFORE express.json() runs,
// so Stripe gets the raw Buffer it needs for signature verification.
// Do NOT add a duplicate webhook handler here.

module.exports = router;
