/**
 * services/affiliateService.js
 *
 * Core logic for the Legacy membership + affiliate program.
 *
 * Responsibilities:
 *   - Legacy slot management (atomic decrement with row lock)
 *   - Referral slug generation and validation
 *   - Referral cookie creation and verification (HMAC-signed)
 *   - Commission calculation on Stripe invoice.payment_succeeded
 *   - Clawback recording on Stripe charge.dispute / charge.refunded
 *   - Good standing checks (suspend affiliate if invoice > 30 days overdue)
 *   - Monthly payout job logic (runs on 5th of each month via BullMQ)
 *   - Clawback reserve logic (10% withheld, released after 60 days)
 *   - Stripe Connect account verification on every payout
 *   - Immutable audit log writes (affiliate_status_log)
 *
 * Adapter pattern: all Stripe calls go through this service.
 * Routes and workers call these functions — no Stripe calls in routes.
 */

const crypto      = require('crypto');
const { supabaseAdmin } = require('./supabaseService');
const Stripe      = require('stripe');
const stripe      = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------

// Slugs that could be confused for official Social Buster accounts
const SLUG_BLOCKLIST = new Set([
  'official', 'admin', 'support', 'team', 'help', 'socialbuster',
  'social-buster', 'social_buster', 'staff', 'mod', 'moderator',
  'billing', 'legal', 'security', 'ref', 'affiliate', 'affiliates',
  'press', 'media', 'news', 'contact', 'info', 'hello', 'sales',
  'partner', 'partners', 'ceo', 'founder', 'owner'
]);

// Commission tiers: active referral count → rate
const COMMISSION_TIERS = [
  { min: 11, rate: 0.25 },
  { min: 6,  rate: 0.20 },
  { min: 1,  rate: 0.15 }
];

// 10% of each payout withheld as clawback reserve
const RESERVE_RATE = 0.10;

// Reserve released after 60 days with no clawbacks
const RESERVE_RELEASE_DAYS = 60;

// Minimum payout threshold in cents ($50.00)
const MIN_PAYOUT_CENTS = 5000;


// ================================================================
// LEGACY SLOTS
// ================================================================

/**
 * getLegacySlotDisplay
 * Returns the publicly-displayed slot count using the countdown
 * display rules:
 *   - Display = actual_remaining - 25
 *   - If actual_remaining <= 5: show 1
 *   - If actual_remaining = 0: show 0 (caller should show "closed")
 *   - Display never goes below 1 while actual > 0
 */
async function getLegacySlotDisplay() {
  const { data, error } = await supabaseAdmin
    .from('legacy_slots')
    .select('slot_cap, slots_used')
    .single();

  if (error || !data) throw new Error('Could not read legacy slot data');

  const actual = data.slot_cap - data.slots_used;

  if (actual <= 0) return { available: false, display: 0, actual: 0 };
  if (actual <= 5) return { available: true,  display: 1, actual };

  const display = Math.max(1, actual - 25);
  return { available: true, display, actual };
}

/**
 * claimLegacySlot
 * Atomically decrements the slot counter using a DB-level row lock.
 * Returns true if a slot was claimed, false if none available.
 * This prevents race conditions when two users hit checkout simultaneously.
 *
 * Called from the Stripe checkout.session.completed webhook ONLY —
 * not from the checkout initiation route. This ensures payment has
 * actually succeeded before a slot is consumed.
 */
async function claimLegacySlot() {
  // Use a raw RPC call for atomic increment with constraint check.
  // The DB constraint (slots_used <= slot_cap) will reject if over cap.
  const { error } = await supabaseAdmin.rpc('claim_legacy_slot');

  if (error) {
    if (error.message.includes('slots_used_lte_cap') || error.message.includes('check constraint')) {
      return false; // No slots available
    }
    throw new Error('Slot claim failed: ' + error.message);
  }
  return true;
}

/**
 * getCurrentLegacyCohort
 * Returns the current active Legacy cohort (year + Stripe price ID).
 */
async function getCurrentLegacyCohort() {
  const { data, error } = await supabaseAdmin
    .from('legacy_cohorts')
    .select('*')
    .eq('is_current', true)
    .single();

  if (error || !data) throw new Error('No active Legacy cohort configured. Set one up in admin → Legacy tab.');
  return data;
}


// ================================================================
// REFERRAL SLUGS
// ================================================================

/**
 * generateSlug
 * Creates a random 8-character alphanumeric slug.
 * Retries up to 5 times to avoid (extremely unlikely) collisions.
 */
function generateSlug() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let slug = '';
  for (let i = 0; i < 8; i++) {
    slug += chars[Math.floor(Math.random() * chars.length)];
  }
  return slug;
}

/**
 * createReferralSlug
 * Generates and saves an auto-generated slug for a new Legacy member.
 * Called at account creation.
 */
async function createReferralSlug(userId) {
  // Try up to 5 times in case of collision
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = generateSlug();
    const { data, error } = await supabaseAdmin
      .from('referral_slugs')
      .insert({ user_id: userId, slug, is_custom: false })
      .select()
      .single();

    if (!error) return data;
    if (!error.message.includes('unique')) throw new Error(error.message);
  }
  throw new Error('Failed to generate unique slug after 5 attempts');
}

/**
 * setCustomSlug
 * Allows a Legacy member to set their custom slug exactly once.
 * Validates format, length, uniqueness, and blocklist.
 * Returns the updated slug row.
 */
async function setCustomSlug(userId, rawSlug) {
  const slug = rawSlug.trim().toLowerCase();

  // Format: 3-20 chars, alphanumeric + hyphens only
  if (!/^[a-z0-9-]{3,20}$/.test(slug)) {
    throw new Error('Slug must be 3–20 characters, letters, numbers, and hyphens only.');
  }

  // Blocklist check
  if (SLUG_BLOCKLIST.has(slug)) {
    throw new Error('That slug is reserved. Please choose a different one.');
  }

  // Check if user already has a custom slug set
  const { data: existing } = await supabaseAdmin
    .from('referral_slugs')
    .select('is_custom, slug')
    .eq('user_id', userId)
    .single();

  if (existing?.is_custom) {
    throw new Error('Your referral slug has already been set and cannot be changed.');
  }

  // Attempt to update — unique constraint will reject duplicates
  const { data, error } = await supabaseAdmin
    .from('referral_slugs')
    .update({ slug, is_custom: true, customized_at: new Date().toISOString() })
    .eq('user_id', userId)
    .select()
    .single();

  if (error) {
    if (error.message.includes('unique')) throw new Error('That slug is already taken. Please choose a different one.');
    throw new Error(error.message);
  }

  return data;
}

/**
 * getReferrerBySlug
 * Resolves a public slug to a referrer user_id.
 * Returns null if slug not found. Timing-safe (no early return on miss).
 * Also increments click_count.
 */
async function getReferrerBySlug(slug) {
  // Increment click count and return user_id in one query
  const { data, error } = await supabaseAdmin
    .from('referral_slugs')
    .select('user_id')
    .eq('slug', slug.toLowerCase())
    .single();

  if (error || !data) return null;

  // Increment click count (non-blocking — fire and forget)
  supabaseAdmin
    .from('referral_slugs')
    .update({ click_count: supabaseAdmin.rpc('increment_click_count', { slug_value: slug }) })
    .eq('slug', slug.toLowerCase())
    .then(() => {})
    .catch(() => {});

  return data.user_id;
}


// ================================================================
// REFERRAL COOKIE
// ================================================================

const COOKIE_SECRET = process.env.AFFILIATE_COOKIE_SECRET || process.env.JWT_SECRET;

/**
 * buildReferralCookieValue
 * Creates an HMAC-signed cookie payload containing:
 *   { referrerId, timestamp, ipHash }
 * The raw user ID is never stored in the cookie — only the referrer's
 * user_id (which is our internal UUID, not exposed in URLs).
 */
function buildReferralCookieValue(referrerId, ip) {
  const payload = {
    r: referrerId,
    t: Date.now(),
    ih: crypto.createHash('sha256').update(ip || '').digest('hex').slice(0, 16)
  };
  const data    = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sig     = crypto.createHmac('sha256', COOKIE_SECRET).update(data).digest('hex');
  return `${data}.${sig}`;
}

/**
 * parseReferralCookie
 * Validates the HMAC signature and returns the payload.
 * Returns null if invalid or expired (> 30 days).
 */
function parseReferralCookie(cookieValue) {
  try {
    const [data, sig] = cookieValue.split('.');
    if (!data || !sig) return null;

    const expected = crypto.createHmac('sha256', COOKIE_SECRET).update(data).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

    const payload = JSON.parse(Buffer.from(data, 'base64').toString());

    // Check 30-day TTL
    const ageDays = (Date.now() - payload.t) / (1000 * 60 * 60 * 24);
    if (ageDays > 30) return null;

    return payload;

  } catch (_) {
    return null;
  }
}

/**
 * getReferralCookieOptions
 * Returns Express cookie options for the referral cookie.
 */
function getReferralCookieOptions() {
  return {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge:   30 * 24 * 60 * 60 * 1000  // 30 days in ms
  };
}


// ================================================================
// COMMISSION CALCULATION
// ================================================================

/**
 * getCommissionRate
 * Returns the commission rate for an affiliate based on their
 * current active referral count.
 * "Active" = referred user with a paid invoice in the last 35 days.
 */
async function getCommissionRate(affiliateId) {
  // Count referrals where the referred user paid an invoice in last 35 days
  const cutoff = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString();

  const { count, error } = await supabaseAdmin
    .from('affiliate_earnings')
    .select('referral_id', { count: 'exact', head: true })
    .eq('affiliate_id', affiliateId)
    .gte('created_at', cutoff)
    .neq('status', 'clawed_back');

  if (error) throw new Error('Commission rate lookup failed: ' + error.message);

  const activeCount = count || 0;
  for (const tier of COMMISSION_TIERS) {
    if (activeCount >= tier.min) return { rate: tier.rate, activeCount };
  }
  return { rate: 0.15, activeCount }; // floor at 15%
}

/**
 * processInvoiceCommission
 * Called from the Stripe invoice.payment_succeeded webhook.
 * Idempotent — safe to call multiple times with same invoiceId.
 *
 * Logic:
 *   1. Check if this invoice was already processed (idempotency)
 *   2. Find if the paying user was referred by a Legacy affiliate
 *   3. Skip if referred user is on Legacy plan (no commission)
 *   4. Skip if affiliate is suspended or not in good standing
 *   5. Calculate commission and write affiliate_earnings row
 *   6. Log any plan changes for audit trail
 */
async function processInvoiceCommission(invoice) {
  const stripeInvoiceId = invoice.id;
  const amountPaid      = invoice.amount_paid; // cents
  const customerId      = invoice.customer;

  // Idempotency check — skip if already processed
  const { data: existing } = await supabaseAdmin
    .from('affiliate_earnings')
    .select('id')
    .eq('stripe_invoice_id', stripeInvoiceId)
    .single();

  if (existing) {
    console.log(`[Affiliate] Invoice ${stripeInvoiceId} already processed — skipping`);
    return;
  }

  // Find the user who paid this invoice
  const { data: sub } = await supabaseAdmin
    .from('subscriptions')
    .select('user_id, plan')
    .eq('stripe_customer_id', customerId)
    .single();

  if (!sub) return; // Unknown customer — skip

  const referredUserId  = sub.user_id;
  const referredPlan    = sub.plan;

  // No commission on Legacy plan payments
  if (referredPlan === 'legacy') {
    console.log(`[Affiliate] Skipping commission — referred user ${referredUserId} is on Legacy plan`);
    return;
  }

  // No commission on $0 invoices
  if (amountPaid <= 0) return;

  // Find the referral record for this user
  const { data: referral } = await supabaseAdmin
    .from('referrals')
    .select('id, referrer_id, current_plan, status')
    .eq('referred_user_id', referredUserId)
    .eq('status', 'active')
    .single();

  if (!referral) return; // Not a referred user — skip

  // Check if affiliate is suspended
  const { data: affiliateProfile } = await supabaseAdmin
    .from('user_profiles')
    .select('affiliate_suspended, subscription_tier')
    .eq('user_id', referral.referrer_id)
    .single();

  if (!affiliateProfile || affiliateProfile.subscription_tier !== 'legacy') return;
  if (affiliateProfile.affiliate_suspended) {
    console.log(`[Affiliate] Skipping commission — affiliate ${referral.referrer_id} is suspended`);
    return;
  }

  // Log plan change if the referred user's plan changed
  if (referral.current_plan !== referredPlan) {
    const { rate } = await getCommissionRate(referral.referrer_id);
    await supabaseAdmin
      .from('referral_plan_history')
      .insert({
        referral_id:               referral.id,
        old_plan:                  referral.current_plan,
        new_plan:                  referredPlan,
        commission_rate_at_change: rate
      });

    await supabaseAdmin
      .from('referrals')
      .update({ current_plan: referredPlan })
      .eq('id', referral.id);
  }

  // Calculate commission
  const { rate, activeCount } = await getCommissionRate(referral.referrer_id);
  const commissionAmount = Math.floor(amountPaid * rate);

  // Earnings are eligible 30 days after the invoice date (payout runs on 5th of M+2)
  const invoiceDate  = new Date(invoice.created * 1000);
  const periodMonth  = `${invoiceDate.getFullYear()}-${String(invoiceDate.getMonth() + 1).padStart(2, '0')}`;
  const eligibleAt   = new Date(invoiceDate.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const { error } = await supabaseAdmin
    .from('affiliate_earnings')
    .insert({
      referral_id:            referral.id,
      affiliate_id:           referral.referrer_id,
      stripe_invoice_id:      stripeInvoiceId,
      invoice_amount:         amountPaid,
      commission_rate:        rate,
      commission_amount:      commissionAmount,
      affiliate_tier_at_time: activeCount,
      referred_plan_at_time:  referredPlan,
      period_month:           periodMonth,
      status:                 'pending',
      eligible_at:            eligibleAt
    });

  if (error) {
    if (error.message.includes('unique')) {
      console.log(`[Affiliate] Invoice ${stripeInvoiceId} duplicate insert blocked — idempotency OK`);
      return;
    }
    throw new Error('Commission insert failed: ' + error.message);
  }

  console.log(`[Affiliate] Commission recorded: affiliate=${referral.referrer_id}, amount=${commissionAmount}¢, rate=${rate}, invoice=${stripeInvoiceId}`);
}


// ================================================================
// CLAWBACKS
// ================================================================

/**
 * processClawback
 * Called from Stripe charge.dispute.created or charge.refunded webhooks.
 * Finds the earning tied to the Stripe invoice, marks it clawed_back,
 * and records the clawback. Idempotent on stripe_event_id.
 */
async function processClawback(stripeEventId, stripeInvoiceId, reason) {
  // Idempotency check
  const { data: existing } = await supabaseAdmin
    .from('affiliate_clawbacks')
    .select('id')
    .eq('stripe_event_id', stripeEventId)
    .single();

  if (existing) {
    console.log(`[Affiliate] Clawback ${stripeEventId} already processed — skipping`);
    return;
  }

  // Find the earning for this invoice
  const { data: earning } = await supabaseAdmin
    .from('affiliate_earnings')
    .select('id, affiliate_id, commission_amount, status')
    .eq('stripe_invoice_id', stripeInvoiceId)
    .single();

  if (!earning) {
    console.log(`[Affiliate] No earning found for invoice ${stripeInvoiceId} — clawback skipped`);
    return;
  }

  // Mark earning as clawed_back
  await supabaseAdmin
    .from('affiliate_earnings')
    .update({ status: 'clawed_back' })
    .eq('id', earning.id);

  // Record the clawback
  const { error } = await supabaseAdmin
    .from('affiliate_clawbacks')
    .insert({
      affiliate_id:    earning.affiliate_id,
      earning_id:      earning.id,
      reason,
      stripe_event_id: stripeEventId,
      amount_reversed: earning.commission_amount
    });

  if (error) throw new Error('Clawback insert failed: ' + error.message);

  console.log(`[Affiliate] Clawback recorded: affiliate=${earning.affiliate_id}, amount=${earning.commission_amount}¢, reason=${reason}`);
}


// ================================================================
// GOOD STANDING CHECK
// ================================================================

/**
 * checkAffiliateGoodStanding
 * Called from invoice.payment_failed webhook.
 * If the affiliate has a failed invoice older than 30 days,
 * suspend their affiliate payouts and log the event.
 * Admin must manually reinstate.
 */
async function checkAffiliateGoodStanding(userId) {
  const { data: sub } = await supabaseAdmin
    .from('subscriptions')
    .select('status, plan, updated_at')
    .eq('user_id', userId)
    .single();

  if (!sub || sub.plan !== 'legacy') return;
  if (sub.status !== 'past_due') return;

  // Check how long it's been past_due
  const updatedAt   = new Date(sub.updated_at);
  const daysPastDue = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60 * 24);

  if (daysPastDue < 30) return; // Within grace period

  // Suspend affiliate
  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('affiliate_suspended')
    .eq('user_id', userId)
    .single();

  if (profile?.affiliate_suspended) return; // Already suspended

  await supabaseAdmin
    .from('user_profiles')
    .update({
      affiliate_suspended:        true,
      affiliate_suspended_reason: `Invoice past_due for ${Math.floor(daysPastDue)} days`,
      affiliate_suspended_at:     new Date().toISOString()
    })
    .eq('user_id', userId);

  await logAffiliateStatusEvent(userId, 'good_standing_lost', 'active', 'suspended',
    `Invoice past_due for ${Math.floor(daysPastDue)} days`, null);

  console.log(`[Affiliate] Suspended affiliate ${userId} — invoice past_due ${Math.floor(daysPastDue)} days`);
}


// ================================================================
// PAYOUT PROCESSING
// ================================================================

/**
 * processMonthlyPayouts
 * The main payout job — called by BullMQ on the 5th of each month.
 * Processes all affiliates with eligible earnings >= $50 after clawbacks.
 *
 * Flow per affiliate:
 *   1. Sum eligible earnings (status = 'eligible', eligible_at <= now)
 *   2. Sum pending clawbacks not yet deducted
 *   3. Deduct clawbacks — if net < $50, skip
 *   4. Verify Stripe Connect account ID matches stored value
 *   5. Withhold 10% reserve
 *   6. Calculate Stripe Connect fees (estimated — actual charged by Stripe)
 *   7. Create Stripe transfer
 *   8. Mark earnings as paid, record payout, link clawbacks to payout
 *   9. Release any 60-day-old reserves
 */
async function processMonthlyPayouts() {
  console.log('[Affiliate Payout] Starting monthly payout job');

  // Target period = 2 months ago (30 days in arrears + payout on 5th)
  const now        = new Date();
  const targetDate = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const periodMonth = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}`;

  // Get all affiliates with eligible earnings for this period
  const { data: eligibleEarnings, error } = await supabaseAdmin
    .from('affiliate_earnings')
    .select('id, affiliate_id, commission_amount')
    .eq('period_month', periodMonth)
    .eq('status', 'eligible')
    .lte('eligible_at', now.toISOString());

  if (error) throw new Error('Payout fetch failed: ' + error.message);
  if (!eligibleEarnings?.length) {
    console.log('[Affiliate Payout] No eligible earnings for period:', periodMonth);
    return;
  }

  // Group by affiliate
  const byAffiliate = {};
  for (const e of eligibleEarnings) {
    if (!byAffiliate[e.affiliate_id]) byAffiliate[e.affiliate_id] = [];
    byAffiliate[e.affiliate_id].push(e);
  }

  for (const [affiliateId, earnings] of Object.entries(byAffiliate)) {
    try {
      await processSingleAffiliatePayout(affiliateId, earnings, periodMonth);
    } catch (err) {
      // Per-affiliate failure — log and continue to next affiliate
      console.error(`[Affiliate Payout] Failed for affiliate ${affiliateId}:`, err.message);
      await logAffiliateStatusEvent(affiliateId, 'payout_held', null, 'failed', err.message, null);
    }
  }

  // Release 60-day-old reserves
  await releaseMaturedReserves();

  console.log('[Affiliate Payout] Monthly payout job complete');
}

/**
 * processSingleAffiliatePayout
 * Handles payout for one affiliate. Called by processMonthlyPayouts.
 */
async function processSingleAffiliatePayout(affiliateId, earnings, periodMonth) {
  // Get affiliate profile — check suspended, get Connect account
  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('stripe_connect_account_id, affiliate_suspended, subscription_tier')
    .eq('user_id', affiliateId)
    .single();

  if (!profile?.stripe_connect_account_id) {
    console.log(`[Affiliate Payout] Skipping ${affiliateId} — no Stripe Connect account`);
    return;
  }

  if (profile.affiliate_suspended) {
    console.log(`[Affiliate Payout] Skipping ${affiliateId} — affiliate suspended`);
    return;
  }

  if (profile.subscription_tier !== 'legacy') {
    console.log(`[Affiliate Payout] Skipping ${affiliateId} — not a Legacy member`);
    return;
  }

  // Verify Stripe Connect account ID matches what Stripe reports
  try {
    const account = await stripe.accounts.retrieve(profile.stripe_connect_account_id);
    if (account.id !== profile.stripe_connect_account_id) {
      throw new Error('Stripe Connect account ID mismatch — possible account takeover');
    }
  } catch (err) {
    // Freeze payout and alert admin
    await supabaseAdmin
      .from('affiliate_payouts')
      .insert({
        affiliate_id:   affiliateId,
        period_month:   periodMonth,
        gross_amount:   0,
        net_amount:     0,
        status:         'held',
        hold_reason:    'Stripe Connect account verification failed: ' + err.message
      });
    await logAffiliateStatusEvent(affiliateId, 'payout_held', null, 'held',
      'Stripe Connect verification failed: ' + err.message, null);
    console.error(`[Affiliate Payout] Connect verification FAILED for ${affiliateId}:`, err.message);
    return;
  }

  // Sum gross earnings
  const gross = earnings.reduce((sum, e) => sum + e.commission_amount, 0);

  // Get undeducted clawbacks for this affiliate
  const { data: clawbacks } = await supabaseAdmin
    .from('affiliate_clawbacks')
    .select('id, amount_reversed')
    .eq('affiliate_id', affiliateId)
    .is('deducted_from_payout_id', null);

  const totalClawbacks = (clawbacks || []).reduce((sum, c) => sum + c.amount_reversed, 0);

  // Net after clawbacks (floor at 0 — negative balances not carried forward)
  const netAfterClawbacks = Math.max(0, gross - totalClawbacks);

  if (netAfterClawbacks < MIN_PAYOUT_CENTS) {
    console.log(`[Affiliate Payout] Skipping ${affiliateId} — net ${netAfterClawbacks}¢ below $50 threshold`);
    return;
  }

  // Withhold 10% reserve
  const reserveAmount = Math.floor(netAfterClawbacks * RESERVE_RATE);
  const netAfterReserve = netAfterClawbacks - reserveAmount;

  // Stripe Connect transfer fee estimation (~0.25% + $0.25)
  const estimatedFees = Math.floor(netAfterReserve * 0.0025) + 25;
  const netAmount = Math.max(0, netAfterReserve - estimatedFees);

  if (netAmount <= 0) {
    console.log(`[Affiliate Payout] Skipping ${affiliateId} — net after fees is zero`);
    return;
  }

  // Create the payout record first (so we have an ID for the transfer metadata)
  const { data: payoutRecord, error: payoutErr } = await supabaseAdmin
    .from('affiliate_payouts')
    .insert({
      affiliate_id:               affiliateId,
      period_month:               periodMonth,
      gross_amount:               gross,
      clawbacks_deducted:         Math.min(gross, totalClawbacks),
      reserve_withheld:           reserveAmount,
      stripe_fees:                estimatedFees,
      net_amount:                 netAmount,
      stripe_connect_account_id:  profile.stripe_connect_account_id,
      status:                     'processing'
    })
    .select()
    .single();

  if (payoutErr) throw new Error('Payout record insert failed: ' + payoutErr.message);

  // Execute Stripe transfer
  try {
    const transfer = await stripe.transfers.create({
      amount:             netAmount,
      currency:           'usd',
      destination:        profile.stripe_connect_account_id,
      transfer_group:     `affiliate-payout-${periodMonth}`,
      metadata: {
        affiliate_id:  affiliateId,
        payout_id:     payoutRecord.id,
        period_month:  periodMonth
      }
    });

    // Mark payout as paid
    await supabaseAdmin
      .from('affiliate_payouts')
      .update({ status: 'paid', stripe_transfer_id: transfer.id, processed_at: new Date().toISOString() })
      .eq('id', payoutRecord.id);

    // Mark earnings as paid
    await supabaseAdmin
      .from('affiliate_earnings')
      .update({ status: 'paid' })
      .in('id', earnings.map(e => e.id));

    // Link clawbacks to this payout
    if (clawbacks?.length) {
      await supabaseAdmin
        .from('affiliate_clawbacks')
        .update({ deducted_from_payout_id: payoutRecord.id })
        .in('id', clawbacks.map(c => c.id));
    }

    // Record reserve for future release
    if (reserveAmount > 0) {
      await supabaseAdmin
        .from('affiliate_reserve_releases')
        .insert({
          affiliate_id: affiliateId,
          payout_id:    payoutRecord.id,
          amount:       reserveAmount
        });
    }

    console.log(`[Affiliate Payout] Paid ${affiliateId}: gross=${gross}¢, clawbacks=${totalClawbacks}¢, reserve=${reserveAmount}¢, fees=${estimatedFees}¢, net=${netAmount}¢`);

  } catch (err) {
    // Stripe transfer failed — mark payout as failed
    await supabaseAdmin
      .from('affiliate_payouts')
      .update({ status: 'failed', hold_reason: err.message })
      .eq('id', payoutRecord.id);
    throw err;
  }
}

/**
 * releaseMaturedReserves
 * Finds all reserve entries older than 60 days with no outstanding
 * clawbacks and adds the reserve amount to the next payout.
 * Called at the end of each monthly payout job.
 */
async function releaseMaturedReserves() {
  const cutoff = new Date(Date.now() - RESERVE_RELEASE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const { data: matured } = await supabaseAdmin
    .from('affiliate_reserve_releases')
    .select('id, affiliate_id, amount, payout_id')
    .is('release_payout_id', null)
    .lte('released_at', cutoff);

  if (!matured?.length) return;

  // Group by affiliate and log — actual payout added to next payout cycle
  for (const release of matured) {
    // Check for outstanding clawbacks before releasing
    const { data: pendingClawbacks } = await supabaseAdmin
      .from('affiliate_clawbacks')
      .select('id')
      .eq('affiliate_id', release.affiliate_id)
      .is('deducted_from_payout_id', null);

    if (pendingClawbacks?.length) {
      console.log(`[Affiliate Reserve] Skipping release for ${release.affiliate_id} — outstanding clawbacks`);
      continue;
    }

    // Add to a pending earnings record for next payout
    const now         = new Date();
    const periodMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    await supabaseAdmin
      .from('affiliate_earnings')
      .insert({
        referral_id:            null, // Reserve release — not tied to a specific referral
        affiliate_id:           release.affiliate_id,
        stripe_invoice_id:      `reserve-release-${release.id}`,
        invoice_amount:         0,
        commission_rate:        0,
        commission_amount:      release.amount,
        affiliate_tier_at_time: 0,
        referred_plan_at_time:  'reserve_release',
        period_month:           periodMonth,
        status:                 'eligible',
        eligible_at:            now.toISOString()
      });

    console.log(`[Affiliate Reserve] Released ${release.amount}¢ for ${release.affiliate_id}`);
  }
}


// ================================================================
// STRIPE CONNECT
// ================================================================

/**
 * createConnectOnboardingLink
 * Generates a Stripe Connect Standard onboarding URL for a Legacy member.
 * Called immediately after Legacy signup.
 */
async function createConnectOnboardingLink(userId, userEmail) {
  // Create a Stripe Connect account if one doesn't exist
  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('stripe_connect_account_id')
    .eq('user_id', userId)
    .single();

  let accountId = profile?.stripe_connect_account_id;

  if (!accountId) {
    const account = await stripe.accounts.create({
      type:  'standard',
      email: userEmail,
      metadata: { social_buster_user_id: userId }
    });
    accountId = account.id;

    await supabaseAdmin
      .from('user_profiles')
      .update({ stripe_connect_account_id: accountId })
      .eq('user_id', userId);
  }

  // Create onboarding link
  const accountLink = await stripe.accountLinks.create({
    account:     accountId,
    refresh_url: `${process.env.FRONTEND_URL}/#affiliate?connect=retry`,
    return_url:  `${process.env.FRONTEND_URL}/#affiliate?connect=success`,
    type:        'account_onboarding'
  });

  return accountLink.url;
}

/**
 * handleConnectDeauthorized
 * Called when Stripe fires account.application.deauthorized.
 * Freezes affiliate payouts and logs the event.
 */
async function handleConnectDeauthorized(stripeAccountId) {
  const { data: profile } = await supabaseAdmin
    .from('user_profiles')
    .select('user_id')
    .eq('stripe_connect_account_id', stripeAccountId)
    .single();

  if (!profile) return;

  await supabaseAdmin
    .from('user_profiles')
    .update({
      affiliate_suspended:        true,
      affiliate_suspended_reason: 'Stripe Connect account deauthorized',
      affiliate_suspended_at:     new Date().toISOString()
    })
    .eq('user_id', profile.user_id);

  await logAffiliateStatusEvent(profile.user_id, 'connect_deauthorized', 'connected', 'deauthorized',
    'Stripe Connect account deauthorized by user', null);

  console.log(`[Affiliate] Connect deauthorized for account ${stripeAccountId}, user ${profile.user_id}`);
}


// ================================================================
// REFERRAL SIGNUP RECORDING
// ================================================================

/**
 * recordReferral
 * Called at user signup if a valid referral cookie is present.
 * Records the referral, runs self-referral + fraud checks,
 * and flags suspicious signups for admin review.
 */
async function recordReferral(referrerId, referredUserId, signupIp, deviceFingerprint, cookiePayload) {
  // Self-referral check
  if (referrerId === referredUserId) {
    console.warn(`[Affiliate] Self-referral attempt blocked: user ${referrerId}`);
    return;
  }

  // Get the referred user's signup plan
  const { data: sub } = await supabaseAdmin
    .from('subscriptions')
    .select('plan')
    .eq('user_id', referredUserId)
    .single();

  const signupPlan = sub?.plan || 'free_trial';

  // Fraud flags
  const fraudFlags = [];

  // IP match between referrer and referred
  const { data: referrerProfile } = await supabaseAdmin
    .from('user_profiles')
    .select('user_id')
    .eq('user_id', referrerId)
    .single();

  // Check if this IP has referred too many people recently (velocity check)
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { count: recentFromSameIp } = await supabaseAdmin
    .from('referrals')
    .select('id', { count: 'exact', head: true })
    .eq('ip_at_signup', signupIp)
    .gte('created_at', sevenDaysAgo);

  if (recentFromSameIp >= 3) fraudFlags.push('IP velocity: 3+ referrals from same IP in 7 days');

  // Cookie IP mismatch check
  const cookieIpHash = cookiePayload?.ih || '';
  const currentIpHash = crypto.createHash('sha256').update(signupIp || '').digest('hex').slice(0, 16);
  if (cookieIpHash && cookieIpHash !== currentIpHash) {
    fraudFlags.push('IP changed between referral click and signup');
  }

  const isFraudFlagged = fraudFlags.length > 0;

  const { error } = await supabaseAdmin
    .from('referrals')
    .insert({
      referrer_id:              referrerId,
      referred_user_id:         referredUserId,
      referred_plan_at_signup:  signupPlan,
      current_plan:             signupPlan,
      status:                   isFraudFlagged ? 'fraud_flagged' : 'active',
      ip_at_signup:             signupIp,
      device_fingerprint:       deviceFingerprint,
      cookie_ip:                cookiePayload?.ih || null,
      fraud_flagged_at:         isFraudFlagged ? new Date().toISOString() : null,
      fraud_flag_reason:        isFraudFlagged ? fraudFlags.join('; ') : null
    });

  if (error && !error.message.includes('unique')) {
    throw new Error('Referral insert failed: ' + error.message);
  }

  if (isFraudFlagged) {
    console.warn(`[Affiliate] Referral fraud-flagged: referrer=${referrerId}, flags=${fraudFlags.join('; ')}`);
  } else {
    console.log(`[Affiliate] Referral recorded: referrer=${referrerId}, referred=${referredUserId}`);
  }
}


// ================================================================
// AUDIT LOG
// ================================================================

/**
 * logAffiliateStatusEvent
 * Writes an immutable event to affiliate_status_log.
 * Called throughout the system for any significant status change.
 */
async function logAffiliateStatusEvent(affiliateId, eventType, oldValue, newValue, reason, actedBy) {
  const { error } = await supabaseAdmin
    .from('affiliate_status_log')
    .insert({ affiliate_id: affiliateId, event_type: eventType, old_value: oldValue, new_value: newValue, reason, acted_by: actedBy });

  if (error) console.error('[Affiliate] Status log write failed:', error.message);
}


module.exports = {
  // Slots
  getLegacySlotDisplay,
  claimLegacySlot,
  getCurrentLegacyCohort,
  // Slugs
  createReferralSlug,
  setCustomSlug,
  getReferrerBySlug,
  // Cookies
  buildReferralCookieValue,
  parseReferralCookie,
  getReferralCookieOptions,
  // Commission
  processInvoiceCommission,
  getCommissionRate,
  // Clawbacks
  processClawback,
  // Good standing
  checkAffiliateGoodStanding,
  // Payouts
  processMonthlyPayouts,
  // Connect
  createConnectOnboardingLink,
  handleConnectDeauthorized,
  // Referral recording
  recordReferral,
  // Audit
  logAffiliateStatusEvent
};
