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

## Session Log: 2026-03-24 — DM Automation Debugging (RESOLVED)

### Outcome
**DM automation is WORKING.** Confirmed via Graph API Explorer manual test — Sharon Vidano received a DM in Messenger from World Wide Treasure Hunt Page. Automated pipeline awaiting final end-to-end confirmation (Sharon comments with trigger keyword → DM arrives automatically).

### The Working Pipeline

```
Meta Webhook → webhooks.js (signature verify)
  → commentAgent.js (trigger keyword match)
    → dmAgent.js (create conversation row, queue DM job)
      → dmWorker.js (decrypt token, call messagingService)
        → messagingService.js (POST /{page_id}/messages with recipient.comment_id)
          → DM arrives in commenter's Messenger inbox ✅
```

### The Correct API Call

```
POST https://graph.facebook.com/v21.0/{PAGE_ID}/messages
Body: { "recipient": { "comment_id": "{comment_id}" }, "message": { "text": "..." } }
Params: access_token={PAGE_ACCESS_TOKEN}
```

**NOT** the old deprecated endpoint: `POST /{comment_id}/private_replies` — this was the root cause.

### 5 Issues Found and Fixed (Chronological)

#### Issue 1: Missing `pages_read_user_content` permission
- **Error:** `error 100 subcode=33: Object with ID does not exist, cannot be loaded due to missing permissions`
- **Fix:** Added `pages_read_user_content` to OAuth scopes (commit `90847b2`)

#### Issue 2: Page admin cannot DM themselves
- **Symptom:** DM never arrived for Mark Vidano (Page admin)
- **Fix:** Meta platform limitation — must test with a separate, non-admin account

#### Issue 3: Missing RLS policy on `dm_conversations`
- **Error:** `new row violates row-level security policy for table 'dm_conversations'`
- **Fix:** Created RLS policy in Supabase SQL

#### Issue 4: Failed DMs permanently block retries
- **Error:** `Skipping — already DM'd Sharon Vidano` (but DM was never delivered)
- **Fix:** Dedup guard now checks conversation status; failed attempts allow retry (commit `111f87f`)

#### Issue 5: DEPRECATED API ENDPOINT (the root cause of DM delivery failure)
- **Error:** Same error 100/subcode 33 on every attempt, even after permission fixes
- **Root cause:** `POST /{comment_id}/private_replies` was deprecated after Graph API v3.2. Meta moved Private Replies into the Messenger Send API.
- **Fix:** Switched to `POST /{page_id}/messages` with `recipient.comment_id` (commit `e4d59da`)
- **Confirmed:** Manual test in Graph API Explorer returned `recipient_id` + `message_id`, Sharon received the DM

### Resolved Questions
- **Recipients do NOT need app roles** — Sharon got the DM with no Facebook Tester role
- **Token refresh IS needed** after adding scopes — user must disconnect + reconnect
- **Webhook subscriptions survive** token refresh — no re-subscribe needed

### Current State of DM Automation (as of commit `e4d59da`)
| Step | Status |
|------|--------|
| Webhook delivery (Meta → our server) | **WORKING** |
| Comment processing + trigger matching | **WORKING** |
| DM conversation creation | **WORKING** |
| Deduplication + auto-recovery on failure | **WORKING** |
| DM delivery via Messenger Send API | **CONFIRMED WORKING** (manual test) |
| Full automated pipeline (comment → DM) | **AWAITING FINAL TEST** — Sharon to comment with trigger keyword |
| Multi-step follow-up (steps 2+) | **NOT YET TESTED** |
| Comment polling (15-min backup) | **PARTIALLY WORKING** — needs App Review for Standard Access |

### Files Modified Across All DM Sessions
- `backend/routes/publish.js` — Added `pages_read_user_content` to OAuth scopes
- `backend/services/messagingService.js` — Switched to modern `/{page_id}/messages` endpoint + diagnostic logging
- `backend/agents/dmAgent.js` — Dedup guard allows retries on failed conversations
- `backend/workers/dmWorker.js` — Marks conversation `'failed'` on job failure + fetches `platform_user_id` for Page ID

### Key Commits
- `ff7d431` — Initial Private Replies implementation (old deprecated endpoint)
- `90847b2` — Add `pages_read_user_content` OAuth scope + diagnostic logging
- `111f87f` — Fix dedup guard: allow retries when previous attempt failed
- `e4d59da` — **THE FIX:** Switch to modern `/{page_id}/messages` with `recipient.comment_id`

### Full debugging guide with lessons learned: see `platform_publishing_guide.md` → "DM Automation — Complete Debugging History & Solution"

---

## What's Pending (In Priority Order)

1. **Instagram DM automation end-to-end test** — Code deployed, Meta webhook subscriptions configured in portal. Needs: (a) reconnect Facebook in app to trigger IG webhook subscription via API, (b) publish Instagram post with trigger keyword automation, (c) have separate account comment trigger keyword, (d) verify DM arrives. **READ BEFORE STARTING:** All debugging history is in `platform_publishing_guide.md` → "DM Automation — Complete Debugging History & Solution" (Issues 1-8). Facebook DM took 8 rounds of debugging. Apply ALL lessons learned there to avoid repeating mistakes. Key gotchas: deprecated endpoints, PSID/IGSID mismatch, `.maybeSingle()` not `.single()`, dedup guard must handle failures, multi-step needs ≥2 steps, one private reply per comment, must test with non-admin account.
2. **Facebook DM automation — CONFIRMED WORKING** ✅ (single-message + multi-step + resource URL delivery all verified 2026-03-24)
3. **Dashboard health check** — posts not showing on dashboard, needs investigation
4. **Meta App Review** — required for `pages_messaging`, `pages_read_user_content`, `pages_read_engagement`, `instagram_manage_messages` at Standard Access for all users
5. **Clean up Stripe test data** — mark@ has 7+ incomplete subscriptions from debugging
6. **Admin override bug** — `admin_notes` column missing on `user_profiles` (fix: `ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS admin_notes text;`)
7. **OAuth for remaining platforms** — LinkedIn, TikTok, X, YouTube (backend code exists, needs developer app credentials)
8. **Anti-cloning / IP protection** — investigate code obfuscation, server-side secrets, architecture choices to prevent copying
9. **WhatsApp** — 8th platform via WhatsApp Business API (future)
10. **Remove diagnostic logging** — DM + billing debug logs should be cleaned up once everything is confirmed working

**Already completed (remove from active tracking):**
- ~~Stripe billing~~ — fully working (subscribe, upgrade, downgrade, cancel)
- ~~Tier limit enforcement~~ — `checkLimit` wired on all routes, frontend upgrade prompts
- ~~Meta webhook registration~~ — registered and verified
- ~~Privacy Policy page~~ — exists at `/privacy.html`
- ~~Help section~~ — 8 topic sections with search
- ~~Threads OAuth~~ — working in production
- ~~Single session enforcement~~ — active_session_id implemented
- ~~Tawk.to~~ — replaced by in-app messaging system
- ~~DM automation API endpoint~~ — confirmed working (manual test 2026-03-24)

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

## AI Agent Learning System

### Platform Availability & Tier Gating

**Current state (app.js v6, 2026-04-01):**
- Preferred Platforms in My Profile: only Instagram + Facebook are selectable. All others (TikTok, LinkedIn, X, Threads, WhatsApp, Telegram) show "(soon)" and are disabled.
- To activate a platform when its OAuth ships: remove it from the `comingSoon` exclusion in app.js — one line change.
- Tier-based platform caps: `tier_limits` table already has `maxPlatforms` logic in the profile form. Just needs DB rows populated per tier and the Limits tab updated. See [[FEATURES]] FEAT-022/023.

**Critical rule — always collect, selectively reveal:**
All AI agents (hookPerformanceAgent, toneObjectiveFitAgent, researchAgent, performanceAgent, etc.) run for **every user regardless of subscription tier**. Tier only gates what the user can SEE — not what gets collected. This means zero cold-start delay when a user upgrades. See [[FEATURES]] FEAT-024.

**Planned tier gating for intelligence data:**
- Free Trial → post generation only, no intelligence dashboard
- Starter → basic preflight (cohort benchmarks + research)
- Professional → full signal_weights (hook rankings, combo warnings, best times)
- Enterprise → all agents including cohort-wide platformAlgorithmAgent

---

### signal_weights — the learning engine foundation
`user_profiles.signal_weights` (JSONB) is the connective tissue for all learning agents.
Every agent writes multipliers here. contextBuilder reads them into every LLM brief prompt as a 10th context section.
SQL: `migration_signal_weights.sql` — run in Supabase before deploying.

### Agent Layers (locked-in architecture)

**Layer 1 — Performance Signal (what's working in your posts)**
| Agent | Status | Writes |
|-------|--------|--------|
| hookPerformanceAgent | ✅ Built (2026-04-01) | signal_weights.hook_formats |
| hookTrendAgent | ✅ Built (2026-04-01) | signal_weights.hook_trends |
| toneObjectiveFitAgent | ✅ Built (2026-04-01) | signal_weights.tone_objective_fit |
| postTypeCalendarAgent | ✅ Built (2026-04-01) | signal_weights.best_hours |

**Layer 2 — Comment Signal (what the audience says)**
| Agent | Status | Writes |
|-------|--------|--------|
| commentSentimentAgent | ✅ Built (2026-04-01) | signal_weights.comment_signals |
| ctaEffectivenessAgent | ✅ Built (2026-04-01) | signal_weights.cta_effectiveness |

**Layer 3 — Fatigue + External Signal**
| Agent | Status | Writes |
|-------|--------|--------|
| contentFatigueAgent | ✅ Built (2026-04-01) | signal_weights.content_fatigue |
| hashtagPerformanceAgent | Deferred | signal_weights.top_hashtags |
| platformAlgorithmAgent | Deferred | signal_weights.algorithm_alerts (cohort-wide) |

**Layer 4 — Predictive / Synthesis**
| Agent | Status | Uses |
|-------|--------|------|
| briefOptimizationAgent | Deferred | all signal_weights to recommend a brief |
| contentGapAgent | Deferred | comment trends + post history |

### How signal_weights flows into generation
1. signalWeightsWorker runs weekly per user → calls hookPerformanceAgent + toneObjectiveFitAgent
2. Both write multipliers to user_profiles.signal_weights
3. contextBuilder.buildSignalWeightsSection() reads and formats them
4. Injected as "WHAT WORKS FOR YOUR AUDIENCE" section in every LLM prompt
5. LLM naturally biases toward proven hook formats and tone+objective combos

### Subscription packaging tie-in
Signal weights data is a Starter+ feature gate. See [[DECISIONS]] 2026-04-01.

---

## Horizontal Scaling — Block Architecture (Deferred)

When user count approaches 8-9K, implement spoke-and-wheel block scaling. Each block = its own VPS + Redis + BullMQ workers, all sharing one Supabase DB. Workers filter queries by `shard_id` from `user_profiles` using a `SHARD_ID` env var. Adding a new block = deploy same Docker image with `SHARD_ID=2` — no code changes after initial setup. Full architecture, SQL, and deployment steps documented in [[feature-roadmap-handoff]] Section 10.

**Scale fixes already shipped (2026-04-01):** researchAgent skips inactive users + fresh cache; commentAgent + performanceAgent early-exit on no connections + process 5 users concurrently per batch. These handle ~10K users on a single block.

---

## Files You Should Never Modify Without Understanding

| File | Why |
|------|-----|
| `backend/middleware/auth.js` | JWT validation chain. Breaking this locks out all users. |
| `backend/middleware/tenancy.js` | Multi-tenancy isolation. Breaking this risks data leakage. |
| `backend/services/tokenEncryption.js` | Changing encryption logic breaks all stored OAuth tokens. |
| `backend/queues/index.js` | Queue definitions referenced by 8 workers. |
| `backend/server.js` (lines 50-90) | Webhook handlers must stay BEFORE `express.json()`. |
