# Changelog

What was built, fixed, or shipped — logged per session.

---

## 2026-03-31

- **FIXED ISSUE-027:** `tier_limits` RLS policy blocked auto-seed — table stayed empty, Limits tab showed nothing. Fixed policy to allow service role full access, manually seeded all 40 rows (10 features × 4 tiers) via Supabase SQL Editor. No redeploy.
- **FIXED ISSUE-028:** `system_events` + `system_state` tables missing — watchdog migration never ran. Ran `migration_system_events.sql` in Supabase. Watchdog tab now records health events. No redeploy.
- **FIXED ISSUE-026:** Platform-wide stale JS detection for all users — `APP_VERSION = 1` constant in `frontend/public/js/app.js` and `backend/server.js`. Public `GET /app-version` endpoint. `checkAppVersion()` fires after every login for every user. If the loaded JS doesn't match the server's version, a yellow "new version available — Refresh Now" banner appears in the main content area. Bumps app.js to v=48.
- **FIXED ISSUE-025:** Recurring stale admin JS — `?v=` not bumped after admin.js changes caused controls to silently disappear (happened 3x). Built a server-side version handshake: `ADMIN_JS_VERSION = 32` constant in both `backend/routes/admin.js` and `frontend/public/js/admin.js`. New `GET /admin/version` endpoint. `checkAdminJsVersion()` runs on every dashboard load — if stale, shows a sticky yellow banner with one-click "Purge Cache & Reload" (calls Cloudflare purge then hard-reloads). Future deploys: bump all three numbers together.
- **FEAT:** Admin Cloudflare CDN cache purge button — "🌐 Purge CDN Cache" in Diagnostics tab maintenance section. Calls `POST /admin/maintenance/purge-cache` → Cloudflare zone purge API. Requires `CLOUDFLARE_ZONE_ID` + `CLOUDFLARE_API_TOKEN` in `.env`.
- **FIXED:** clip picker end time ignored — `trim_end_seconds` was never saved, so `trimVideo` encoded to platform duration limit instead of clip end. 30s clip became 3-min upload → 413 from Facebook. Fix: save `trim_end_seconds` in clip picker, pass through publish pipeline, cap `outputDuration` to `(endTime - startTime)`.

---

## 2026-03-30

- **SCALABILITY:** 8-fix health check for 5,000 concurrent users:
  - Trust proxy (`trust proxy: 1`) — rate limiting now uses real client IP behind Cloudflare
  - Dashboard no longer loads all posts — uses lightweight count queries (`head: true`) + last 5 recent posts
  - `GET /posts` capped at 200 rows, `GET /briefs` capped at 100 rows
  - `/intelligence/performance` capped at 5,000 metric rows (was unbounded)
  - commentAgent paginated in 500-post batches (was loading ALL published posts from 30 days in one query)
  - Publish BATCH_CAP 50→100 with 10-user concurrency guard (prevents FFmpeg OOM)
  - DM worker limiter 10→30 jobs/min (daily per-user limits are the real safety net)
  - New index on `posts(platform_page_id)` — migration SQL created (**needs Supabase SQL Editor run**)
- **UX:** Cross-platform WYSIWYG sync — editing a field on one platform card auto-updates the matching card on other platforms. Link/unlink toggle per card. Only appears when 2+ platforms selected.
- **UX:** Non-active platforms (TikTok, LinkedIn, X, Threads, WhatsApp, Telegram) now show "Coming Soon" in the brief form, matching Settings & Billing.
- **DOCS:** Meta App Review guide finalized — added Instagram DM endpoint, updated status table, marked all features working.

---

## 2026-03-29

- **FIXED:** Publish race condition — concurrency 2 on publish worker caused overlapping scans that left posts stuck in 'publishing' with zero logs. Reduced to concurrency 1 (posts still publish in parallel within a scan).
- **FIXED:** Priority publish job race — "Publish Now" triggered immediate scan before DB write committed. Added 2-second delay.
- **FIXED:** FFmpeg hang — no timeout on video trim/re-encode. Added 3-minute kill timeout to both functions.
- **FIXED:** Stale recovery error message said "2 min" but timeout was 15 min. Corrected.
- **FEAT-020 DONE:** Admin Diagnostics & Maintenance panel — new tab with KPI cards (failed/stuck/stale DMs), error category badges, stuck posts reset, failed post retry, stale DM expiry, numbered order-of-execution guide.
- **UPDATED:** Privacy policy — added 3 missing Meta permissions, deauthorization callback handling, AI-suggestions-only clarification, webhook accuracy.
- **TRIMMED:** feature-roadmap-handoff.md from 1,250 → 130 lines.

---

## 2026-03-28

- **FIXED:** Instagram image container polling — was only polling video containers, causing error 9007 "media not ready". Now polls both images (3s intervals, 30s max) and videos (10s intervals, 5min max).
- **FIXED:** Instagram video re-upload — trimmed videos had local path but Instagram requires public URLs. Now re-uploads trimmed video to Supabase before publishing (same pattern as image crop re-upload).
- **FIXED:** Instagram comment field mismatch — `sendPrivateReply` diagnostic tried requesting `message` field on IG comments (error #100). Now tries IG fields first (`text,from,username`), falls back to FB fields.
- **FIXED:** Instagram DM endpoint — `sendPrivateReply` used `POST /{ig_user_id}/messages` for all platforms (error #3 on Instagram). Now routes: Instagram → `POST /me/messages`, Facebook → `POST /{page_id}/messages`.
- **BLOCKER FOUND & RESOLVED:** ManyChat was connected to @patriot_filming Instagram, intercepting comments/DMs before Social Buster. User disconnected ManyChat.
- **✅ CONFIRMED:** Instagram DM automation — full 3-step multi-step flow working end-to-end (trigger comment → name → zip → email → resource URL delivered). Both Facebook and Instagram DM automation now confirmed.

---

## 2026-03-27

- **FIXED ISSUE-022:** Meta Page picker only showed 4 of 9 authorized Pages. Root cause: `/me/accounts` only returns Pages where user is admin. Fix: cross-reference `debug_token` granular_scopes to find all authorized Page IDs, fetch missing ones individually. Permanent and automatic for all users.
- **ARCHITECTURE: Multi-Page Platform Connections** — `platform_connections` now supports multiple Pages per platform per user. Previous design (UNIQUE on user_id+platform) meant reconnecting with a different Page overwrote the old token, breaking DM automation for existing posts. New design:
  - Constraint changed to UNIQUE(user_id, platform, platform_user_id)
  - `posts.platform_page_id` tracks which Page each post was published to
  - `dm_conversations.page_id` tracks which Page each DM conversation belongs to
  - publishingAgent stores page_id on post after publishing
  - commentAgent + dmWorker look up token by specific pageId
  - All lookups fall back to most recent connection if no pageId (backward compatible)
  - Migration: `backend/data/migration_multi_page_connections.sql` (**ran in Supabase SQL Editor**)
- **FEAT-019 logged:** Admin OAuth Token Diagnostics Panel — one-click button on user profiles to inspect token health, granular scopes, and expiry (idea, not built yet).
- **Threads moved to "Coming Soon"** — ISSUE-021 (Meta OAuth bug) still unresolved.
- **TikTok, LinkedIn, X also marked "Coming Soon"** in frontend platform list.
- **BullMQ Redis fix:** `queues/index.js` now parses REDIS_URL when REDIS_HOST isn't set (Docker Compose compatibility).
- **Startup env check:** `server.js` accepts either REDIS_HOST or REDIS_URL (not both required).
- **ISSUE-023 OPENED:** DM automation broken after reconnecting Facebook. Multi-page architecture deployed but existing posts have wrong `platform_page_id` from bad backfill. Still needs: (1) fix backfill by deriving page_id from `platform_post_id`, (2) add code fallback to parse page_id from Facebook post ID format `{page_id}_{post_id}`, (3) clean stale DM conversations, (4) handle one-private-reply-per-comment error gracefully. See ISSUE-023 and DECISIONS.md for full details.

---

## 2026-03-26

- **BUGFIX:** DM multi-step automation — conversation marked completed when SENDING last question (`isFinalStep=true`), dropping the user's final reply. Fixed: only mark completed after RECEIVING the answer. Zip field was not being collected for Sharon's 3-step flow.
- **UX OVERHAUL:** Power BI-style data visualizations using Chart.js:
  - **Main Dashboard:** KPI cards with sparkline trends (7-day), delta arrows (▲/▼ vs yesterday), color-coded left borders
  - **DM Automations:** Doughnut chart (conversation funnel), bar chart (14-day trend), horizontal bar chart (keyword performance), rate gauge bars (automation table), field pills (leads table)
  - **Intelligence:** KPI cards (posts/likes/comments/reach/impressions), stacked bar chart (engagement by platform), doughnut chart (comment sentiment), chart-card styling throughout
  - New `GET /posts/dashboard-trends` endpoint for sparkline data
  - CSP updated for Chart.js CDN (cdn.jsdelivr.net)
  - Chart instance cleanup on view navigation (prevents canvas reuse errors)
- **FIXED ISSUE-019:** Cache-busting version on admin.js not bumped after watchdog commit (517 lines added). Broke frontend navigation. Bumped `?v=24` → `?v=25` in index.html. Added "Pre-Commit Rule: Don't Break What's Working" checklist to CLAUDE.md.
- **FIXED ISSUE-020:** Helmet CSP `useDefaults: true` includes hidden `scriptSrcAttr: ["'none'"]` that silently blocks ALL inline `onclick` handlers. Five-step debugging cascade: (1) whitelisted Cloudflare domain, (2) purged edge cache, (3) added `scriptSrcElem` — which made it WORSE by triggering the hidden default, (4) disabled Cloudflare Web Analytics, (5) set `useDefaults: false` in Helmet CSP — fixed. Documented as a landmine in CLAUDE.md.
- **Cloudflare Web Analytics disabled** — beacon was being auto-injected and conflicting with CSP. We have our own admin dashboard analytics.
- **FEAT-016 logged:** Cloudflare cache purge + CSP diagnostics from admin dashboard (backlog).
- **ADDED:** `backend/test-instagram-dm.js` — local webhook simulator for testing Instagram DM automation without a connected Instagram Business account. Signs payloads with FACEBOOK_APP_SECRET, interactive mode walks through published posts + automations, supports multi-step flow testing (comment → trigger → DM → reply → lead collection). CLI flags for quick one-off tests.

---

## 2026-03-25 (Session 2)

- **FIXED ISSUE-010:** Admin user detail — replaced fetch-all-rows post counting with parallel `{ count: 'exact', head: true }` queries per status. No more loading thousands of rows just to count them.
- **FIXED ISSUE-011:** performanceAgent — added cursor-based pagination (BATCH_SIZE=500) to both the main post fetch and cohort metric aggregation. Prevents loading 50K+ rows into memory.
- **FIXED ISSUE-012:** Per-account platform API rate limiting — two-layer Redis system: (1) mutex lock prevents simultaneous API calls to same user+platform (5 retries, 2s intervals), (2) daily counter with platform-specific limits (Instagram: 50/day, Facebook: 200/day, others: 100/day). Fails open if Redis is down.
- **FEAT-014:** Privacy policy content update — media not stored permanently, personal data never shared, credit card info on Stripe only, detailed aggregated data inclusions/exclusions. Updated `privacy.html`.
- **FEAT-015 DONE:** System Watchdog — full continuous health monitoring system:
  - New `watchdogAgent.js` — computes 0-100 health confidence score every 5 min from 6 signals (Redis, queues, errors, API rates, workers, DB)
  - Anomaly detection: API loop detection, growing queue backlogs, error spikes, dead worker alerts
  - Auto-pause: system automatically pauses all processing queues when confidence drops below 30 for 2 consecutive checks
  - `system_events` + `system_state` tables for persistent diagnostic logging and pause state
  - Worker instrumentation: all 9 workers now track job durations + error counts
  - Admin Watchdog tab: SVG confidence gauge, breakdown bars, 24-hour trend chart, anomaly cards with resolve, job duration stats, event log
  - Overview tab: health score in banner, pause banner with resume button
  - Email alerts on status transitions
  - Manual pause/resume controls from dashboard

---

## 2026-03-25

- Set up documentation system: [[DECISIONS]], [[ISSUES]], [[FEATURES]], [[CHANGELOG]]
- Added auto-logging rules to CLAUDE.md
- Connected Claude decisions to docs automatically
- Populated [[FEATURES]] with 12-feature roadmap (FEAT-001 through FEAT-012) organized into Tier 1/2/3
- Full security + scalability audit: 18 issues logged to [[ISSUES]] (4 critical security, 2 critical scalability, 6 high security, 3 high scalability, 3 medium)
- **FIXED ISSUE-001/002:** All 5 OAuth flows (Meta, Threads, TikTok, LinkedIn, X) now use cryptographic nonces instead of base64 userId. Prevents account hijacking via state injection.
- **FIXED ISSUE-003:** Webhook signature verification is now mandatory. Rejects all webhooks if app secret is not configured.
- **FIXED ISSUE-013:** LLM prompt injection defense — `sanitizeForPrompt()` strips role overrides, instruction resets, and prompt boundary attacks from user brief content.
- **FIXED ISSUE-008:** Created `migration_performance_indexes.sql` with 4 database indexes for scalability. **Needs to be run in Supabase.**
- **CLOSED ISSUE-009:** Won't fix — Idea Destroyer confirmed Supabase JS client is an HTTP wrapper, not a connection manager. Caching would add security risk for no real gain.
- **FIXED ISSUE-004:** Rate limiter now falls back to in-memory limiting when Redis is down (prevents brute force during outages)
- **FIXED ISSUE-005:** Logout now clears `active_session_id` from user_profiles
- **CLOSED ISSUE-014:** False positive — admin.js already escapes all user-controlled fields with `escapeAdminHtml()`
- **FIXED ISSUE-015:** DM reply text truncated to 2000 chars before DB insert (prevents data bloat)
- **PII FIX:** Removed `author_handle` from painPointMinerService.js SELECT (over-fetched, never used in LLM)
- **PII FIX:** Fixed contextBuilder.js — was querying non-existent `post_comments` table, corrected to `comments`
- **FEAT-013 DONE:** Full DM automation dashboard for users:
  - New `GET /automations/dashboard` endpoint — computes conversion rate, funnel, 14-day trend, per-automation performance, keyword performance, platform breakdown, avg completion time
  - New `GET /automations/leads` endpoint — single query for all leads (replaces N+1 per-automation loop)
  - Frontend: KPI cards (conversion rate, total convos, leads, avg completion, active automations), funnel bars, DM usage meters, 14-day trend chart, automation performance table with per-row conversion rates, keyword performance table, unified leads table
  - Main dashboard now shows DM conversion rate card
  - Fixed Express route ordering: `/leads` and `/dashboard` defined before `/:id` to prevent param collision
- **FIX:** contextBuilder.js `comments` table query used `created_at` instead of `ingested_at` — corrected
- **FIX:** migration_performance_indexes.sql referenced wrong table `post_comments` — corrected to `comments` with `ingested_at`
- **DB VERIFIED:** All migrations run in Supabase. 6 fixes applied (3 missing indexes, 2 RLS enables, 1 unique constraint). Full verification: 110 checks, all PASS.
- **COMMITTED:** Support tickets system (admin routes, user submission, migration SQL, frontend Issues tab)
- **COMMITTED:** `.obsidian/` added to `.gitignore`
- **FIXED ISSUE-006:** Rate limiting on all 6 OAuth callback endpoints (20 req/min per IP)
- **FIXED ISSUE-007:** Helmet CSP configured with proper directives + frameguard deny + noSniff + xssFilter
- **FIXED ISSUE-016:** OAuth cookies now have `Secure` flag in production (HTTPS-only)
- **FIXED ISSUE-017:** Startup env var validation — server exits immediately if required vars are missing
- **FIXED ISSUE-018:** Updated axios from 1.6.2 → 1.13.6 (fixes known CVEs)

## 2026-03-24

- Created `.claude/docs/` as shared Obsidian + Claude documentation system
- Created [[SYSTEM_OVERVIEW]], [[DECISIONS]], [[CLAUDE_STARTUP]]
- Logged first decision: use .claude/docs as single source of truth
