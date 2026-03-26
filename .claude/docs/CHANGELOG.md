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

## 2026-03-24

- Created `.claude/docs/` as shared Obsidian + Claude documentation system
- Created [[SYSTEM_OVERVIEW]], [[DECISIONS]], [[CLAUDE_STARTUP]]
- Logged first decision: use .claude/docs as single source of truth
