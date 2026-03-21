/**
 * services/stripeService.js
 *
 * All Stripe billing operations: customer creation, checkout sessions,
 * customer portal, and webhook event handling.
 */

const Stripe = require('stripe');
const { supabaseAdmin } = require('./supabaseService');

// Initialise Stripe with the secret key from environment
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2023-10-16'
});

// ----------------------------------------------------------------
// Plan lookup helper.
// Fetches the Stripe price ID from the plans table in the database.
// This replaces the old hardcoded PLANS object so admins can update
// plans from the dashboard without a code change.
// ----------------------------------------------------------------
async function getPlanByTier(tier) {
  const { data, error } = await supabaseAdmin
    .from('plans')
    .select('tier, name, stripe_price_id')
    .eq('tier', tier)
    .eq('is_active', true)
    .single();

  if (error || !data) return null;
  return data;
}

// Reverse lookup: find which tier a Stripe price ID belongs to.
// Used by the webhook handler when Stripe tells us a subscription changed.
async function getTierByPriceId(priceId) {
  if (!priceId) return 'free_trial';

  const { data } = await supabaseAdmin
    .from('plans')
    .select('tier')
    .eq('stripe_price_id', priceId)
    .single();

  if (!data?.tier) {
    console.warn(`[Stripe] No plan found for price ID: ${priceId} — defaulting to free_trial`);
  }

  return data?.tier || 'free_trial';
}

// ----------------------------------------------------------------
// Create a Stripe customer for a new user.
// Called during registration so billing is ready from day one.
// Stores the Stripe customer ID in the subscriptions table.
// ----------------------------------------------------------------
async function createStripeCustomer(userId, email) {
  // Create the customer in Stripe
  const customer = await stripe.customers.create({
    email,
    metadata: {
      // Store our internal user_id on the Stripe customer for easy lookup
      social_buster_user_id: userId
    }
  });

  // Store the Stripe customer ID + initial free trial plan in our database.
  // Use upsert so this works for both new users (INSERT) and existing users
  // who registered before Stripe was set up (UPDATE with the new customer ID).
  const { error } = await supabaseAdmin
    .from('subscriptions')
    .upsert({
      user_id: userId,
      stripe_customer_id: customer.id,
      plan: 'free_trial',
      status: 'active'
    }, { onConflict: 'user_id' });

  if (error) throw new Error(`Failed to save subscription record: ${error.message}`);

  return customer;
}

// ----------------------------------------------------------------
// Create a Stripe Checkout session for upgrading to a paid plan.
// Returns a URL that the frontend redirects the user to.
// ----------------------------------------------------------------
async function createCheckoutSession(userId, planKey) {
  const plan = await getPlanByTier(planKey);
  if (!plan || !plan.stripe_price_id) {
    throw new Error(`Invalid plan or missing Stripe price ID: ${planKey}`);
  }

  // Look up the user's Stripe customer ID
  let { data: sub } = await supabaseAdmin
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .single();

  // If no subscription row or no Stripe customer exists (user registered before
  // Stripe was set up), create one on the fly so they can still upgrade.
  if (!sub?.stripe_customer_id) {
    // Get the user's email from Supabase Auth
    const { data: authData } = await supabaseAdmin.auth.admin.getUserById(userId);
    const email = authData?.user?.email;
    if (!email) throw new Error('Could not find user email to create Stripe customer');

    console.log(`[Billing] Creating Stripe customer on the fly for user ${userId} (${email})`);
    const customer = await createStripeCustomer(userId, email);
    sub = { stripe_customer_id: customer.id };
  }

  const session = await stripe.checkout.sessions.create({
    customer: sub.stripe_customer_id,
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: plan.stripe_price_id, quantity: 1 }],
    // Where to redirect after payment
    success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/#settings?payment=success`,
    cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/#settings?payment=cancelled`,
    metadata: {
      social_buster_user_id: userId,
      plan: planKey
    }
  });

  return session;
}

// ----------------------------------------------------------------
// Open the Stripe customer portal for self-service plan management.
// (Customers can upgrade, downgrade, or cancel their own subscription.)
// ----------------------------------------------------------------
async function createPortalSession(userId) {
  const { data: sub, error } = await supabaseAdmin
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .single();

  if (error || !sub?.stripe_customer_id) {
    throw new Error('No Stripe customer found for this user');
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: sub.stripe_customer_id,
    return_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/#settings`
  });

  return session;
}

// ----------------------------------------------------------------
// Cancel a user's Stripe subscription at the end of the current period.
// The user keeps access until the billing period ends, then reverts to free.
//
// If the user has no Stripe subscription (e.g. admin-overridden plan),
// we simply revert them to free_trial immediately in the database.
// ----------------------------------------------------------------
async function cancelSubscription(userId) {
  const { data: sub, error } = await supabaseAdmin
    .from('subscriptions')
    .select('stripe_subscription_id')
    .eq('user_id', userId)
    .single();

  if (error) {
    throw new Error('No subscription record found');
  }

  // If there's a real Stripe subscription, cancel at period end
  if (sub?.stripe_subscription_id) {
    const cancelled = await stripe.subscriptions.update(sub.stripe_subscription_id, {
      cancel_at_period_end: true
    });
    return cancelled;
  }

  // No Stripe subscription (admin override or manual plan) — revert to free immediately
  await supabaseAdmin
    .from('subscriptions')
    .update({ plan: 'free_trial', status: 'active', stripe_subscription_id: null })
    .eq('user_id', userId);

  return { reverted_to_free: true };
}

// ----------------------------------------------------------------
// Immediately cancel a Stripe subscription and revert to free_trial.
// Used when a user clicks "Downgrade to Free" — no grace period.
// ----------------------------------------------------------------
async function downgradeToFree(userId) {
  const { data: sub, error } = await supabaseAdmin
    .from('subscriptions')
    .select('stripe_subscription_id')
    .eq('user_id', userId)
    .single();

  if (error) {
    throw new Error('No subscription record found');
  }

  // If there's a real Stripe subscription, cancel it immediately (not at period end)
  if (sub?.stripe_subscription_id) {
    try {
      await stripe.subscriptions.cancel(sub.stripe_subscription_id);
    } catch (stripeErr) {
      console.error('[Stripe] Cancel error (may already be cancelled):', stripeErr.message);
    }
  }

  // Revert to free_trial in our database
  await supabaseAdmin
    .from('subscriptions')
    .update({ plan: 'free_trial', status: 'active', stripe_subscription_id: null })
    .eq('user_id', userId);

  return { success: true };
}

// ----------------------------------------------------------------
// Change a user's subscription to a different plan (upgrade or downgrade).
// Stripe prorates automatically — user pays/credits the difference.
// ----------------------------------------------------------------
async function changePlan(userId, newPlanTier) {
  const plan = await getPlanByTier(newPlanTier);
  if (!plan || !plan.stripe_price_id) {
    throw new Error(`Invalid plan or missing Stripe price ID: ${newPlanTier}`);
  }

  const { data: sub, error } = await supabaseAdmin
    .from('subscriptions')
    .select('stripe_subscription_id')
    .eq('user_id', userId)
    .single();

  if (error || !sub?.stripe_subscription_id) {
    throw new Error('No active Stripe subscription found');
  }

  // Get the current subscription to find the item ID
  const current = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
  const itemId = current.items.data[0]?.id;

  if (!itemId) {
    throw new Error('No subscription item found');
  }

  // Update the subscription to the new price (Stripe prorates automatically)
  const updated = await stripe.subscriptions.update(sub.stripe_subscription_id, {
    items: [{ id: itemId, price: plan.stripe_price_id }],
    cancel_at_period_end: false, // Clear any pending cancellation
    proration_behavior: 'create_prorations'
  });

  return updated;
}

// ----------------------------------------------------------------
// Verify a Stripe webhook signature and return the parsed event.
// IMPORTANT: rawBody must be the raw Buffer — NOT parsed JSON.
// ----------------------------------------------------------------
function constructWebhookEvent(rawBody, signature) {
  return stripe.webhooks.constructEvent(
    rawBody,
    signature,
    process.env.STRIPE_WEBHOOK_SECRET
  );
}

// ----------------------------------------------------------------
// Handle Stripe webhook events and update subscription status in DB.
// Called from the billing route's /webhook endpoint.
// ----------------------------------------------------------------
async function handleWebhookEvent(event) {
  const { type, data } = event;

  switch (type) {

    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const subscription = data.object;
      const customerId = subscription.customer;

      // Find which user this Stripe customer belongs to
      const { data: sub } = await supabaseAdmin
        .from('subscriptions')
        .select('user_id')
        .eq('stripe_customer_id', customerId)
        .single();

      if (!sub) {
        console.warn(`[Stripe] No user found for customer ${customerId}`);
        return;
      }

      // Determine the plan from the price ID
      const priceId = subscription.items?.data?.[0]?.price?.id;
      console.log(`[Stripe] Webhook: customerId=${customerId}, priceId=${priceId}, userId=${sub.user_id}`);
      const plan = await getTierByPriceId(priceId);

      // Map Stripe statuses to our internal statuses
      const statusMap = {
        trialing: 'trialing',
        active: 'active',
        past_due: 'past_due',
        canceled: 'cancelled',
        unpaid: 'past_due'
      };
      const status = statusMap[subscription.status] || 'active';

      await supabaseAdmin
        .from('subscriptions')
        .update({
          stripe_subscription_id: subscription.id,
          plan,
          status,
          current_period_end: new Date(subscription.current_period_end * 1000).toISOString()
        })
        .eq('user_id', sub.user_id);

      console.log(`[Stripe] Updated subscription for user ${sub.user_id}: plan=${plan}, status=${status}`);
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = data.object;
      const { data: sub } = await supabaseAdmin
        .from('subscriptions')
        .select('user_id')
        .eq('stripe_customer_id', subscription.customer)
        .single();

      if (sub) {
        await supabaseAdmin
          .from('subscriptions')
          .update({ plan: 'free_trial', status: 'cancelled', stripe_subscription_id: null })
          .eq('user_id', sub.user_id);

        console.log(`[Stripe] Subscription cancelled for user ${sub.user_id}`);
      }
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = data.object;
      const { data: sub } = await supabaseAdmin
        .from('subscriptions')
        .select('user_id')
        .eq('stripe_customer_id', invoice.customer)
        .single();

      if (sub) {
        await supabaseAdmin
          .from('subscriptions')
          .update({ status: 'past_due' })
          .eq('user_id', sub.user_id);

        console.log(`[Stripe] Payment failed for user ${sub.user_id}`);
      }
      break;
    }

    case 'invoice.payment_succeeded': {
      const invoice = data.object;
      const { data: sub } = await supabaseAdmin
        .from('subscriptions')
        .select('user_id')
        .eq('stripe_customer_id', invoice.customer)
        .single();

      if (sub) {
        await supabaseAdmin
          .from('subscriptions')
          .update({ status: 'active' })
          .eq('user_id', sub.user_id);
      }
      break;
    }

    default:
      // Ignore unhandled event types
      console.log(`[Stripe] Unhandled event type: ${type}`);
  }
}

module.exports = {
  getPlanByTier,
  getTierByPriceId,
  createStripeCustomer,
  createCheckoutSession,
  createPortalSession,
  cancelSubscription,
  downgradeToFree,
  changePlan,
  constructWebhookEvent,
  handleWebhookEvent
};
