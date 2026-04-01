# Affiliate Program — Master Reference Document

**Status:** Planning complete — ready to build  
**Last updated:** 2026-04-01  
**Related:** [[DECISIONS]], [[FEATURES]], [[CHANGELOG]], [[ISSUES]]

---

## Overview

Social Buster's affiliate program is exclusively available to Legacy plan members. Legacy is a limited-slot, lifetime-priced membership tier with cohort-year pricing. Legacy members receive a unique referral link and earn recurring monthly commissions on the paid subscriptions of users they refer. The program is designed to drive viral growth while maintaining strict fraud controls and a clean audit trail.

---

## Part 1 — Legacy Membership

### What It Is
- A special membership tier with pricing locked at the rate in effect during the user's signup cohort year
- 2026 Legacy price example: $59/mo. 2027 might be $69/mo. Existing members never see a price change.
- Total slots are admin-controlled. Once the cap is hit, Legacy signup is closed.
- Only Legacy members can participate in the affiliate program.

### Signup Flow
1. User visits the pricing/billing page
2. Legacy section is visible with a live countdown of remaining spots (see countdown logic below)
3. User clicks "Join Legacy" → backend validates slot availability (atomic DB lock)
4. Backend builds Stripe Checkout session server-side using the cohort-year price ID — price ID never touches the frontend
5. User completes Stripe payment
6. On `checkout.session.completed` webhook → create user, set `subscription_tier = 'legacy'`, lock cohort price, decrement slot counter atomically
7. User is immediately redirected to Stripe Connect Standard onboarding
8. On Connect complete OR skip → dashboard loads with persistent "Complete your payout setup" banner if not connected

### Slot Countdown Logic
- Actual remaining = `legacy_slot_cap - legacy_slots_used`
- Displayed remaining = `actual_remaining - 25`
- If displayed remaining ≤ 0 but actual > 5: show `"1 Remaining!"` — never show 0 or negative
- If actual remaining ≤ 5: show `"1 Remaining!"` regardless
- If actual remaining = 0: show "Legacy membership is now closed"
- Countdown updates in real time — frontend polls `GET /legacy/slots` every 30 seconds on the pricing page

### Cohort Year Pricing
- Each cohort year has its own Stripe Price object (e.g. `price_legacy_2026`)
- Price IDs stored in DB table `legacy_cohorts` keyed by year
- When admin changes the Legacy price for a new year, a new Stripe Price is created and stored — existing subscribers are NEVER migrated
- `POST /admin/legacy/cohorts` creates a new cohort year with a new Stripe Price ID
- All new Legacy signups use the current year's price ID

### Race Condition Protection
- Slot counter uses `SELECT FOR UPDATE` row lock before decrement
- If slot count hits 0 between checkout initiation and webhook confirmation → auto-refund via Stripe, send "slots just filled" email
- DB constraint: `legacy_slots_used` cannot exceed `legacy_slot_cap`

---

## Part 2 — Referral Link & Tracking

### Referral Slug
- Generated automatically at Legacy account creation: random 8-character alphanumeric token
- Legacy member can set a custom slug **once** from their affiliate dashboard — permanent after save, no edits ever, no admin override
- UI shows clear warning before save: *"Your referral link cannot be changed after this point."*
- Slug rules: 3–20 characters, alphanumeric + hyphens only, unique, validated against blocklist
- Blocklist includes: `official`, `admin`, `support`, `team`, `help`, `socialbuster`, `social-buster`, `staff`, `mod`, `moderator`, `billing`, `legal`, `security`, `ref`, `affiliate` and all similar trust/brand words
- Public URL: `social-buster.com/ref/{slug}`
- Slug → user_id mapping is server-side only — never exposed in frontend or API responses

### Cookie Tracking
- When a visitor clicks a referral link, backend sets an **HttpOnly, Secure, SameSite=Strict** cookie
- Cookie payload: HMAC-signed `{ slug_hash, timestamp, ip_fingerprint }` — never raw user ID
- Cookie TTL: 30 days
- Referrer URL logged at cookie-set time — flagged if not direct or `social-buster.com`
- Cookie is validated on signup: signature verified, IP fingerprint compared (flag if changed, do not block)
- If visitor already has a referral cookie, it is not overwritten (first-click attribution)

### Anti-Bot Protection
- `/ref/{slug}` rate-limited: 10 requests/min per IP
- Cloudflare bot score check on `/ref/` endpoint
- Slug lookup returns identical response time and body whether slug exists or not (no timing oracle)
- Cookie only set if real browser interaction detected (JS must execute to complete handshake)

---

## Part 3 — Commission Structure

### Tiers (by active referred subscribers at time of invoice)
| Active Referrals | Commission Rate |
|---|---|
| 1–5 | 15% |
| 6–10 | 20% |
| 11+ | 25% |

### What Counts as "Active"
- A referred user with at least one paid invoice in the last 35 days
- Free trial users do NOT count toward tier calculation
- Tier is calculated fresh at the moment each commission is computed (invoice time, not month start)

### What Earns Commission
- Any `invoice.payment_succeeded` from a referred user where the referred user's current plan is **NOT Legacy**
- If a referred user upgrades (from Legacy or any plan), commission is earned on the new plan price starting from the first invoice at that price
- Commission = (invoice amount) × (affiliate's current tier rate at invoice time)
- No commission on: Legacy plan payments, free trial conversions with $0 invoice, refunded invoices

### What Does NOT Earn Commission
- Referred user is on Legacy plan at time of invoice
- Self-referrals (same user ID, same IP, same device fingerprint — auto-blocked)
- Referred user cancels and resubscribes after 12 months (treated as new user, referral link expired)

### Idempotency
- Every commission record is keyed on the Stripe event ID
- If the same Stripe event ID is processed twice, the second is silently dropped — no double-crediting

---

## Part 4 — Payouts

### Schedule
- Earnings from calendar month M are eligible for payout on the 5th of month M+2 (30 days in arrears + 5-day buffer for chargebacks)
- Example: April earnings → eligible June 5th
- Payout job runs automatically on the 5th of each month

### Threshold
- Minimum payout: $50.00 after clawback deductions
- Balances below $50 carry forward to next month

### Clawback Reserve
- 10% of each payout is withheld into a rolling 60-day reserve per affiliate
- Reserve is released automatically after 60 days with no outstanding clawbacks
- If account is cancelled with reserve balance outstanding, reserve is forfeited

### Clawback Rules
- If a referred user's invoice is charged back or refunded: corresponding commission is reversed
- Clawback is deducted from current pending earnings before payout is processed
- Negative balance is NOT carried forward — if clawback exceeds pending earnings, excess is absorbed (not billed to affiliate)
- If a clawback investigation is pending at payout time, payout is held until resolved
- All clawbacks logged immutably in `affiliate_clawbacks` table
- Dashboard shows clawback history but does NOT send email notifications

### Stripe Connect (Standard)
- Standard Stripe Connect — gives affiliates full Stripe dashboard
- Prompted immediately after Legacy signup
- If skipped: dashboard shows persistent "Complete your payout setup" banner
- Cannot receive payouts until Stripe Connect is active
- On every payout: backend verifies stored Connect account ID matches Stripe's record — if mismatch, freeze payout, flag for admin review
- Listen to `account.application.deauthorized` webhook → immediately flag affiliate payout status as "action required"
- Stripe Connect processing fees deducted from payout, shown to user as gross/fees/net breakdown
- User is solely responsible for Stripe account security (covered in Terms)

### Good Standing
- Defined as: no failed or unpaid invoices older than 30 days AND account not suspended
- If out of good standing: affiliate earnings and payouts suspended automatically
- Reinstatement is at sole admin discretion — not automatic
- Good standing status changes logged with date, reason, and admin who acted

---

## Part 5 — Fraud & Security Controls

| Risk | Mitigation |
|---|---|
| Cookie hijacking | HMAC-signed cookie + IP fingerprint validation at signup |
| Stripe Connect account takeover | Account ID verified on every payout; freeze + admin alert on mismatch; covered in Terms |
| Self-farming (coordinated fake signups) | Device fingerprint + IP dedup; 60-day cancellation flag; velocity check (3+ referrals same IP in 7 days → auto-flag) |
| Slug enumeration | Rate limit 10/min; timing-safe responses; bot challenge |
| Referral cookie stuffing | SameSite=Strict; referrer URL logged; JS handshake required |
| Legacy slot race condition | SELECT FOR UPDATE atomic decrement; DB constraint; auto-refund overflow |
| Client-side price tampering | Price ID built server-side only, never in frontend payload |
| Slug squatting | Blocklist validated at creation time |
| Commission tier gaming | Tier calculated at invoice time; active = paid invoice last 35 days |
| Affiliate dashboard data leakage | No names/emails shown; obscured IDs only; full detail admin-only |
| Stripe webhook replay | Idempotency key per Stripe event ID |
| Chargeback/payout timing collision | Payout runs on 5th, not 1st — 35-day window |
| Stripe Connect deauthorization | Listen to deauthorized webhook; freeze + banner |

---

## Part 6 — Database Tables

### `legacy_cohorts`
| column | type | purpose |
|---|---|---|
| `id` | uuid | primary key |
| `cohort_year` | int | e.g. 2026 |
| `price_monthly` | int | cents, e.g. 5900 |
| `stripe_price_id` | text | Stripe Price object ID for this cohort |
| `is_current` | boolean | only one true at a time |
| `created_at` | timestamptz | |

### `legacy_slots`
| column | type | purpose |
|---|---|---|
| `id` | uuid | primary key (single row) |
| `slot_cap` | int | admin-set total slot limit |
| `slots_used` | int | atomic counter, DB constraint ≤ slot_cap |
| `updated_at` | timestamptz | |

### `referral_slugs`
| column | type | purpose |
|---|---|---|
| `id` | uuid | primary key |
| `user_id` | uuid | FK → user_profiles |
| `slug` | text | unique, immutable after first custom set |
| `is_custom` | boolean | false = auto-generated, true = user-set |
| `click_count` | int | total link clicks |
| `created_at` | timestamptz | |
| `customized_at` | timestamptz | null until user sets custom slug |

### `referrals`
| column | type | purpose |
|---|---|---|
| `id` | uuid | primary key |
| `referrer_id` | uuid | FK → user_profiles (the affiliate) |
| `referred_user_id` | uuid | FK → user_profiles (the signup) |
| `referred_plan_at_signup` | text | plan tier when they signed up |
| `current_plan` | text | updated on every plan change |
| `status` | text | active, cancelled, fraud_flagged |
| `ip_at_signup` | text | for fraud review |
| `device_fingerprint` | text | for fraud review |
| `cookie_ip` | text | IP when referral cookie was set |
| `created_at` | timestamptz | |
| `cancelled_at` | timestamptz | |
| `fraud_flagged_at` | timestamptz | |
| `fraud_flag_reason` | text | |

### `referral_plan_history`
| column | type | purpose |
|---|---|---|
| `id` | uuid | primary key |
| `referral_id` | uuid | FK → referrals |
| `old_plan` | text | plan before change |
| `new_plan` | text | plan after change |
| `changed_at` | timestamptz | |
| `commission_rate_at_change` | numeric | affiliate's tier rate at that moment |

### `affiliate_earnings`
| column | type | purpose |
|---|---|---|
| `id` | uuid | primary key |
| `referral_id` | uuid | FK → referrals |
| `affiliate_id` | uuid | FK → user_profiles |
| `stripe_invoice_id` | text | idempotency key — unique |
| `invoice_amount` | int | cents — what referred user paid |
| `commission_rate` | numeric | rate applied (0.15 / 0.20 / 0.25) |
| `commission_amount` | int | cents earned |
| `affiliate_tier_at_time` | int | number of active referrals at invoice time |
| `referred_plan_at_time` | text | referred user's plan at invoice time |
| `period_month` | text | YYYY-MM — which month this accrues to |
| `status` | text | pending, eligible, paid, clawed_back |
| `eligible_at` | timestamptz | when 30-day window opens |
| `created_at` | timestamptz | |

### `affiliate_clawbacks`
| column | type | purpose |
|---|---|---|
| `id` | uuid | primary key |
| `affiliate_id` | uuid | FK → user_profiles |
| `earning_id` | uuid | FK → affiliate_earnings |
| `reason` | text | chargeback, refund, fraud |
| `stripe_event_id` | text | source Stripe event |
| `amount_reversed` | int | cents |
| `deducted_from_payout_id` | uuid | FK → affiliate_payouts (null until applied) |
| `created_at` | timestamptz | |

### `affiliate_payouts`
| column | type | purpose |
|---|---|---|
| `id` | uuid | primary key |
| `affiliate_id` | uuid | FK → user_profiles |
| `period_month` | text | YYYY-MM earnings this covers |
| `gross_amount` | int | cents before fees and clawbacks |
| `clawbacks_deducted` | int | cents |
| `reserve_withheld` | int | 10% reserve cents |
| `stripe_fees` | int | cents |
| `net_amount` | int | cents actually paid |
| `stripe_transfer_id` | text | Stripe payout reference |
| `stripe_connect_account_id` | text | verified account ID at payout time |
| `status` | text | pending, processing, paid, held, failed |
| `hold_reason` | text | null unless held |
| `processed_at` | timestamptz | |
| `created_at` | timestamptz | |

### `affiliate_reserve_releases`
| column | type | purpose |
|---|---|---|
| `id` | uuid | primary key |
| `affiliate_id` | uuid | FK → user_profiles |
| `payout_id` | uuid | FK → affiliate_payouts (original payout) |
| `amount` | int | cents released |
| `release_payout_id` | uuid | FK → affiliate_payouts (payout it was added to) |
| `released_at` | timestamptz | |

### `affiliate_status_log`
| column | type | purpose |
|---|---|---|
| `id` | uuid | primary key |
| `affiliate_id` | uuid | FK → user_profiles |
| `event_type` | text | good_standing_lost, reinstated, suspended, connect_deauthorized, fraud_flagged, tier_changed |
| `old_value` | text | previous state |
| `new_value` | text | new state |
| `reason` | text | |
| `acted_by` | uuid | admin user_id or null for system |
| `created_at` | timestamptz | |

---

## Part 7 — Backend Routes

### Public (no auth)
| Method | Route | Purpose |
|---|---|---|
| GET | `/legacy/slots` | Returns displayed slot count (actual - 25, floored at rules) |
| GET | `/ref/:slug` | Sets referral cookie, redirects to homepage |

### Authenticated (user)
| Method | Route | Purpose |
|---|---|---|
| GET | `/affiliate/dashboard` | Earnings summary, referrals, payout history |
| GET | `/affiliate/referrals` | Full referrals table with plan history |
| GET | `/affiliate/earnings` | Earnings breakdown by month |
| GET | `/affiliate/payouts` | Payout history with gross/fees/net |
| GET | `/affiliate/clawbacks` | Clawback history |
| POST | `/affiliate/slug` | Set custom slug (one-time only) |
| GET | `/affiliate/connect-status` | Stripe Connect account status |
| POST | `/affiliate/connect` | Initiate Stripe Connect onboarding flow |

### Admin
| Method | Route | Purpose |
|---|---|---|
| GET | `/admin/legacy/slots` | Get slot cap and usage |
| PUT | `/admin/legacy/slots` | Set slot cap |
| GET | `/admin/legacy/cohorts` | List all cohort years and prices |
| POST | `/admin/legacy/cohorts` | Create new cohort year + Stripe Price |
| GET | `/admin/affiliates` | All affiliates + status + earnings summary |
| GET | `/admin/affiliates/:id` | Full affiliate audit log |
| PUT | `/admin/affiliates/:id/reinstate` | Reinstate suspended affiliate |
| PUT | `/admin/affiliates/:id/suspend` | Suspend affiliate |
| GET | `/admin/affiliates/:id/referrals` | Full referred user list with plan history |
| GET | `/admin/payouts/queue` | Pending payout queue |
| POST | `/admin/payouts/process` | Manually trigger payout job |
| GET | `/admin/clawbacks` | All clawbacks across all affiliates |
| PUT | `/admin/clawbacks/:id/resolve` | Mark clawback investigation resolved |
| GET | `/admin/fraud-flags` | All fraud-flagged referrals |
| PUT | `/admin/fraud-flags/:id` | Approve or reject flagged referral |

### Stripe Webhooks (additions to existing webhook handler)
| Event | Action |
|---|---|
| `checkout.session.completed` | Create Legacy user, lock cohort price, decrement slot counter atomically |
| `invoice.payment_succeeded` | Calculate and record affiliate commission if referred user exists |
| `invoice.payment_failed` | Check good standing — suspend affiliate if invoice > 30 days overdue |
| `charge.dispute.created` | Trigger clawback on corresponding earning |
| `charge.refunded` | Trigger clawback on corresponding earning |
| `account.application.deauthorized` | Freeze affiliate payouts, set action-required banner |

---

## Part 8 — Frontend

### Pricing / Billing Page (existing page — new Legacy section)
- Legacy section card with: cohort price, lifetime pricing promise, feature list, slot countdown
- Countdown polls `/legacy/slots` every 30 seconds
- "Join Legacy" button → POST to `/billing/legacy/checkout` → redirect to Stripe Checkout
- On return from Stripe success → redirect to Stripe Connect onboarding

### Affiliate Dashboard Tab (Legacy members only — hidden from all other tiers)
- Referral link display + copy button
- Slug setup form (first time) with permanent warning, or read-only display if already set
- KPI cards: this month earnings, all-time earnings, active referrals, current commission tier
- Referrals table: obscured ID, plan tier, monthly commission, status, date referred
- Earnings table: month, gross, clawbacks, reserve withheld, net eligible
- Payout history: date, gross, fees, net, status, Stripe transfer ID
- Clawback history: date, amount, reason, status
- Stripe Connect status widget: connected/not connected, "Connect Stripe" button if not set up
- Reserve balance: amount held, when it releases

### Admin Panel — New Additions
- **Legacy tab:** slot cap editor, cohort year manager, usage stats
- **Affiliates tab:** all affiliates table with earnings/status, click through to full audit log per affiliate
- **Affiliate audit log:** every event immutably logged — referral created, plan changes, invoice commissions, tier changes, clawbacks, payouts, status changes, Connect events. Filter by type, date, affiliate.
- **Payout queue tab:** list of pending payouts, manual trigger button, hold/release controls
- **Fraud flags tab:** flagged referrals with approve/reject, flag reason, IP/device data

---

## Part 9 — Terms of Service Additions

All of the following must be added to `privacy.html` / terms page before launch:

### Legacy Membership
Legacy membership is available on a limited basis at the discretion of Social Buster. Membership slots are capped and may be closed at any time without notice. Legacy members are charged a fixed monthly rate determined by their signup cohort year. This rate is guaranteed for the lifetime of the membership provided the account remains in good standing. Social Buster reserves the right to adjust Legacy pricing for new signups in subsequent cohort years without affecting existing Legacy members.

### Affiliate Program Eligibility
The Social Buster Affiliate Program is available exclusively to Legacy members. To remain eligible, your account must be in good standing, defined as: (1) no failed or unpaid invoices older than 30 days, and (2) account not suspended or under review. If your account falls out of good standing, affiliate earnings and payouts are suspended. Reinstatement of affiliate eligibility is at the sole discretion of the Social Buster administrator and is not guaranteed.

### Referral Commissions
Eligible affiliates earn a recurring monthly commission on the active paid subscriptions of users they refer, calculated as a percentage of the referred user's invoice amount at the time of payment:
- 1–5 active referred subscribers: 15%
- 6–10 active referred subscribers: 20%
- 11 or more active referred subscribers: 25%

Commissions are calculated on Starter, Professional, and Enterprise plan subscriptions only. No commission is earned on Legacy plan subscriptions, including Legacy-to-Legacy referrals. If a referred user upgrades from any plan (including Legacy) to a higher-tier paid plan, commissions are earned on the new plan price beginning with the first invoice at that price.

### Payouts
Affiliate earnings are paid monthly, 30 days in arrears. Earnings accrued in a given calendar month are eligible for payout on the 5th of the second following month, provided your earned balance meets or exceeds $50.00 after any clawback deductions. Balances below $50.00 carry forward to the following month. Payouts are processed via Stripe Connect. Stripe Connect processing fees are deducted from your payout and are your responsibility.

### Clawback Reserve
Social Buster withholds 10% of each payout as a rolling 60-day clawback reserve. Reserve funds are released automatically after 60 days with no outstanding clawbacks. If your account is cancelled, all reserve balances are forfeited.

### Clawbacks
If a referred user's payment is charged back, refunded, or reversed for any reason, the corresponding commission is reversed before your next payout is processed. Clawback amounts are deducted from current pending earnings only — negative balances are not carried forward. Social Buster reserves the right to withhold a scheduled payout if a clawback investigation is pending.

### Account Cancellation
If your Legacy membership is cancelled or terminated for any reason, all unpaid affiliate earnings and any clawback reserve balance are forfeited. No partial payouts will be issued upon cancellation.

### Payout Account Security
You are solely responsible for the security of your connected Stripe account. Social Buster is not liable for any loss of earnings resulting from unauthorized access to your Stripe account, changes to your payout details, or any action taken within your Stripe account by any party other than Social Buster. Social Buster will verify your connected account identity on every payout. If a discrepancy is detected, your payout will be frozen and you will be notified via your dashboard. You are responsible for enabling two-factor authentication on your Stripe account.

### Self-Referrals & Fraud
Self-referrals are strictly prohibited. Creating duplicate accounts or any other attempt to fraudulently generate commissions — including device spoofing, cookie manipulation, or coordinated fake signups — will result in immediate termination of your Legacy membership and affiliate eligibility, forfeiture of all earnings including reserves, and may be reported to relevant authorities.

### Referred User Privacy
Referred users' personal information is never disclosed to affiliates. Commission reporting shows plan tier and earnings only. No names, emails, or identifying information are shown in the affiliate dashboard.

---

## Part 10 — Landmines & Gotchas

- **Never pass Stripe Price ID from frontend.** Backend builds the checkout session. Frontend sends intent only ("I want Legacy"). Price ID comes from `legacy_cohorts` table server-side.
- **Slot counter must use SELECT FOR UPDATE.** App-level checks are not enough — two simultaneous requests will both pass. Row lock is mandatory.
- **Slug is permanent after first custom set.** No admin override route exists by design. Do not add one.
- **Commission tier calculated at invoice time.** Not at month start, not cached. Always fresh count of active referrals (paid invoice in last 35 days) at the moment the webhook fires.
- **Clawbacks do not create negative balance.** Excess clawback over pending earnings is absorbed. Do not build carryforward logic.
- **Payout runs on the 5th, not the 1st.** The 5-day buffer is intentional for chargeback timing. Do not move it.
- **Legacy-to-Legacy referrals earn nothing.** Skip commission when `referred_user.subscription_tier === 'legacy'` at invoice time. But if they upgrade off Legacy, commissions start on next invoice.
- **Referral cookie is first-click, not last-click.** Do not overwrite an existing referral cookie.
- **Stripe Connect account ID must be verified on every payout.** Not just at setup time. Store it at onboarding, verify it matches before every transfer.
- **`account.application.deauthorized` webhook must be handled.** Silent payout failures will occur if ignored.
- **RLS on all new tables must use `USING (true) WITH CHECK (true)` for service role.** Never use `auth.role() = 'service_role'` — it does not work in this Supabase setup. See ISSUE-029.
- **Affiliate dashboard tab must be conditionally rendered.** Check `subscription_tier === 'legacy'` server-side on `/affiliate/dashboard` — do not rely on frontend hide/show alone.
- **Stripe webhook idempotency.** Every commission write must check for existing record with same `stripe_invoice_id` before inserting. Duplicate webhooks will happen.
- **Email account summary (future feature).** When built: DKIM/SPF/DMARC must be configured on domain first. Emails must never contain login links or payout CTAs. Footer must state "We will never ask you to click a link to claim a payout."
- **Countdown display math.** Never show 0 or negative. Display = actual - 25, but if actual ≤ 5 always show "1 Remaining!" Cap the display floor at 1 until all slots are gone, then show closed message.

---

## Part 11 — Build Order

1. DB migrations (all tables above + RLS policies using correct pattern)
2. Legacy cohort + slot backend routes + admin controls
3. Stripe webhook additions (checkout.session.completed, invoice events, dispute, refund, deauthorized)
4. Referral slug system (generation, custom set, cookie tracking, anti-bot)
5. Commission calculation engine (wired into webhook handler)
6. Clawback system (triggered by dispute/refund webhooks)
7. Payout job (BullMQ scheduled job, runs 5th of month)
8. Clawback reserve logic (withhold 10%, release after 60 days)
9. Stripe Connect onboarding flow (post-Legacy-signup redirect)
10. Plans/pricing page — Legacy section + countdown
11. User affiliate dashboard tab (Legacy-gated)
12. Admin panel additions (Legacy tab, Affiliates tab, Payout queue, Fraud flags)
13. Terms page update
14. End-to-end testing (referral signup → commission → payout cycle)
15. Fraud scenario testing (self-referral, slot race, replay attack, cookie stuffing)
