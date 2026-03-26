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
- [x] FEAT-013: DM automation dashboard — full KPIs, funnel, trends, keyword perf
- [x] ISSUE-001/002: OAuth state injection fixed (cryptographic nonces)
- [x] ISSUE-003: Webhook signature verification mandatory
- [x] ISSUE-004: Rate limit in-memory fallback
- [x] ISSUE-005: Logout clears active_session_id
- [x] ISSUE-008: Performance indexes (run in Supabase — DONE)
- [x] ISSUE-013: LLM prompt injection defense
- [x] ISSUE-015: DM reply text length validation
- [x] PII fixes: author_handle removed, contextBuilder table name fixed
- [x] Support tickets system (admin + user-facing)
- [x] Database fully verified — 110 checks, all PASS

### Blockers
- Meta App Review blocked until Instagram DM test passes

### Next Action
- [ ] Instagram DM automation test (read `platform_publishing_guide.md` DM debugging history first)
- [ ] Meta App Review submission
- [ ] Remaining open [[ISSUES]]: ISSUE-006 (OAuth callback rate limiting), ISSUE-007 (CSP/Helmet), ISSUE-010 (admin N+1), ISSUE-011 (performanceAgent pagination), ISSUE-012 (per-account API rate limiting), ISSUE-016 (OAuth cookie Secure flag), ISSUE-017 (env var validation), ISSUE-018 (outdated axios)

## How to Use This System

1. Write ideas and plans in these notes
2. Link related notes using [[note name]]
3. Claude auto-logs decisions, issues, features, and changelog entries — see CLAUDE.md "Documentation Rules"
4. Keep everything inside this folder as the single source of truth
