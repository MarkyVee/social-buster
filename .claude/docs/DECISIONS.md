# Decision Log

## Format
- Date:
- Decision:
- Reason:
- Impact:

---

## Decisions
- Date: 2026-03-24
- Decision: Use .claude/docs as the single source of truth for all documentation
- Reason: Keeps Obsidian, VS Code, and Claude all aligned with no duplication
- Impact: Cleaner system, easier to maintain, Claude has consistent context

---

- Date: 2026-03-25
- Decision: Claude auto-logs decisions, issues, features, and changelog to .claude/docs/ during every session
- Reason: Keeps documentation alive without manual effort. Obsidian renders it, Claude writes it, both stay in sync.
- Impact: Four living logs ([[DECISIONS]], [[ISSUES]], [[FEATURES]], [[CHANGELOG]]) always reflect current project state. Rules enforced via CLAUDE.md.

---

- Date: 2026-03-25
- Decision: Adopt R.A.I.L.G.U.A.R.D. framework for CLAUDE.md security posture
- Reason: Cloud Security Alliance framework designed for AI coding assistants. CLAUDE.md already covers 6 of 8 pillars organically. Need to add Uncertainty Disclosure and Auditability sections.
- Impact: Formalizes security reasoning into every Claude session. Two gaps to fill: (1) what Claude should do when unsure about a security decision, (2) logging/evidence trail for security-affecting changes.

---

- Date: 2026-03-25
- Decision: Use parallel sub-agents for research workflow, including an "Idea Destroyer" adversarial agent
- Reason: When stuck on a problem or evaluating an approach, run parallel agents: one researching, one building, and one actively trying to break the idea down. The Idea Destroyer argues against proposals, finds edge cases, and stress-tests assumptions — forcing better solutions through adversarial debate.
- Impact: Every non-trivial design decision gets stress-tested before implementation. Reduces wasted work from flawed assumptions. Claude should spin up an Idea Destroyer agent whenever evaluating architecture, feature design, or debugging approaches.

---

- Date: 2026-03-25
- Decision: Do NOT cache Supabase clients per JWT — current pattern is correct
- Reason: Idea Destroyer analysis. Supabase JS client is an HTTP wrapper (PostgREST), not a connection manager. Caching creates multitenancy security risks (token mixups, expired auth, shared request state) for negligible GC savings. PostgREST + Supavisor handle PostgreSQL connection pooling on Supabase's side. One fresh client per request is the recommended pattern.
- Impact: ISSUE-009 closed as wont-fix. Real scalability work should focus on query optimization (indexes, N+1 queries, pagination) not client object caching.

---

- Date: 2026-03-25
- Decision: Adopted 12-feature roadmap organized into 3 tiers (Tier 1: low risk/high impact first, Tier 3: bigger lifts last)
- Reason: All 8 user-sourced premium features + 4 additional ideas (A-D) already had implementation plans in [[feature-roadmap-handoff]]. Consolidated into [[FEATURES]] with IDs for tracking.
- Impact: FEAT-001 through FEAT-012 now tracked in [[FEATURES]]. Build order: Tier 1 (Performance Predictor, Pain-Point Miner, Voice Tracker, "Why This Works") → Tier 2 (Trend Forecaster, Repurpose Engine, Fatigue Detector, Competitor Mode) → Tier 3 (War Room, Accessibility, Authenticity, Campaigns).

---