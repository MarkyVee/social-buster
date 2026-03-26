# Changelog

What was built, fixed, or shipped — logged per session.

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

## 2026-03-24

- Created `.claude/docs/` as shared Obsidian + Claude documentation system
- Created [[SYSTEM_OVERVIEW]], [[DECISIONS]], [[CLAUDE_STARTUP]]
- Logged first decision: use .claude/docs as single source of truth
