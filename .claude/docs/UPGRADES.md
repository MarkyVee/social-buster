# UPGRADES

A running record of all major upgrades, fixes, and features built since development began.

---

## 1. Security Hardening (March 25)

### OAuth State Injection Prevention (ISSUE-001, ISSUE-002)
**Problem:** All 5 OAuth flows (Meta, Threads, TikTok, LinkedIn, X) used plain base64-encoded userId in the state parameter. An attacker could forge a state with another user's ID and hijack their account connection.
**Fix:** Replaced with cryptographic nonces stored in Redis. The callback now looks up the nonce to resolve the userId — the state parameter itself contains no user data. X/Twitter PKCE was also re-keyed from the untrusted state to the nonce.
**Files:** `backend/routes/publish.js` (Meta, Threads, TikTok, LinkedIn), `backend/routes/xOAuth.js` (X)

### Webhook Signature Verification (ISSUE-003)
**Problem:** Webhook signature verification was optional — webhooks would be accepted even without a valid signature if the app secret wasn't configured.
**Fix:** Made verification mandatory. All incoming webhooks are now rejected if the app secret is missing or the HMAC doesn't match.
**Files:** `backend/routes/webhooks.js`

### Rate Limiting Resilience (ISSUE-004)
**Problem:** Rate limiting relied entirely on Redis. If Redis went down, there was no rate limiting at all — brute force attacks were possible.
**Fix:** Added an in-memory fallback rate limiter that activates automatically when Redis is unavailable.
**Files:** `backend/middleware/rateLimit.js`

### OAuth Callback Rate Limiting (ISSUE-006)
**Problem:** No rate limiting on any of the 6 OAuth callback endpoints.
**Fix:** Added authLimiter (20 requests/minute per IP) to all OAuth callbacks.
**Files:** `backend/routes/publish.js`, `backend/routes/xOAuth.js`

### Helmet CSP Configuration (ISSUE-007, ISSUE-020)
**Problem:** Helmet Content Security Policy was either disabled or using `useDefaults: true` which silently included `scriptSrcAttr: ["'none'"]`, blocking ALL inline onclick handlers.
**Fix:** Set `useDefaults: false` with explicit CSP directives covering CDN sources (Chart.js, fonts), blob/data URIs for media, and our own domains.
**Files:** `backend/server.js`

### LLM Prompt Injection Defense (ISSUE-013)
**Problem:** User-submitted brief content was passed directly into LLM prompts with no sanitization. An attacker could inject role overrides or instruction resets.
**Fix:** Built `sanitizeForPrompt()` function that strips role override patterns, instruction resets, and prompt boundary attacks from all free-text fields before they reach the LLM.
**Files:** `backend/services/llmService.js`

### Session Cleanup on Logout (ISSUE-005)
**Problem:** Logging out didn't clear the `active_session_id` from user profiles, leaving ghost sessions.
**Fix:** Logout now clears `active_session_id`.
**Files:** `backend/routes/auth.js`

### OAuth Cookie Security (ISSUE-016)
**Problem:** OAuth cookies were missing the Secure flag in production, making them vulnerable over HTTP.
**Fix:** Added Secure flag for all OAuth cookies in production environments.
**Files:** `backend/routes/publish.js`

### DM Reply Length Limit (ISSUE-015)
**Problem:** DM reply text had no length limit, allowing unbounded data into the database.
**Fix:** Truncated to 2,000 characters before DB insert.
**Files:** `backend/workers/dmWorker.js`

### Startup Environment Validation (ISSUE-017)
**Problem:** Server would start with missing required environment variables, leading to silent failures later.
**Fix:** Server now validates 5 required env vars at boot and exits immediately if any are missing.
**Files:** `backend/server.js`

### Axios CVE Fix (ISSUE-018)
**Problem:** Outdated axios 1.6.2 had known CVEs.
**Fix:** Updated to axios 1.13.6.
**Files:** `package.json`

---

## 2. Scalability for 5,000+ Concurrent Users (March 25, 30)

### Admin Dashboard N+1 Queries (ISSUE-010)
**Problem:** Admin user detail page loaded ALL posts just to count them — would crash at scale.
**Fix:** Replaced with parallel `{ count: 'exact', head: true }` queries per status. Zero rows loaded.
**Files:** `backend/routes/admin.js`

### Performance Agent Memory (ISSUE-011)
**Problem:** `performanceAgent` loaded ALL posts from the last 30 days into memory for metrics calculation.
**Fix:** Added cursor-based pagination with `BATCH_SIZE=500` for both the main post fetch and cohort metric aggregation.
**Files:** `backend/agents/performanceAgent.js`

### Per-Account API Rate Limiting (ISSUE-012)
**Problem:** No rate limiting on outbound platform API calls — a user could burn through Instagram's daily limit in minutes.
**Fix:** Two-layer Redis system: (1) mutex lock prevents simultaneous API calls to the same user+platform, (2) daily counter with platform-specific limits (Instagram: 50/day, Facebook: 200/day). Fails open if Redis is down.
**Files:** `backend/services/platformAPIs.js`

### Database Performance Indexes (ISSUE-008)
**Problem:** Missing composite indexes on high-volume tables (posts, comments, metrics).
**Fix:** Created `migration_performance_indexes.sql` with 4 indexes. Run in Supabase SQL Editor.
**Files:** `backend/data/migration_performance_indexes.sql`

### Dashboard Query Optimization (March 30)
**Problem:** Dashboard loaded ALL posts for every user.
**Fix:** Lightweight count queries + limited to last 5 recent posts. `GET /posts` capped at 200, `GET /briefs` at 100, `/intelligence/performance` at 5,000 metric rows.
**Files:** `backend/routes/posts.js`, `backend/routes/briefs.js`, `backend/routes/intelligence.js`

### Comment Agent Pagination (March 30)
**Problem:** `commentAgent` loaded ALL published posts from 30 days in a single query.
**Fix:** Paginated in 500-post batches.
**Files:** `backend/agents/commentAgent.js`

### Publish Queue Tuning (March 30)
**Problem:** Publish batch cap too low (50) with no concurrency guard — FFmpeg OOM at scale.
**Fix:** Batch cap raised to 100 with a 10-user concurrency guard to prevent FFmpeg memory exhaustion.
**Files:** `backend/agents/publishingAgent.js`

### Trust Proxy (March 30)
**Problem:** Rate limiting saw Cloudflare's IP instead of the real client IP — all users shared one rate limit bucket.
**Fix:** `trust proxy: 1` in Express config.
**Files:** `backend/server.js`

---

## 3. Multi-Page Platform Architecture (March 27)

### Problem
Reconnecting with a different Facebook Page overwrote the old token (UNIQUE constraint on `user_id+platform`), breaking DM automation for all existing posts tied to the old Page.

### Fix
Complete architecture change:
- Constraint changed to `UNIQUE(user_id, platform, platform_user_id)` — supports multiple Pages per user
- `posts.platform_page_id` tracks which Page each post was published to
- `dm_conversations.page_id` tracks which Page each DM conversation belongs to
- Publishing agent stores `page_id` on post after publishing
- Comment agent + DM worker look up tokens by specific `pageId`
- All lookups fall back to most recent connection if no `pageId` (backward compatible)
- Migration: `migration_multi_page_connections.sql`

**Files:** `backend/agents/publishingAgent.js`, `backend/agents/commentAgent.js`, `backend/workers/dmWorker.js`, `backend/routes/publish.js`, `backend/data/migration_multi_page_connections.sql`

---

## 4. Meta Page Picker Fix (March 27 — ISSUE-022)

### Problem
Page picker only showed 4 of 9 authorized Pages because `/me/accounts` only returns Pages where the user has Admin role.

### Fix
Cross-reference `debug_token` `granular_scopes` to find all authorized Page IDs, then individually fetch any Pages missing from `/me/accounts`.

**Files:** `backend/routes/publish.js` (Meta OAuth callback)

---

## 5. DM Automation Fixes (March 25–28)

### DM Automation Dashboard (FEAT-013)
Built complete user-facing DM analytics: conversion rate, funnel, 14-day trend, per-automation performance, keyword performance, leads table.
New endpoints: `GET /automations/dashboard`, `GET /automations/leads`
**Files:** `backend/routes/automations.js`, `frontend/public/js/app.js`

### Instagram DM Automation (ISSUE-024, March 28)
5 bugs fixed: invalid `subscribed_apps` endpoint, comment field mismatch (`text` vs `message`), wrong DM endpoint (`/me/messages` not `/{id}/messages`), ManyChat intercepting webhooks, wrong OAuth scope names.
Full 3-step multi-step flow confirmed working: trigger comment → name → zip → email → resource URL delivered.
**Files:** `backend/services/messagingService.js`, `backend/workers/dmWorker.js`

### Facebook DM Realtime Path Fix (ISSUE-031, April 2)
**Problem:** Realtime webhook path silently dropped comments because Facebook `post_id` format (`{page_id}_{post_id}`) didn't match stored IDs (video posts store just the object ID).
**Fix:** 3-strategy fallback lookup — exact match → suffix match → most recent published post on page. Switched all queries from `.single()` to `.maybeSingle()`.
**Files:** `backend/agents/commentAgent.js`

### DM After Reconnect Fix (ISSUE-023)
**Problem:** After reconnecting Facebook, DMs broke because existing posts had wrong `platform_page_id` from a bad backfill.
**Fix:** Added `pageId` fallback, fixed backfill logic, cleaned stale conversations.
**Files:** `backend/agents/commentAgent.js`, `backend/workers/dmWorker.js`

---

## 6. Publishing Pipeline Fixes

### Instagram Image Hosting (ISSUE-035, April 2)
**Problem:** Cropped images re-uploaded to Supabase Storage, but Meta's CDN crawlers are blocked at the network level from fetching Supabase URLs → error 9004 "media could not be fetched."
**Fix:** Serve cropped images from our own server at `social-buster.com/temp-media/:uuid.jpg` (local temp directory, UUID filenames, auto-cleanup after publish).
**Files:** `backend/agents/publishingAgent.js`, `backend/server.js`

### Instagram Container Polling (March 28)
**Problem:** Only video containers were polled for readiness — image containers caused error 9007 "media not ready."
**Fix:** Added image container polling (3s intervals, 30s max) alongside existing video polling (10s intervals, 5min max).
**Files:** `backend/agents/publishingAgent.js`

### Instagram Video Re-Upload (March 28)
**Problem:** Trimmed videos had local file paths but Instagram requires public URLs.
**Fix:** Re-upload trimmed video to Supabase before publishing (same pattern as image crop re-upload).
**Files:** `backend/agents/publishingAgent.js`

### Instagram Connection Lookup Fix (ISSUE-033, April 2)
**Problem:** Publishing agent filtered by `platform_user_id = platform_page_id` to find the connection. But Instagram connections store the IG Business Account ID (different number from the Facebook Page ID) → "No account connected" error even though the account was connected.
**Fix:** Added fallback query for Instagram/Threads: if filtered lookup returns nothing, retry without the page ID filter.
**Files:** `backend/agents/publishingAgent.js`

### Publish Race Conditions (March 29)
**Problem:** Concurrency 2 on publish worker caused overlapping scans that left posts stuck in 'publishing'. "Publish Now" triggered before DB write committed.
**Fix:** Reduced to concurrency 1. Added 2-second delay for priority publish jobs.
**Files:** `backend/agents/publishingAgent.js`

### FFmpeg Timeout (March 29)
**Problem:** No timeout on video trim/re-encode — FFmpeg could hang indefinitely.
**Fix:** Added 3-minute kill timeout to both trim and re-encode functions.
**Files:** `backend/services/videoProcessor.js`

### Clip Picker End Time (March 31)
**Problem:** `trim_end_seconds` was never saved, so trimmed video encoded to the platform duration limit instead of the clip end. A 30s clip became a 3-minute upload → 413 from Facebook.
**Fix:** Save `trim_end_seconds` in clip picker, pass through publish pipeline, cap output duration to `(endTime - startTime)`.
**Files:** `frontend/public/js/app.js`, `backend/agents/publishingAgent.js`

### AI Generation 413 Fix (ISSUE-032, April 2)
**Problem:** Groq's `llama-3.1-8b-instant` has a 6,000 TPM limit. `max_tokens: 5120` + ~1,100 input = ~6,220 exceeded the limit. Groq returns 413 (not 429).
**Fix:** Reduced `max_tokens` from 5,120 to 2,048 (still sufficient for 3 posts × 3 options).
**Files:** `backend/services/llmService.js`

### Page-Specific Connection Lookup in Immediate Publish (April 5)
**Problem:** `POST /publish/:postId` used `.single()` without page-specific filtering — when multiple pages connected, the wrong connection could be selected.
**Fix:** Now queries `platform_page_id`/`platform_post_id` from the post first, derives the page ID, and filters `platform_user_id` accordingly before calling `.single()`.
**Files:** `backend/routes/publish.js`

---

## 7. Database & RLS Fixes (March 31 – April 1)

### Service Role RLS Policies (ISSUE-029 — CRITICAL)
**Problem:** `auth.role() = 'service_role'` pattern broken across ALL 15 tables. `supabaseAdmin` was blocked from writing anywhere — subscriptions, DMs, media, comments, etc. all silently failing.
**Fix:** Replaced every service role policy with `USING (true) WITH CHECK (true)`. Applied via Supabase SQL Editor.

### Tier Limits Auto-Seed (ISSUE-027)
**Problem:** RLS blocked the auto-seed of `tier_limits` — table stayed empty.
**Fix:** Fixed policy, manually seeded 40 rows (10 features × 4 tiers).

### System Events Migration (ISSUE-028)
**Problem:** `system_events` and `system_state` tables missing — watchdog migration never ran.
**Fix:** Ran `migration_system_events.sql` in Supabase.

---

## 8. Major Features Built

### System Watchdog (FEAT-015, March 25)
Full continuous health monitoring:
- 0-100 confidence score every 5 minutes from 6 signals (Redis, queues, errors, API rates, workers, DB)
- Anomaly detection: API loop detection, growing queue backlogs, error spikes, dead workers
- Auto-pause: system automatically pauses all queues when confidence drops below 30 for 2 consecutive checks
- Admin tab: SVG confidence gauge, breakdown bars, 24-hour trend, anomaly cards, event log
- Email alerts on status transitions

### Admin Diagnostics & Maintenance (FEAT-020, March 29)
- KPI cards (failed/stuck/stale DMs), error category badges
- Stuck posts reset, failed post retry, stale DM expiry
- Numbered order-of-execution guide

### Data Visualizations (March 26)
Power BI-style dashboards using Chart.js:
- Main dashboard: KPI cards with sparkline trends, delta arrows, color-coded borders
- DM automations: doughnut chart, bar chart, horizontal bar, rate gauge bars
- Intelligence: engagement by platform, comment sentiment, chart-card styling

### Stale JS Detection (ISSUE-025, ISSUE-026, March 31)
- Admin: `ADMIN_JS_VERSION` handshake with "Purge Cache & Reload" button
- All users: `APP_VERSION` constant checked after every login with "Refresh Now" banner

### Cross-Platform WYSIWYG Sync (March 30)
- Editing a field on one platform card auto-updates matching cards on other platforms
- Link/unlink toggle per card, only appears when 2+ platforms selected

### CDN Cache Purge (March 31)
- Admin button in Diagnostics tab → Cloudflare zone purge API
- Uses `CLOUDFLARE_ZONE_ID` + `CLOUDFLARE_API_TOKEN`

### Meta Business Login Support (April 5)
- OAuth start route checks for `META_CONFIG_ID` env var
- If set, uses Business Login flow (returns ALL pages in a Business Manager portfolio)
- Falls back to standard Facebook Login if not set
- **Note:** `META_CONFIG_ID` was later removed after testing revealed scope configuration issues with Meta's dashboard. Standard Facebook Login is the active flow.

### PAGE_ADMIN_REQUIRED Error UX (April 5)
- Detection helper in `platformAPIs.js` for Meta error codes 200, 10, and admin-related text
- Failed posts show "How to fix" button instead of raw error text
- Step-by-step modal explains how to get Admin role on the Facebook Page

### Connected Platforms Tip (April 5)
- Amber warning box: "If all Instagram or Facebook accounts do not show up when connecting, click Edit settings and select Opt into current pages only"

---

## 9. Known Open Issues

| ID | Category | Status | Summary |
|----|----------|--------|---------|
| ISSUE-021 | HIGH/Integration | open (Meta bug) | Threads OAuth returns "No app ID was sent" — moved to Coming Soon |
| ISSUE-034 | HIGH/Publishing | open | Instagram + Facebook API calls may require `appsecret_proof`. Fix: toggle "Require App Secret" OFF in Meta App Settings, or add HMAC proof to all API calls |

---

## 10. Architecture & Process Decisions

- **Protected files:** `middleware/auth.js`, `middleware/tenancy.js`, `services/tokenEncryption.js`, `frontend/public/index.html` — never modify without explicit permission
- **APP_VERSION:** Must bump in both `server.js` and `app.js` on any frontend change
- **Redis fallback:** In-memory fallback active for `meta_page_select:`, `oauth_nonce:`, `x_pkce:` keys (single-node only) — Redis periodically goes down in Coolify
- **Meta OAuth:** `granular_scopes.target_ids` never populated for standard Facebook Login (Meta API change) — ISSUE-022 fallback effectively dead
- **Deployment:** Production via Coolify + Cloudflare at social-buster.com. Development/editing in Replit.
- **No long-term file storage:** User media is not stored permanently (near-zero cost design at 10,000+ users)
