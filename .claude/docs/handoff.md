# Social Buster — Developer Handoff

**Last updated:** 2026-03-24
**Status:** Core platform (Phases 1–8) built and deployed on Coolify. Publishing working for Facebook (text/image/video) and Instagram (image/video). Stripe billing fully working. DM automation code complete — awaiting first successful end-to-end test with a non-admin commenter.

---

## What This App Is

Enterprise AI-powered social media marketing platform. Three core functions:

1. **AI post generation** — user submits a brief, LLM generates hook/caption/hashtags/CTA for each selected platform
2. **Comment-to-lead DM automation** — monitors comments for trigger phrases, fires DMs directly via Meta Graph API
3. **Auto-publishing** — scheduled or immediate publishing to 7 platforms via their native APIs

Target: 5,000 U.S. users. The stack is deliberately low-cost and swappable at every layer.

---

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Node.js + Express | Simple, async I/O matches our workload |
| Frontend | Plain HTML/CSS/JS (no React) | Zero build step, no framework updates to chase |
| Database | PostgreSQL via Supabase | RLS multi-tenancy out of the box, free tier |
| Auth | Supabase Auth | Email/password, JWT (1-hour expiry), refresh tokens |
| Job Queue | BullMQ on Redis | Retry, backoff, visibility, survives restarts |
| LLM | OpenAI-compatible endpoint (default: Groq) | Swap provider by changing one env var |
| AI Images | Cloudflare Workers AI (Flux Schnell) | ~$0.0023/image, returns bytes directly |
| Video | FFmpeg (background only, never on request path) | Industry standard, full control |
| Storage | Supabase Storage (public buckets) | Same vendor as DB, public URLs, no auth at read time |
| DM Automation | Direct Meta Graph API | Zero cost, full conversation state control |
| Billing | Stripe (Checkout + webhooks) | Partially working — see Active Bug section |
| Deployment | Docker + Docker Compose → Coolify | Auto-deploy on push to main |

---

## Full Directory Structure

```
/social-buster
├── backend/
│   ├── server.js                     Main entry point. Starts Express, Redis, workers.
│   │                                 Contains: startup validation, health check loop,
│   │                                 global error handler, static file serving.
│   │                                 NOTE: Stripe webhook handler mounted here BEFORE
│   │                                 express.json() — this is intentional and required.
│   │                                 Meta webhook also mounted before express.json().
│   │
│   ├── routes/
│   │   ├── auth.js                   Login, signup, logout, profile CRUD, token refresh
│   │   ├── briefs.js                 Brief CRUD + triggers LLM generation via llmService
│   │   ├── posts.js                  Post CRUD. PUT /:id triggers mediaProcessQueue.
│   │   ├── media.js                  Media library, Drive scan, video probe, AI image gen
│   │   ├── publish.js                Platform OAuth connect/disconnect, manual publish
│   │   ├── automations.js            DM automation CRUD, lead listing, CSV export, stats
│   │   ├── webhooks.js               Meta webhook receiver for incoming DM replies
│   │   ├── intelligence.js           Intelligence dashboard data, research refresh
│   │   ├── billing.js                Stripe checkout, plan change, cancel, downgrade
│   │   │                             NOTE: Webhook handler is NOT here — it's in server.js
│   │   ├── admin.js                  Admin dashboard + BullMQ Board (requireAdmin)
│   │   └── messages.js               User-to-admin inbox
│   │
│   ├── middleware/
│   │   ├── auth.js                   Validates Supabase JWT. Sets req.user = { id, email }
│   │   ├── tenancy.js                Creates user-scoped Supabase client on req.db
│   │   ├── adminAuth.js              requireAdmin middleware (checks admin flag)
│   │   └── rateLimit.js              express-rate-limit. standardLimiter, strictLimiter
│   │
│   ├── agents/
│   │   ├── publishingAgent.js        Core publish logic + retry. Uses process_status/processed_url
│   │   ├── mediaProcessAgent.js      Copies media → Supabase Storage at attach time
│   │   ├── dmAgent.js                DM conversation state machine (single + multi-step)
│   │   ├── commentAgent.js           Comment ingestion + DM automation trigger
│   │   ├── mediaAgent.js             Cloud storage scanning + file cataloging
│   │   ├── researchAgent.js          LLM trend research, cached in Redis
│   │   └── performanceAgent.js       Platform metrics polling
│   │
│   ├── workers/
│   │   ├── index.js                  Orchestrator. require()s all workers, registers jobs
│   │   ├── publishWorker.js          'publish' queue. Every 60s. Concurrency: 2
│   │   ├── mediaProcessWorker.js     'media-process' queue. On media attach. Concurrency: 2
│   │   ├── dmWorker.js               'dm' queue. Rate limited (10/min). Concurrency: 2
│   │   ├── mediaWorker.js            'media-scan' queue. Every 30 min
│   │   ├── mediaAnalysisWorker.js    'media-analysis' queue. FFmpeg per video. Concurrency: 2
│   │   ├── commentWorker.js          'comment' queue. Every 15 min
│   │   ├── performanceWorker.js      'performance' queue. Every 2 hours
│   │   └── researchWorker.js         'research' queue. Weekly per user
│   │
│   ├── services/
│   │   ├── stripeService.js          Stripe billing operations — SEE ACTIVE BUG SECTION
│   │   ├── platformAPIs.js           publish/fetchMetrics/fetchComments for all 7 platforms
│   │   ├── messagingService.js       DM sending via Meta Graph API (Facebook + Instagram)
│   │   ├── llmService.js             OpenAI-compatible wrapper (swap provider via .env)
│   │   ├── ffmpegService.js          Video probe/trim/download/cleanup + PLATFORM_LIMITS
│   │   ├── imageGenerationService.js Cloudflare Workers AI image generation
│   │   ├── googleDriveService.js     Drive scan + downloadGoogleDriveFile()
│   │   ├── supabaseService.js        supabaseAdmin client (service role)
│   │   ├── tokenEncryption.js        AES-256-GCM for OAuth token storage
│   │   ├── redisService.js           cacheGet/cacheSet/cacheDel wrappers
│   │   ├── videoAnalysisService.js   FFmpeg scene detection → video_segments table
│   │   ├── visionTaggingService.js   LLM visual tagging of segments
│   │   ├── promptLoader.js           Loads .txt prompt templates from /prompts/
│   │   └── alertService.js           SMTP email alerts for health check
│   │
│   ├── queues/
│   │   └── index.js                  All 8 BullMQ queue definitions + Redis connection
│   │
│   └── data/                         Temp files only. Always cleaned up. Never commit.
│
├── frontend/public/
│   ├── index.html                    Single HTML file. Hash-routed (#dashboard, #brief, etc.)
│   ├── privacy.html                  Privacy policy page (required for Meta App Review)
│   ├── css/
│   │   ├── styles.css                Main styles
│   │   └── platforms.css             Platform icons + color chips
│   └── js/
│       ├── app.js                    Shell, auth, routing, billing UI, post rendering
│       ├── brief.js                  Brief form + generation UI
│       ├── preview.js                WYSIWYG per-platform post preview + DM automation panel
│       ├── publish.js                Queue UI, status polling, OAuth connect/disconnect
│       ├── media.js                  Media library, clip picker, AI image gen UI
│       ├── messages.js               User inbox UI + unread badge poller
│       └── admin.js                  Admin dashboard UI
│
├── docker/
│   ├── docker-compose.yml            Services: backend, redis (n8n removed)
│   └── Dockerfile.backend            Node.js + FFmpeg image
│
└── CLAUDE.md                         Project context for Claude Code sessions
```

---

## ACTIVE BUG: Stripe Billing — Plan Changes, Cancel, and Downgrade Not Working

### What Works
- **Free → Paid (first time):** User clicks "Upgrade to Starter" → redirected to Stripe Checkout → enters card → pays → webhook fires → DB updated → user sees new plan. **This works.**
- **Stripe webhook:** Signature verification works. Events are processed. DB is updated via webhook. Confirmed with 200 responses in Stripe dashboard.
- **Billing portal:** "Payment method & invoices" link opens Stripe Customer Portal correctly.

### What Does NOT Work
- **Paid → Different Paid (plan change):** User clicks "Downgrade to Starter" or "Upgrade to Buster" → **nothing visible happens**. No error, no feedback, no Stripe redirect. The button just does nothing from the user's perspective.
- **Cancel subscription:** User clicks "Cancel subscription" → confirms dialog → **nothing visible happens**. No yellow cancellation banner, no status change.
- **Downgrade to Free:** User clicks "Downgrade to Free" → confirms dialog → **nothing visible happens**.

### Diagnosis So Far

The root cause has NOT been conclusively identified. Here is what we know and what we've tried:

**Diagnostic logging was added** to `stripeService.js` for `changePlan()`, `cancelSubscription()`, and `downgradeToFree()`. These log the subscription row from the DB before taking action. **The Coolify logs from these have NOT been checked yet** — this is the next step.

**Token refresh was rebuilt** — Supabase JWTs expire after 1 hour. The original code had a 50-minute `setInterval` refresher which browsers throttle when tabs are backgrounded. This was replaced with:
- JWT `exp` claim decoding (`getTokenExpiry()`, `isTokenExpiringSoon()`)
- Proactive refresh before every `apiFetch()` call if token is within 5 minutes of expiry
- Global refresh lock (`refreshTokenOnce()`) — only one refresh runs at a time, concurrent 401s queue behind it
- `auth:expired` CustomEvent — logout happens AFTER catch blocks finish, not inside `apiFetch()`
- Unread badge poller skips when token is near expiry

Despite this rewrite, the billing actions still don't work. **The 401/token issue may not be the actual problem** — it was a red herring that masked the real bug.

**What we fixed that IS working:**
- `changePlan()` now updates the DB immediately after Stripe confirms (not just via webhook)
- `downgradeToFree()` and `cancelSubscription()` now clear `current_period_end` when reverting to free
- `subscription.deleted` webhook now sets `status: 'active'` (not `'cancelled'`) when reverting to free_trial
- Duplicate webhook handler removed from `billing.js` (only `server.js` handler remains)
- Checkout redirect now polls every 2s for webhook to complete (instead of single fetch)
- Subscription card header badge updates dynamically
- Cancellation banner stores `current_period_end` from Stripe response

### Likely Root Causes to Investigate

1. **Silent API errors:** The frontend `changePlan()`, `confirmCancelSubscription()`, and `downgradeToFree()` all catch errors and call `showAlert()`. If the alert div doesn't exist (page was replaced) or the function completes without error but also without effect, the user sees nothing. **Add `console.log` before and after each `apiFetch` call in these frontend functions to verify the requests are actually being sent.**

2. **`stripe_subscription_id` might be null:** If the Stripe webhook updates a different field or the upsert fails, `changePlan()` falls through to Checkout (which the frontend does as a fallback). But Checkout requires card entry, so the user gets sent to Stripe every time. **Check the Coolify logs for the diagnostic output** (search for `[Billing] changePlan:` and `[Billing] cancelSubscription:`) — these will show the exact DB row state.

3. **Stripe subscription status might not be 'active':** If vmarkyv's subscription in Stripe is `incomplete` or `past_due`, `changePlan()` clears `stripe_subscription_id` and throws. **Check the Stripe dashboard** for vmarkyv's customer — look at the subscription status.

4. **Multiple Stripe customers for the same user:** If `createCheckoutSession()` creates a new Stripe customer each time (because `stripe_customer_id` wasn't saved properly), the webhook can't find the user by customer ID. **Check the Stripe dashboard** for duplicate customers with the same email.

5. **RLS blocking the update:** The `subscriptions` table might have RLS policies that block `supabaseAdmin` writes (we saw this with `tier_limits`). Run `SELECT * FROM subscriptions WHERE user_id = '<vmarkyv_user_id>'` in Supabase SQL Editor to verify the row exists and has the expected values.

### How to Debug (Step by Step)

1. **Check Coolify logs** — search for `[Billing] changePlan:`, `[Billing] cancelSubscription:`, `[Billing] downgradeToFree:`. The diagnostic logs show the exact subscription row from the DB.

2. **Check Stripe dashboard** — search for vmarkyv's email. Look at:
   - How many customers exist for this email?
   - What is the subscription status? (active, incomplete, cancelled?)
   - Is there a valid payment method on file?

3. **Check Supabase SQL Editor** — run:
   ```sql
   SELECT * FROM subscriptions WHERE user_id = '<vmarkyv_user_id>';
   ```
   Verify: `stripe_subscription_id` is not null, `stripe_customer_id` matches Stripe dashboard, `plan` and `status` are correct.

4. **Check browser DevTools** — open Console before clicking any billing button. Look for:
   - Network requests to `/billing/change`, `/billing/cancel`, `/billing/downgrade-free`
   - Response status codes and bodies
   - Any JavaScript errors

5. **If `stripe_subscription_id` is null** — the webhook isn't saving it. Check webhook logs in Stripe dashboard (are events being delivered? Are they returning 200?). Then check Coolify logs for `[Stripe Webhook]` entries.

### Files Involved in Billing

| File | What it does |
|------|-------------|
| `backend/server.js` (line ~57) | Stripe webhook endpoint — mounted BEFORE `express.json()` |
| `backend/services/stripeService.js` | ALL billing logic: customer CRUD, checkout, cancel, change, webhook handler |
| `backend/routes/billing.js` | HTTP routes that call stripeService functions |
| `frontend/public/js/app.js` | All billing UI: `renderSubscriptionSection()`, `startUpgrade()`, `changePlan()`, `downgradeToFree()`, `confirmCancelSubscription()`, `openBillingPortal()`, `checkPaymentRedirectResult()` |

### Database Tables for Billing

**`subscriptions`** — one row per user:
```
user_id (FK to auth.users)
stripe_customer_id (Stripe customer ID, e.g., cus_xxx)
stripe_subscription_id (Stripe subscription ID, e.g., sub_xxx — null when on free)
plan (free_trial | starter | professional | enterprise)
status (active | cancelling | past_due | cancelled)
current_period_end (timestamp — when the billing period ends)
```

**`plans`** — one row per tier (admin-editable):
```
tier (free_trial | starter | professional | enterprise)
name (display name)
stripe_price_id (Stripe price ID, e.g., price_xxx)
is_active (boolean)
price_display (e.g., "$29")
period_label (e.g., "/month")
features (JSON array of feature strings)
color (hex color for card border)
badge (e.g., "INTRO", "MOST POPULAR")
sort_order (integer for display ordering)
```

**`tier_limits`** — per-tier feature caps (admin-editable):
```
tier (starter | professional | enterprise)
feature (briefs_per_month | ai_images_per_month | platforms | etc.)
value (integer, -1 = unlimited)
label (display name for admin UI)
```

---

## Every Major Feature Built

### Phase 1 — Auth + Multi-Tenancy
- Supabase Auth (email/password). JWT validated via `middleware/auth.js` on every request.
- `middleware/tenancy.js` creates a user-scoped Supabase client at `req.db`.
- Supabase RLS policies enforce data isolation at the database level.
- Password recovery flow built (email reset link).
- **JWT refresh system:** Frontend decodes JWT `exp` claim, proactively refreshes before expiry via `refreshTokenOnce()`. Global lock prevents concurrent refresh races.

### Phase 2 — Brief System + AI Post Generation
- Brief form: niche, platform selection, tone, post type, objective, style notes, media options.
- Submit triggers `llmService.generatePosts()` — LLM produces hook/caption/hashtags/CTA.
- LLM batches 3 platforms per call. 7 platforms = 3 sequential LLM calls.
- Posts saved to `posts` table with `status = 'draft'`.

### Phase 3 — User Profile Expansion
- `user_profiles` extended with: `industry`, `business_type`, `geo_region`, `target_age_range`, `content_preferences`, `posting_frequency`, `brand_voice_notes`.
- Cohort matching key: `industry + business_type + geo_region + target_age_range + platform`.

### Phase 4 — Media Library + Video Analysis
- Google Drive OAuth integration. `mediaAgent` scans every 30 minutes.
- AI image generation via Cloudflare Workers AI (Flux Schnell).
- Video analysis: FFmpeg scene detection + audio energy → `video_segments` table.
- Clip picker UI shows 3–5 suggested segments. Pre-rendered at selection time.
- `analysis_status` state machine: `pending → analyzing → done / failed`.

### Phase 5 — Publishing Queue + Platform OAuth
- Post statuses: `draft → scheduled → publishing → published / failed`.
- Facebook OAuth fully functional. Instagram publishing (image + video via Reels) working.
- BullMQ job queue: 8 queues replacing all `setInterval` polling loops.
- Media architecture: two-phase (copy at attach time → publish from Supabase URL).

### Phase 6 — Collective Intelligence
- `performanceAgent` polls platform metrics and feeds the intelligence loop.
- Intelligence dashboard shows signals and posting recommendations.

### Phase 7 — Enriched Brief Metadata
- Semantic profiles: `video_energy`, `video_pacing`, `video_mood`, `ideal_segments`, `llm_style_note`.

### Phase 8 — DM Automation System
- Direct Meta Graph API calls (n8n completely removed).
- Per-post trigger keywords, single-message or multi-step conversation flows.
- Conversation state machine: `active → collecting → completed | expired | opted_out`.
- 24-hour messaging window enforced. Rate limiting via Redis counters.
- Meta webhook for incoming DM replies. Auto-CTA on post save.
- Frontend: automation panel on post cards, leads dashboard, CSV export.

### Phase 9 — Stripe Billing (Partially Complete)
- Plans table with admin-editable tiers (Starter $29, Professional $49, Buster $89).
- Stripe Checkout for first-time upgrades (free → paid). **Working.**
- Stripe Customer Portal for payment method management. **Working.**
- Webhook signature verification and event processing. **Working.**
- Plan changes, cancel, downgrade. **NOT WORKING — see Active Bug section.**
- Tier limits table seeded with feature caps per tier.
- Admin dashboard: Overview, Revenue, Users, Limits tabs.

### Health Check System
- Quick check every 5 minutes: Redis ping, worker liveness, failed job counts.
- Full check every 60 minutes: DB connectivity, env vars, Cloudflare AI, LLM endpoint.
- Auto-remediates: retries failed BullMQ jobs, discards permanently failed.
- Email alerts on status CHANGE only. Log prefixes: `[HEALTH OK]`, `[HEALTH DEGRADED]`, `[HEALTH CRITICAL]`.

---

## Media Architecture (Two-Phase, Do Not Revert)

### Phase 1 — Copy at Attach Time (`mediaProcessAgent.js`)
| Provider | Action |
|----------|--------|
| `ai_generated` | Already in Supabase — sets `processed_url = cloud_url` directly |
| `google_drive` | Downloads via `drive.files.get({alt: 'media'})` → uploads to Supabase Storage |
| `manual` / others | Assumes cloud_url is publicly accessible — uses it directly |

After this runs: `process_status = 'ready'`, `processed_url` = permanent Supabase public URL.

### Phase 2 — Publish Using Supabase URL (`publishingAgent.js`)
1. Checks `process_status === 'ready'` — if not, marks post `failed`.
2. **Images:** URL passed to platform API. Platform fetches from Supabase directly.
3. **Videos:** Downloaded to temp → FFmpeg trim → temp file path to platform API.

### Supabase Storage Buckets (all PUBLIC)
| Bucket | Contents |
|--------|----------|
| `ai-generated-images` | AI-generated images |
| `video-segments` | Pre-rendered trimmed clips |
| `processed-media` | Copies of Drive/manual media |

---

## DM Automation Architecture

### End-to-End Flow
1. User creates automation on a post via DM Automation panel in preview.js.
2. Auto-CTA appended to post's CTA field (e.g., `Comment "BTS" below to get it!`).
3. User publishes to Facebook/Instagram.
4. Someone comments with trigger keyword.
5. `commentWorker` (every 15 min) ingests comments.
6. `commentAgent` matches against `dm_automations.trigger_keywords`.
7. `dmAgent.startConversation()` creates conversation row, queues `send-dm` job.
8. `dmWorker` decrypts page access token, calls `messagingService.sendDM()`.
9. For multi-step flows: replies arrive via Meta webhook → `dmAgent.processIncomingReply()`.
10. Collected data stored in `dm_collected_data`, viewable and exportable as CSV.

### Important Limitations
- **24-hour window:** Meta only allows DMs to users who interacted within 24 hours.
- **App Review required:** `pages_messaging` and `pages_read_engagement` need Meta App Review.
- **Page owner can't DM self:** Page admin comments are identified as the Page, not a user.

---

## All Approaches That Failed (Do Not Re-Attempt)

1. **Google Drive `webViewLink` as direct download** — returns HTML, not binary. Use `downloadGoogleDriveFile()`.
2. **Download media from Drive at publish time** — architecture was redesigned to prevent this. Drive must be copied to Supabase at attach time.
3. **`axios` without timeout on platform API calls** — stalled TCP connections hang forever in Docker. Always use `timeout: 30_000`.
4. **5-minute stale `publishing` recovery window** — too long. Legitimate publishes take ≤105 seconds. Use 2 minutes.
5. **Seed `media-process` jobs for ALL media items** — only seed for media attached to posts needing publishing. Seeding everything kills video analysis and fills disk.
6. **Single try/catch in `startAllWorkers()`** — use independent `run(label, fn)` wrappers per step.
7. **`posts.ai_image_url` in SELECT query** — column doesn't exist. AI images are in `media_items`.
8. **Raw axios errors from Facebook** — always use `fbCall()` wrapper that extracts actual error.
9. **`instagram_manage_messages` as OAuth scope** — doesn't exist for Facebook Login. `pages_messaging` covers both.
10. **n8n for DM automation** — removed. Direct Meta Graph API is simpler and free.
11. **Re-analyzing already-analyzed videos** — check `analysis_status` before queuing.
12. **Remove DELETE before INSERT in `videoAnalysisService.js`** — causes duplicate segments.
13. **Auto-reset 'failed' analysis to 'pending'** — causes infinite loop. Only reset 'analyzing' (crashed mid-run).
14. **Remove `knownLength` from Facebook video upload** — without it, Facebook rejects with error 351.
15. **Move `access_token` from URL params to form body for Facebook video** — URL params are more reliable for multipart.
16. **Remove existing BullMQ job before re-queuing analysis** — BullMQ deduplicates by jobId across ALL states.
17. **50-minute `setInterval` token refresh** — browsers throttle background tabs. Replaced with JWT exp decoding + on-demand refresh.
18. **Concurrent refresh token calls** — Supabase rotates refresh tokens. Multiple simultaneous refresh calls invalidate each other. Use a global lock.

---

## Key Architectural Decisions

### No OAuth at publish time — ever
The publish worker must NEVER call Drive API, Google OAuth, or any authenticated external service. All auth-dependent operations run at attach time via `mediaProcessAgent`.

### Multi-tenancy enforced at two layers
1. **Application:** Routes use `req.db` (tenant-scoped). Workers use `supabaseAdmin` with `.eq('user_id', userId)`.
2. **Database:** Supabase RLS policies. Data cannot leak even if application code has a bug.

### No vendor lock-in — adapter pattern everywhere
- LLM: swap via `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`
- Platform APIs: all through `services/platformAPIs.js`
- DM sending: all through `services/messagingService.js`
- Storage: all through `mediaProcessAgent.uploadToSupabase()`

### Stripe webhook must run BEFORE `express.json()`
In `server.js`, the Stripe webhook handler is mounted as `app.post('/billing/webhook', express.raw(...))` BEFORE `express.json()` middleware. Stripe requires the raw Buffer for signature verification. If `express.json()` runs first, the raw body is consumed and verification fails.

### JWT refresh architecture
Frontend decodes the JWT `exp` claim to determine when the token expires. Before every API call, `apiFetch()` checks if the token is within 5 minutes of expiry and proactively refreshes. A global lock (`refreshTokenOnce()`) ensures only one refresh runs at a time — concurrent 401s queue behind it. The `auth:expired` CustomEvent triggers logout AFTER catch blocks finish, not during `apiFetch()`.

---

## Platform Publishing Status

| Platform | OAuth | Publish | Comments | DMs | Notes |
|----------|-------|---------|----------|-----|-------|
| Facebook | ✅ Working | ✅ Text+Image+Video | ✅ Fetching works | ✅ Built (needs App Review) | Fully live |
| Instagram | ✅ Via FB OAuth | ✅ Image+Video (Reels) | ✅ Fetching works | ✅ Built (needs App Review) | Uses same Page token as FB |
| TikTok | ❌ | ❌ Stub | ❌ | ❌ | Needs `TIKTOK_CLIENT_KEY/SECRET` |
| LinkedIn | ❌ | ❌ Stub | ❌ | ❌ | Needs `LINKEDIN_CLIENT_ID/SECRET` |
| X | ❌ | ❌ Stub | ❌ | ❌ | Needs `X_CLIENT_ID/SECRET` |
| Threads | ✅ Scaffolded | ❌ Stub | ❌ | ❌ | Redirect URIs need real domain |
| YouTube | ❌ | ❌ Stub | ❌ | ❌ | Needs separate OAuth setup |

---

## How to Read Logs (Coolify)

Coolify → project → **Deployments** → live deployment → **Logs**.

Key log prefixes:
- `[PublishingAgent]` — publishing flow, per-post
- `[MediaProcess]` — media copy job (attach time)
- `[PlatformAPIs]` — Facebook/Instagram API calls, actual errors
- `[CommentAgent]` — comment ingestion, trigger matching
- `[DMAgent]` — conversation state changes, data collection
- `[DMWorker]` — DM send attempts
- `[MessagingService]` — actual DM API calls, rate limits
- `[Billing]` — billing operations (changePlan, cancel, downgrade)
- `[Stripe Webhook]` — webhook event processing
- `[HEALTH OK/DEGRADED/CRITICAL]` — health check results

**Billing debug logs** (currently active):
- `[Billing] changePlan: userId=... sub=...` — shows DB row when plan change requested
- `[Billing] cancelSubscription: userId=... sub=...` — shows DB row when cancel requested
- `[Billing] downgradeToFree: userId=... sub=...` — shows DB row when downgrade requested

---

## Required Environment Variables

```bash
# Supabase
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Redis (used by BullMQ)
REDIS_HOST=
REDIS_PORT=6379
REDIS_PASSWORD=

# Token encryption (AES-256 — must be ≥ 32 characters)
TOKEN_ENCRYPTION_KEY=

# LLM — Groq default, swap to any OpenAI-compatible endpoint
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_API_KEY=
LLM_MODEL=llama-3.1-8b-instant

# AI Image generation (Cloudflare Workers AI)
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=

# Facebook OAuth
FACEBOOK_APP_ID=
FACEBOOK_APP_SECRET=

# Google Drive OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://yourdomain.com/auth/google/callback

# Meta Webhook (for DM automation reply handling)
META_WEBHOOK_VERIFY_TOKEN=

# Frontend URL — used for OAuth redirects. No trailing slash.
FRONTEND_URL=https://yourdomain.com

# FFmpeg
FFMPEG_PATH=/usr/bin/ffmpeg
FFMPEG_TEMP_DIR=/tmp/social-buster/videos

# Stripe
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
PLAN_PRICE_STARTER=29
PLAN_PRICE_PROFESSIONAL=79
PLAN_PRICE_ENTERPRISE=199

# SMTP email alerts (optional — falls back to console logs if not set)
SMTP_HOST=
SMTP_USER=
SMTP_PASS=
ALERT_EMAIL_TO=

# App
PORT=3000
NODE_ENV=production
```

---

## Admin Dashboard

### Tabs
- **Overview:** System health, worker status, queue stats, storage bucket check
- **Revenue:** Stripe revenue metrics (total subscribers, MRR by tier)
- **Users:** User list with search, click to view detail (profile, posts, metrics)
- **Limits:** Tier limits editor (feature caps per plan tier)

### Known Admin Issues Fixed
- Storage check no longer shows "degraded" for missing buckets (Supabase API permission issue)
- Tier limits auto-seed uses upsert with `label` column (was failing due to RLS + missing column)
- User detail falls back to Supabase Auth data for users without `user_profiles` row

---

## Test Accounts

| Email | Role | Current State |
|-------|------|---------------|
| mark@marketeaminc.com | Admin | Professional plan (via Stripe). Has 7+ old incomplete Stripe subscriptions from debugging. Cancel banner working. |
| vmarkyv@yahoo.com | Regular user | Professional plan (via Stripe). **Billing actions not responding** — this is the active bug. |

---

## Session Log: 2026-03-24 — DM Automation Debugging (Continued)

### Context
Picking up from commit `ff7d431` (Private Replies API). The full DM pipeline was built but the actual DM delivery had never succeeded. This session focused on diagnosing and fixing the Private Replies failure.

### What We Tested
1. Published a new Facebook image post to "World Wide Treasure Hunt" Page — **published successfully** (post `913edea9`, platform post ID `101465745099191_1234583128882396`)
2. Mark Vidano commented "Hi" on the post — webhook fired, trigger matched, DM conversation created
3. DM delivery failed 3x with: `Facebook Private Reply error 100 subcode=33: Object with ID '1234583128882396_1296422082444210' does not exist, cannot be loaded due to missing permissions`
4. Health check auto-discarded the failed DM job after retries exhausted
5. Second comment from "World Wide Treasure Hunt" (the Page itself) — webhook fired but no DM triggered (different trigger or Page self-comment filtering)

### Root Cause Found: Missing `pages_read_user_content` Permission
The Private Replies API needs to READ the comment before replying to it. Our Page token had `pages_read_engagement` (reads Page-published content) but NOT `pages_read_user_content` (reads user-generated content like comments on Page posts).

**Proof:** In Graph API Explorer:
- With `pages_read_engagement` only → `GET /1234583128882396_1296422082444210` → error 200 "Missing Permissions"
- With `pages_read_user_content` added → same GET → returned full comment data (from: Mark Vidano, message: "Hi")

### Fixes Applied (commit `90847b2`)
1. **Added `pages_read_user_content` to OAuth scopes** in `routes/publish.js` — so new Page tokens include this permission
2. **Added diagnostic logging to `sendPrivateReply()`** in `messagingService.js` — before attempting Private Reply, does a GET on the comment to distinguish "can't read" (permissions) from "can read but can't reply" (unsupported operation). This diagnostic info will be in Coolify logs for future debugging.

### Why Admin Self-Test Didn't Work
Mark Vidano is the admin of ALL test Pages (Get Me Hip, World Wide Treasure Hunt, etc.). Facebook's Private Replies API cannot send a DM from a Page to that Page's own admin — it's "messaging yourself." This is not a bug in our code; it's a Meta platform limitation.

**For testing:** Need a real person with a completely different Facebook account (not an admin/developer/tester on the Social Buster app) to comment on a published post with the trigger keyword.

### Current State of DM Automation (as of commit `90847b2`)
| Step | Status |
|------|--------|
| Webhook delivery (Meta → our server) | **WORKING** — comments arrive in real-time |
| Comment processing + trigger matching | **WORKING** — keywords match, comments saved to DB |
| DM conversation creation | **WORKING** — `dm_conversations` records created correctly |
| Deduplication | **WORKING** — same person won't get DM'd twice for same automation |
| Private Replies API call | **DEPLOYED, AWAITING TEST** — `pages_read_user_content` added, needs reconnect + non-admin commenter |
| Multi-step follow-up (steps 2+) | **NOT YET TESTED** — requires user to reply to private reply, giving us their PSID for Send API |
| Comment polling (15-min backup) | **PARTIALLY WORKING** — `pages_read_engagement` errors for some posts (needs App Review for Standard Access) |

### Next Steps (in order)
1. **Reconnect Facebook in Social Buster** — disconnect + reconnect to get fresh token with `pages_read_user_content`
2. **Publish a simple test post** (text only is fine)
3. **Have a non-admin friend comment** with the trigger keyword
4. **Check Coolify logs** — the diagnostic logging will show whether the comment is readable and whether Private Replies succeeds
5. If Private Replies works → DM automation is confirmed end-to-end
6. Submit for Meta App Review (`pages_messaging`, `pages_read_user_content`, `pages_read_engagement`)

### Files Modified This Session
- `backend/routes/publish.js` — Added `pages_read_user_content` to OAuth scopes
- `backend/services/messagingService.js` — Added diagnostic GET before Private Reply attempt

### Key Commits
- `90847b2` — Add pages_read_user_content OAuth scope + diagnostic logging for Private Replies

### Meta Permission Reference (What Each One Does)
| Permission | What It Reads | Status |
|-----------|--------------|--------|
| `pages_read_engagement` | Content posted BY the Page (posts, photos, videos), follower data, PSID | Ready for testing |
| `pages_read_user_content` | Content posted BY USERS on the Page (comments, ratings, reviews) | Ready for testing |
| `pages_manage_posts` | Create/edit/delete Page posts | Ready for testing |
| `pages_manage_metadata` | Subscribe Page to webhooks, update Page settings | Ready for testing |
| `pages_messaging` | Send/receive DMs via Messenger Platform + Private Replies | Ready for testing |

"Ready for testing" = works for app admins/developers/testers. Standard Access (via App Review) needed for all users.

---

## What's Pending (In Priority Order)

1. **DM automation end-to-end test** — needs non-admin commenter, code is deployed and ready
2. **Meta App Review** — required for `pages_messaging`, `pages_read_user_content`, `pages_read_engagement` at Standard Access for non-admin users
3. **Clean up Stripe test data** — mark@ has 7+ incomplete subscriptions from debugging
4. **Admin override bug** — `admin_notes` column missing on `user_profiles` (fix: `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS admin_notes text;`)
5. **OAuth for remaining platforms** — LinkedIn, TikTok, X, YouTube (backend code exists, needs developer app credentials)
6. **Anti-cloning / IP protection** — investigate code obfuscation, server-side secrets, architecture choices to prevent copying
7. **WhatsApp** — 8th platform via WhatsApp Business API (future)
8. **Remove diagnostic logging** — DM + billing debug logs should be cleaned up once everything is confirmed working

**Already completed (remove from active tracking):**
- ~~Stripe billing~~ — fully working (subscribe, upgrade, downgrade, cancel)
- ~~Tier limit enforcement~~ — `checkLimit` wired on all routes, frontend upgrade prompts
- ~~Meta webhook registration~~ — registered and verified
- ~~Privacy Policy page~~ — exists at `/privacy.html`
- ~~Help section~~ — 8 topic sections with search
- ~~Threads OAuth~~ — working in production
- ~~Single session enforcement~~ — active_session_id implemented
- ~~Tawk.to~~ — replaced by in-app messaging system

---

## Coding Conventions

- **async/await with try/catch everywhere** — never `.then()/.catch()` chains
- **No hardcoded values** — everything configurable goes in `.env`
- **Comment every non-obvious block** — readable by a beginner
- **No inline business logic in routes** — routes validate input, delegate to agents/services
- **Routes use `req.db`** (user-scoped), workers/agents use `supabaseAdmin` with `.eq('user_id', userId)`
- **Frontend: plain ES6+ JS, hash-based routing, `apiFetch()` for all API calls**
- **Never call `supabaseAdmin` in a route handler without filtering by user_id**
- **Never call FFmpeg from a route handler** — background workers only

---

## Files You Should Never Modify Without Understanding

| File | Why |
|------|-----|
| `backend/middleware/auth.js` | JWT validation chain. Breaking this locks out all users. |
| `backend/middleware/tenancy.js` | Multi-tenancy isolation. Breaking this risks data leakage. |
| `backend/services/tokenEncryption.js` | Changing encryption logic breaks all stored OAuth tokens. |
| `backend/queues/index.js` | Queue definitions referenced by 8 workers. |
| `backend/server.js` (lines 50-90) | Webhook handlers must stay BEFORE `express.json()`. |
