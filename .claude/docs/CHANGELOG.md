# Changelog

What was built, fixed, or shipped — logged per session.

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
