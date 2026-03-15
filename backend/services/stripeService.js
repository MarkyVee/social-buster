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
// Subscription plan definitions.
// Price IDs come from your Stripe dashboard and live in .env.
// ----------------------------------------------------------------
const PLANS = {
  free: {
    name: 'Free Trial',
    priceId: null, // No Stripe price — free plan
    features: ['5 AI posts per month', '2 platforms', '1 user']
  },
  starter: {
    name: 'Starter',
    priceId: process.env.STRIPE_PRICE_STARTER,
    features: ['50 AI posts per month', '4 platforms', 'Comment monitoring']
  },
  professional: {
    name: 'Professional',
    priceId: process.env.STRIPE_PRICE_PROFESSIONAL,
    features: ['Unlimited AI posts', 'All 7 platforms', 'Lead capture DMs', 'Media library']
  },
  enterprise: {
    name: 'Enterprise',
    priceId: process.env.STRIPE_PRICE_ENTERPRISE,
    features: ['Everything in Pro', 'Priority support', 'Custom onboarding', 'SLA']
  }
};

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

  // Store the Stripe customer ID + initial free plan in our database
  const { error } = await supabaseAdmin
    .from('subscriptions')
    .insert({
      user_id: userId,
      stripe_customer_id: customer.id,
      plan: 'free',
      status: 'active'
    });

  if (error) throw new Error(`Failed to save subscription record: ${error.message}`);

  return customer;
}

// ----------------------------------------------------------------
// Create a Stripe Checkout session for upgrading to a paid plan.
// Returns a URL that the frontend redirects the user to.
// ----------------------------------------------------------------
async function createCheckoutSession(userId, planKey) {
  const plan = PLANS[planKey];
  if (!plan || !plan.priceId) {
    throw new Error(`Invalid plan: ${planKey}`);
  }

  // Look up the user's Stripe customer ID
  const { data: sub, error } = await supabaseAdmin
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .single();

  if (error || !sub?.stripe_customer_id) {
    throw new Error('No Stripe customer found for this user');
  }

  const session = await stripe.checkout.sessions.create({
    customer: sub.stripe_customer_id,
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: plan.priceId, quantity: 1 }],
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
      const plan = Object.keys(PLANS).find(k => PLANS[k].priceId === priceId) || 'free';

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
          .update({ plan: 'free', status: 'cancelled', stripe_subscription_id: null })
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
  PLANS,
  createStripeCustomer,
  createCheckoutSession,
  createPortalSession,
  constructWebhookEvent,
  handleWebhookEvent
};
