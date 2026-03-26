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

## 2026-03-24

- Created `.claude/docs/` as shared Obsidian + Claude documentation system
- Created [[SYSTEM_OVERVIEW]], [[DECISIONS]], [[CLAUDE_STARTUP]]
- Logged first decision: use .claude/docs as single source of truth
