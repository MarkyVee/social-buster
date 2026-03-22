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

const {
  createCheckoutSession,
  createPortalSession,
  cancelSubscription,
  downgradeToFree,
  changePlan
} = require('../services/stripeService');
const { supabaseAdmin } = require('../services/supabaseService');
const { requireAuth } = require('../middleware/auth');
const { standardLimiter } = require('../middleware/rateLimit');
const { getAllLimits } = require('../middleware/checkLimit');

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
      .select('tier, name, price_display, period_label, features, color, badge, sort_order')
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

// NOTE: The webhook handler is mounted directly in server.js as
// app.post('/billing/webhook', ...) BEFORE express.json() runs,
// so Stripe gets the raw Buffer it needs for signature verification.
// Do NOT add a duplicate webhook handler here.

module.exports = router;
