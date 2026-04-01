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

- Date: 2026-03-29
- Decision: Reduce publish worker concurrency from 2 to 1
- Reason: Two overlapping processQueue() scans caused a race condition — both could pick up the same post, one sets it to 'publishing' while the other completes empty, leaving the post stuck with no publish logs. Concurrency 1 eliminates the race. Posts from different users still publish in parallel via Promise.allSettled inside a single scan.
- Impact: Slightly longer worst-case pickup time (up to 60s vs ~30s), but eliminates stuck-post failures entirely. Priority jobs with 2-second delay handle "Publish Now" within 3 seconds.

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

- Date: 2026-03-25
- Decision: Do NOT build a red team agent
- Reason: Operational monitoring (watchdog) covers 90% of production safety needs. Automated red teaming (adversarial probing for auth bypass, SQL injection, XSS, cross-tenant data access) is risky in production — could trigger rate limits, lock out real users, or corrupt data. The manual 18-issue security audit already covered OWASP top-10 vectors. If ever built, it should be staging-only, never production.
- Impact: Red team is deferred indefinitely. Watchdog (FEAT-015) handles real-time health. Security audits remain manual and per-session as needed.

---

- Date: 2026-03-26
- Decision: Cloudflare CSP conflict — handle at the edge, not the origin
- Reason: Cloudflare's reverse proxy modifies/overrides the CSP header our Express server sends. Three attempts to fix from the origin (whitelist domain, purge cache, add script-src-elem) did not resolve the issue. The Cloudflare beacon is injected at the edge, so CSP must be managed at the edge too.
- Impact: If the `scriptSrcElem` directive fix doesn't work, disable Cloudflare Web Analytics entirely (we don't use it — we have our own admin dashboard). Long-term, FEAT-016 adds a Cloudflare API integration to the admin dashboard for cache management. CSP for Cloudflare-injected scripts should be managed via Cloudflare Transform Rules, not Helmet.

---

- Date: 2026-03-25
- Decision: Always flag when a new feature or change might break existing functionality or increase costs
- Reason: User preference — avoid surprises. New features can have hidden costs (API calls, Redis memory, DB rows, LLM tokens) or break existing patterns (route ordering, queue concurrency, worker memory). Proactive flagging prevents deploy-day surprises.
- Impact: Claude must call out: (1) any new recurring API/LLM calls and their cost at scale, (2) any new DB tables/indexes and their storage impact, (3) any changes to shared files (queues, middleware, server.js) and what they could break, (4) any new Redis keys and their memory footprint. Do this before implementing, not after.

---

- Date: 2026-03-27
- Decision: platform_connections supports multiple Pages per platform per user (multi-page architecture)
- Reason: The old UNIQUE(user_id, platform) constraint meant connecting a new Facebook Page overwrote the old token. This broke DM automation for all existing posts because the DM worker used whatever token was currently stored, not the token for the Page the post was published to. Discovered when user reconnected to test the page picker and all DMs started failing.
- Impact: DB migration required (migration_multi_page_connections.sql — ran 2026-03-27). Every token lookup (publishingAgent, commentAgent, dmWorker) now uses pageId when available. Posts store platform_page_id at publish time. DM conversations store page_id at creation. Frontend settings page unchanged — shows first connection per platform (future: show all Pages with individual disconnect).

---

- Date: 2026-03-27
- Decision: Derive platform_page_id from platform_post_id as a fallback (Facebook post IDs are `{page_id}_{post_id}`)
- Reason: The multi-page migration backfill set wrong `platform_page_id` on existing posts because `platform_connections` already had the wrong Page's token at the time of the backfill. Need a way to derive the correct Page ID without relying on potentially stale data. Facebook's `platform_post_id` format embeds the Page ID before the underscore — this is authoritative.
- Impact: Code fallback in commentAgent and publishingAgent: if `platform_page_id` is null or doesn't match any connection, parse from `platform_post_id.split('_')[0]`. Also need SQL fix to correct the bad backfill on existing posts. ISSUE-023 tracks full resolution. Key lesson: never backfill from a table that might have stale data — derive from authoritative sources.

---

- Date: 2026-03-30
- Decision: Skip 4 of 12 scalability fixes — dashboard-trends (already per-user), axios keep-alive (risk of stale connections), webhook queueing (fast enough, would hurt DM latency), session cache TTL (already has 60-day TTL)
- Reason: Each was evaluated against the actual code. Dashboard-trends and session cache were already handled. Axios keep-alive and webhook queueing carry implementation risks that outweigh benefits at current scale. Monitor for port exhaustion (EADDRNOTAVAIL) and webhook timeouts as triggers to revisit.
- Impact: 8 of 12 fixes deployed. Deferred items documented as watch-for signals. No premature optimization.

---

- Date: 2026-04-01
- Decision: Build an expanding AI agent system organised into 4 layers, anchored by signal_weights JSONB in user_profiles
- Reason: The 22 brief categories (8 post types, 7 objectives, 7 tones) are currently static writing guides. No agent learns which combinations actually work per user. Performance data is already being collected — we just weren't closing the loop back into generation. signal_weights is the connective tissue: every learning agent writes multipliers there, contextBuilder reads them into every LLM prompt. The loop compounds — each week the brief gets smarter with no user input required.
- Impact: Four agent layers defined:
    Layer 1 (Performance Signal): hookPerformanceAgent, toneObjectiveFitAgent, postTypeCalendarAgent
    Layer 2 (Comment Signal): hookTrendAgent, commentTrendAgent, sentimentTrendAgent, ctaEffectivenessAgent
    Layer 3 (External Signal): hashtagPerformanceAgent, platformAlgorithmAgent
    Layer 4 (Predictive/Synthesis): briefOptimizationAgent, contentGapAgent
  Layer 1 (first two agents) built and shipped 2026-04-01. signal_weights JSONB added to user_profiles. contextBuilder now has a 10th section (signal_weights) injected into every brief prompt. Remaining agents deferred until signal_weights proves out.

---

- Date: 2026-04-01
- Decision: Agent performance data will anchor subscription tier packaging
- Reason: signal_weights + preflight panel data (tone/objective fit scores, hook format rankings, platform algorithm alerts) represents high-value differentiation. Showing users what's working vs. not is a premium insight — not a free feature. The Brief Preflight Panel (existing) + signal_weights warnings ("⚠️ humorous + conversions underperforms for your audience") maps cleanly to Starter+ gate.
- Impact: Tier gating plan: Free Trial gets post generation only. Starter gets basic preflight. Professional gets full signal_weights panel + hook rankings + combo warnings. Enterprise gets all agents including platformAlgorithmAgent (cohort-level intelligence). Exact tier mapping deferred until first two agents are validated in production.

---

- Date: 2026-03-26
- Decision: Anonymize comments on Meta data deletion instead of deleting them
- Reason: Comments are authored by third-party users (commenters), not the Page owner requesting deletion. They are public data that feeds our intelligence engine — sentiment analysis, research agents, cohort benchmarks. Deleting them would destroy irreplaceable research data and break agent functionality. The Page owner's personal data is in their OAuth tokens, DM conversations, and platform connections — not in other people's comments. Anonymization (null out author_handle, platform_comment_id, post_id) removes any link back to the Page while preserving the research value (comment text, sentiment, platform).
- Impact: Data deletion handler strips identifying fields from comments rather than deleting rows. Privacy policy Section 8 and Terms of Service Section 9 updated to explicitly disclose this practice. Intelligence engine continues to work after a user disconnects. Meta's requirement is satisfied — data tied to the user's account is removed, anonymous research data is retained.

---