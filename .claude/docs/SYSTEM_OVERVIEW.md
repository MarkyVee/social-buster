# Social Buster System Overview

## Quick Start
- [[CLAUDE_STARTUP]]

## Core Docs
- [[handoff]]
- [[feature-roadmap-handoff]]
- [[platform_publishing_guide]]

## Live Logs (auto-updated by Claude)
- [[DECISIONS]] — Architecture and design decisions
- [[ISSUES]] — Bugs, problems, blockers
- [[FEATURES]] — Feature ideas and backlog
- [[CHANGELOG]] — What was built per session

## Current Focus

### Completed This Session (2026-03-25)

**ALL 18 SECURITY ISSUES FROM AUDIT — CLOSED:**
- [x] ISSUE-001/002: OAuth state injection fixed (cryptographic nonces)
- [x] ISSUE-003: Webhook signature verification mandatory
- [x] ISSUE-004: Rate limit in-memory fallback
- [x] ISSUE-005: Logout clears active_session_id
- [x] ISSUE-006: OAuth callback rate limiting (authLimiter on all 6 callbacks)
- [x] ISSUE-007: Helmet CSP enabled (frameguard deny, noSniff, xssFilter)
- [x] ISSUE-008: Performance indexes (run in Supabase — DONE)
- [x] ISSUE-009: Won't fix (Supabase client pattern is correct)
- [x] ISSUE-013: LLM prompt injection defense (sanitizeForPrompt)
- [x] ISSUE-014: Won't fix (false positive — XSS already escaped)
- [x] ISSUE-015: DM reply text length validation
- [x] ISSUE-016: OAuth cookies Secure flag in production
- [x] ISSUE-017: Startup env var validation (exits with clear error)
- [x] ISSUE-018: axios updated 1.6.2 → 1.13.6

**Features + Fixes:**
- [x] FEAT-013: DM automation dashboard — KPIs, funnel, trends, keyword perf
- [x] PII fixes: author_handle removed, contextBuilder table/column name fixes
- [x] Support tickets system (admin + user-facing)
- [x] Database fully verified — 110 checks, all PASS
- [x] dmAgent error logging for collected data inserts

### Blockers
- Meta App Review blocked until Instagram DM test passes
- DM collected data not populating — needs log investigation after next test

### Scalability — ALL RESOLVED
- [x] ISSUE-010: Admin user detail — parallel count queries (no more row fetch)
- [x] ISSUE-011: performanceAgent paginated (BATCH_SIZE=500)
- [x] ISSUE-012: Per-account Redis rate limiting + mutex locks

### Next Action
- [ ] Update privacy policy content (FEAT-014 — media storage, data sharing, aggregated data clarity)
- [ ] Instagram DM automation test (read `platform_publishing_guide.md` first)
- [ ] Investigate DM collected data via Coolify logs after test
- [ ] Meta App Review submission

## How to Use This System

1. Write ideas and plans in these notes
2. Link related notes using [[note name]]
3. Claude auto-logs decisions, issues, features, and changelog entries — see CLAUDE.md "Documentation Rules"
4. Keep everything inside this folder as the single source of truth
