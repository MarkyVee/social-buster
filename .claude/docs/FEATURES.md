# Feature Backlog

Track feature ideas, requests, and enhancements as they come up during work.

## Format
- **ID:** FEAT-001
- **Date:** YYYY-MM-DD
- **Status:** idea | planned | in-progress | done | deferred
- **Description:**
- **Reason:**
- **Related:** (links to [[DECISIONS]] or [[ISSUES]] if relevant)

---

## HIGH PRIORITY — Build Now

- **ID:** FEAT-015
- **Date:** 2026-03-25
- **Status:** done
- **Priority:** HIGH
- **Description:** System Watchdog — Continuous Health Monitoring with Auto-Pause
- **Reason:** No way to detect runaway API loops, stuck queues, dead workers, or error spikes. Admin dashboard lacked diagnostic depth to trace problems to root cause.
- **Resolution:** Full watchdog system:
  - `system_events` + `system_state` DB tables for persistent event logging and pause state
  - `watchdogAgent.js` — computes 0-100 confidence score from 6 weighted signals (Redis, queues, errors, API rates, workers, DB), detects anomalies (growing backlogs, error spikes, API loops, dead workers), auto-pauses at score <30 for 2 consecutive checks
  - `watchdogWorker.js` + `watchdogQueue` — runs every 5 min via BullMQ
  - Worker instrumentation — all 9 workers now track job durations + error counts for the watchdog
  - Admin Watchdog tab: SVG confidence gauge, score breakdown bars, 24-hour trend chart, anomaly cards with resolve buttons, job duration stats, event log
  - Overview tab: watchdog confidence score in health banner, pause banner with resume button
  - Pause/resume system: auto-pause pauses all 6 processing queues, sends email alert; admin can manually pause/resume from dashboard
  - Email alerts on status transitions (healthy → degraded/critical → recovered)
  - 4 new admin API endpoints: GET /admin/watchdog, POST pause/resume/resolve
- **Files:** `backend/agents/watchdogAgent.js`, `backend/workers/watchdogWorker.js`, `backend/workers/index.js`, `backend/queues/index.js`, `backend/routes/admin.js`, `frontend/public/js/admin.js`, `backend/data/migration_system_events.sql`

---

- **ID:** FEAT-013
- **Date:** 2026-03-25
- **Status:** done
- **Priority:** HIGH
- **Description:** DM Automation Dashboard Data for Users
- **Reason:** Users need to see their DM automation results — conversations, lead data, response rates, conversion metrics — directly in their dashboard.
- **Resolution:** Built full DM dashboard with: conversion rate KPI, conversation funnel (completed/active/expired/opted_out/failed), 14-day trend chart, per-automation performance table with conversion rates, keyword performance table, daily DM usage bars (Facebook + Instagram), unified leads table. New backend endpoint `GET /automations/dashboard` computes all KPIs server-side. Also added `GET /automations/leads` to fix N+1 query issue. Main dashboard now shows DM conversion rate card.
- **Files:** `frontend/public/js/app.js`, `backend/routes/automations.js`

---

## Tier 1 — Build Next (Low Risk, High Impact, Uses Existing Code)

- **ID:** FEAT-001
- **Date:** 2026-03-25
- **Status:** planned
- **Description:** Pre-Post Performance Simulator with Virtual Audience Avatars
- **Reason:** Cohort data + preflight panel already exist. Predicts engagement before posting — confidence score + specific tweaks. Audience avatars simulate real reactions. Prevents content flops. Instant "wow" factor.
- **Effort:** 1-2 weeks
- **Files:** `llmService.js`, `intelligence.js`, `preview.js`, `performanceAgent.js`
- **Related:** [[feature-roadmap-handoff]] Feature 1

---

- **ID:** FEAT-002
- **Date:** 2026-03-25
- **Status:** planned
- **Description:** Audience Pain-Point Miner + Auto Content Generator
- **Reason:** Comment pipeline already ingests data. LLM clusters recurring questions/complaints from comments and DMs, auto-generates ready-to-post content in user's brand voice. Solves #1 creator pain: "what to post next."
- **Effort:** 1-2 weeks
- **Files:** `commentAgent.js`, `llmService.js`, `intelligence.js`
- **Related:** [[feature-roadmap-handoff]] Feature 5

---

- **ID:** FEAT-003
- **Date:** 2026-03-25
- **Status:** planned
- **Description:** Personal Brand Voice Evolution Tracker
- **Reason:** Posts and brand_voice field exist. AI continuously learns voice from approved posts, tracks how audience responds to shifts. Monthly "Voice Health Report" + evolution suggestions. No new infrastructure.
- **Effort:** 1-2 weeks
- **Files:** New `voiceAgent.js`, new `voiceWorker.js`, `llmService.js`, `app.js`
- **Related:** [[feature-roadmap-handoff]] Feature 8

---

- **ID:** FEAT-004
- **Date:** 2026-03-25
- **Status:** planned
- **Description:** "Why This Will Work" Explainer
- **Reason:** Single prompt enhancement. After AI generates a post, show WHY it will work: "This hook uses curiosity gap, which got 3.2x engagement for your cohort." Builds trust in AI. Lowest effort, highest trust impact.
- **Effort:** 2-3 days
- **Files:** `llmService.js`, `preview.js`
- **Related:** [[feature-roadmap-handoff]] Feature A

---

## Tier 2 — Build After Tier 1 (Medium Effort, Very Compelling)

- **ID:** FEAT-005
- **Date:** 2026-03-25
- **Status:** planned
- **Description:** Niche Trend Forecaster (1-2 Weeks Ahead)
- **Reason:** Research agent exists. Adds Google Trends + Reddit + RSS signals to predict what's about to explode in user's niche. Auto-generates 7-day content packs. "First Mover Alert" notifications. Users feel like they have a secret weapon.
- **Effort:** 2-3 weeks
- **Files:** `researchAgent.js`, new `trendService.js`, `intelligence.js`, `brief.js`, `researchWorker.js`
- **Related:** [[feature-roadmap-handoff]] Feature 2

---

- **ID:** FEAT-006
- **Date:** 2026-03-25
- **Status:** planned
- **Description:** Smart Repurpose Engine with Algorithm-Specific Tuning
- **Reason:** Platform rules + cohort data exist. Upload one long video/blog/podcast → AI rewrites hooks, changes pacing, tweaks length/tone per platform's CURRENT algorithm preferences (not static rules). Content fatigue detection built in.
- **Effort:** 2-3 weeks
- **Files:** `performanceAgent.js`, `llmService.js`, `briefs.js`, `brief.js`
- **Related:** [[feature-roadmap-handoff]] Feature 4

---

- **ID:** FEAT-007
- **Date:** 2026-03-25
- **Status:** planned
- **Description:** Content Fatigue Detector
- **Reason:** Performance agent already tracks metrics. Flags when same format/topic gets declining engagement. "You've posted 4 carousels about productivity — engagement dropped 18%. Try a Reel." Prevents creative stagnation.
- **Effort:** 1 week
- **Files:** `performanceAgent.js`
- **Related:** [[feature-roadmap-handoff]] Feature B

---

- **ID:** FEAT-008
- **Date:** 2026-03-25
- **Status:** planned
- **Description:** Competitor Shadow Mode
- **Reason:** Users add 3-5 competitor public accounts. Research agent pulls their public posts, analyzes what's working, surfaces insights. "Competitor X got 10x engagement on Y — want to create your take?" Extremely sticky — users check daily.
- **Effort:** 2-3 weeks
- **Files:** New `competitorAgent.js`, platform APIs (public data only)
- **Related:** [[feature-roadmap-handoff]] Feature C

---

## Tier 3 — Build When Core is Solid (Bigger Lift, Differentiation)

- **ID:** FEAT-009
- **Date:** 2026-03-25
- **Status:** planned
- **Description:** AI Co-Creation War Room (Multi-Persona Brainstorm)
- **Reason:** Solo creators burn out from idea drought. Open a brainstorm with AI teammates: "Trend Analyst," "Humor Genius," "Emotional Storyteller," "Data-Driven Optimizer." They debate your topic, reference past top posts, build campaigns. You can fire/promote personas. Turns creation into a team sport.
- **Effort:** 3-4 weeks
- **Files:** `llmService.js`, new `personas.js`, `briefs.js`, `brief.js`
- **Related:** [[feature-roadmap-handoff]] Feature 3

---

- **ID:** FEAT-010
- **Date:** 2026-03-25
- **Status:** planned
- **Description:** Eco-Impact & Accessibility Auto-Optimizer
- **Reason:** Auto alt-text, captions, color contrast, reading level scoring. One-click optimize without losing quality. Appeals to Gen Z, eco-conscious brands, ESG goals. Positions tool as the "responsible" choice.
- **Effort:** 2-3 weeks (v1: alt text + reading level. v2: full WCAG + video captions)
- **Files:** New `accessibilityService.js`, `llmService.js`, `preview.js`
- **Related:** [[feature-roadmap-handoff]] Feature 7

---

- **ID:** FEAT-011
- **Date:** 2026-03-25
- **Status:** planned
- **Description:** Authenticity + Inclusivity Shield with Originality Certificate
- **Reason:** In the 2026 AI flood, authenticity is premium currency. Scans for unintentional bias, cultural missteps, too-similar-to-viral content. Suggests fixes. Adds verifiable "Originality Certificate" (blockchain-style watermark). Protects reputation.
- **Effort:** 3-4 weeks (v1: LLM scan. v2: watermarking + embeddings)
- **Files:** `llmService.js`, `posts.js`, `preview.js`
- **Related:** [[feature-roadmap-handoff]] Feature 6

---

- **ID:** FEAT-012
- **Date:** 2026-03-25
- **Status:** planned
- **Description:** Campaign Planner (Multi-Post Sequences)
- **Reason:** Instead of one-off posts, plan multi-post campaigns: "Day 1 teaser, Day 2 BTS, Day 3 reveal, Day 4 testimonials, Day 5 offer." AI generates entire sequence with consistent narrative arc. High value for product launches and events.
- **Effort:** 3-4 weeks
- **Files:** New campaign data model, `briefs.js`, `brief.js`
- **Related:** [[feature-roadmap-handoff]] Feature D

---

- **ID:** FEAT-014
- **Date:** 2026-03-25
- **Status:** done (2026-03-28)
- **Priority:** HIGH (required before Meta App Review)
- **Description:** Privacy Policy Content Update
- **Reason:** Privacy policy needs to explicitly clarify several data handling practices before Meta App Review submission:
  1. **Media is not stored on our servers permanently** — media files (images, videos) are only held temporarily during the publishing process and are deleted immediately after. The only persistent media storage is in Supabase Storage buckets (cloud-hosted, not our servers). Clarify this distinction in Section 1c and Section 6.
  2. **Personal data is never shared** — strengthen the language. User data, post content, brand info, and lead data are never sold, shared, or made available to other users or third parties.
  3. **Credit card information stays on Stripe** — already stated in Section 1d and Section 6, but make it more prominent/explicit. We never see, process, or store any payment card details.
  4. **Aggregated/anonymized data disclosure** — Section 5 already covers this but should be clearer: performance metrics (engagement rates, posting times, content format effectiveness) may be anonymously compiled and compared across users to improve AI recommendations. No individual user, brand, post content, or PII is ever identifiable. Add specific examples of what IS and IS NOT included in aggregated data.
- **Files:** `frontend/public/privacy.html`
- **Related:** [[SYSTEM_OVERVIEW]], Meta App Review

---

## Backlog — Admin Tooling

- **ID:** FEAT-016
- **Date:** 2026-03-26
- **Status:** planned
- **Priority:** LOW
- **Description:** Cloudflare Cache Purge from Admin Dashboard
- **Reason:** After deploys, Cloudflare edge cache can serve stale CSP headers or old static files. Currently requires logging into Cloudflare dashboard manually. Admin should be able to purge cache with one click from the Admin Dashboard.
- **Implementation:** Use Cloudflare API (`POST /zones/{zone_id}/purge_cache` with `{"purge_everything": true}`). Requires `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_API_TOKEN` (with Cache Purge permission) in `.env`. Add a button to the admin Overview or Watchdog tab.
- **Files:** `backend/routes/admin.js`, `frontend/public/js/admin.js`
- **Related:** ISSUE-019 (stale cache incident), [[DECISIONS]]

---

## Backlog — UX / Data Visualization

- **ID:** FEAT-017
- **Date:** 2026-03-26
- **Status:** idea
- **Priority:** MEDIUM
- **Description:** Intelligence Data Visualization — parse AI text into visual representations
- **Reason:** Performance Intelligence, Niche Research, and AI summaries currently display as raw text/log dumps (pre-formatted blocks). Users need structured visuals: ranked trend lists, per-platform comparisons, key insight cards, best-time heatmaps. The current text walls are not actionable at a glance.
- **Implementation:** Parse LLM output into structured JSON (or prompt the LLM to return JSON), then render as charts, ranked lists, heatmaps, and insight cards instead of `<pre>` blocks.
- **Files:** `backend/services/llmService.js`, `backend/agents/performanceAgent.js`, `backend/agents/researchAgent.js`, `frontend/public/js/app.js` (Intelligence view)

---

- **ID:** FEAT-018
- **Date:** 2026-03-26
- **Status:** idea
- **Priority:** HIGH
- **Description:** ADA / WCAG Accessibility Compliance
- **Reason:** Platform needs to meet ADA (Americans with Disabilities Act) and WCAG 2.1 AA standards. Required for legal compliance in the U.S. and good practice for all users. Includes: proper ARIA labels, keyboard navigation, color contrast ratios, screen reader compatibility, focus management, alt text on images, form labels, skip navigation links.
- **Implementation:** Audit all frontend HTML/JS/CSS against WCAG 2.1 AA checklist. Key areas: sidebar navigation, form inputs, modal dialogs, chart accessibility (Chart.js has built-in a11y options), color contrast on status badges, focus trapping in overlays.
- **Files:** All frontend files (`index.html`, `app.js`, `styles.css`, `admin.js`, etc.)

---

## MEDIUM PRIORITY — Build Soon

- **ID:** FEAT-019
- **Date:** 2026-03-27
- **Status:** idea
- **Priority:** MEDIUM
- **Description:** Admin OAuth Token Diagnostics Panel — one-click button on each user profile (admin-only) to inspect their connected platform tokens. Shows: granular scopes (which Pages/Instagram accounts each permission covers), token expiry, and debug info from Meta's `/debug_token` endpoint. Read-only — no Meta approval risk.
- **Reason:** When users report connection issues, admin currently has to read server logs. This panel gives instant visibility into token health and scope coverage from the admin dashboard.
- **Related:** [[ISSUES]] ISSUE-022

---

- **ID:** FEAT-020
- **Date:** 2026-03-28
- **Status:** done (2026-03-29)
- **Priority:** HIGH
- **Description:** Admin Diagnostics & Maintenance Panel — publishing error diagnostics with categorized errors, one-click maintenance actions (reset stuck posts, expire stale DMs, retry failed posts).
- **Resolution:** New "Diagnostics" tab in admin dashboard with: KPI cards (failed 7d / stuck now / stale DMs), error category badges (Timeout, Video Processing, Token Expired, etc.), stuck posts table with reset button, failed posts table with retry button, maintenance actions (reset stuck, expire stale DMs). Backend: 4 new endpoints (GET /admin/diagnostics, POST reset-stuck, POST expire-stale-dms, POST retry-failed/:id). Error categorization via pattern matching on error_message — no new DB columns needed.
- **Files:** `backend/routes/admin.js`, `frontend/public/js/admin.js`
- **Meta App Review impact:** None — purely internal admin tooling.

---

---

- **ID:** FEAT-021
- **Date:** 2026-03-31
- **Status:** idea
- **Priority:** LOW
- **Description:** Admin cache-busting enforcement reminder — after each deploy, admins sometimes forget to bump the `?v=` version number on changed frontend JS/CSS files in `index.html`. This causes users to load stale cached files. Consider adding a visual checklist or warning in the admin Diagnostics tab reminding the deployer to bump version numbers after a JS/CSS deploy. The Cloudflare CDN purge button (added 2026-03-31) partially addresses this — purging the CDN cache forces fresh downloads even when the version number wasn't bumped — but the version bump is still the correct long-term fix.
- **Related:** [[DECISIONS]], [[FEAT-020]]

---

---

- **ID:** FEAT-022
- **Date:** 2026-04-01
- **Status:** planned
- **Priority:** MEDIUM
- **Description:** Platform availability gating — Preferred Platforms in My Profile shows "Coming Soon" for all platforms except Instagram and Facebook. When a platform's OAuth + publishing ships, remove it from the coming-soon list. Later, also gate by subscription tier (e.g. Free Trial = 2 platforms, Starter = 3, Professional = 5, Enterprise = all).
- **Current state:** TikTok, LinkedIn, X, Threads, WhatsApp, Telegram all show "(soon)" and are disabled in the profile form. Instagram + Facebook are fully active. Done in app.js v6 (2026-04-01).
- **Next step:** When a platform ships OAuth, remove it from the `comingSoon` exclusion in app.js (one line change). Then add tier-based caps to the Limits dashboard after core platforms are live.
- **Files:** `frontend/public/js/app.js` (platform-checkboxes map), `backend/routes/admin.js` (tier_limits table), `frontend/public/js/admin.js` (Limits tab)
- **Related:** [[FEAT-023]], [[feature-roadmap-handoff]] Section 4

---

- **ID:** FEAT-023
- **Date:** 2026-04-01
- **Status:** planned
- **Priority:** MEDIUM
- **Description:** Subscription-gated platform limits in Limits dashboard — admin can set max platforms per tier (e.g. Free=2, Starter=3, Professional=5, Enterprise=unlimited). Enforced in profile save + brief form platform selection. Users over the limit after a downgrade get a graceful "your saved platforms exceed your plan" banner.
- **Implementation:** Add `platforms` feature key to `tier_limits` table (already exists for other features). Frontend profile form already has `maxPlatforms` logic that reads from the limits check — just needs the DB row populated. Add to admin Limits tab editor.
- **Files:** `backend/routes/admin.js`, `frontend/public/js/app.js`, SQL seed for `tier_limits`
- **Related:** [[FEAT-022]]

---

- **ID:** FEAT-036
- **Date:** 2026-04-01
- **Status:** planned
- **Priority:** MEDIUM
- **Description:** Dark data — Industry trend forecasting (Tier 3 reveal)
- **Reason:** Google Trends + niche Reddit/RSS signals already in Tier 2 roadmap. Start collecting silently before the display is built. Marketing hook: "See what's trending in your niche this week."
- **What to collect:** Google Trends API + Reddit API signals per user's industry/niche tag. Store in research cache / new `trend_signals` table.
- **Visibility flag:** `industry_trend_forecasting` in tier_limits, is_globally_visible = false until ready.
- **Related:** [[DECISIONS]] 2026-04-01 (dark data strategy), FEAT-025

---

- **ID:** FEAT-035
- **Date:** 2026-04-01
- **Status:** planned
- **Priority:** MEDIUM
- **Description:** Dark data — Competitor benchmarking (Tier 3 reveal)
- **Reason:** Public competitor account data (post frequency, avg engagement, top content types) collected silently. Marketing hook: "Your competitors post 3x per week. Here's the gap."
- **What to collect:** Public posts + basic metrics from 2-3 competitor accounts per user (set during onboarding). Uses platform public APIs only — no scraping.
- **Visibility flag:** `competitor_benchmarks` in tier_limits, is_globally_visible = false until ready.
- **Related:** [[DECISIONS]] 2026-04-01 (dark data strategy)

---

- **ID:** FEAT-034
- **Date:** 2026-04-01
- **Status:** planned
- **Priority:** LOW
- **Description:** Dark data — Geographic audience clusters (Tier 3 reveal)
- **Reason:** Meta API already returns location data in post insights. Start storing it. Marketing hook: "65% of your audience is in the Southeast — are you speaking to them?"
- **What to collect:** Add geo fields to post_metrics (city, country, region) when fetching Facebook/Instagram insights. Already available in the API response.
- **Visibility flag:** `geographic_audience_clusters` in tier_limits, is_globally_visible = false.
- **Related:** [[DECISIONS]] 2026-04-01 (dark data strategy)

---

- **ID:** FEAT-033
- **Date:** 2026-04-01
- **Status:** planned
- **Priority:** MEDIUM
- **Description:** Dark data — Comment-to-lead funnel stages (Tier 1 reveal)
- **Reason:** Full funnel data already exists: post_comments → dm_conversations → dm_collected_data. Just needs a display layer. Marketing hook: "Your audience goes from comment → DM → lead in 4 minutes on average."
- **Data source:** All tables already populated. Zero new collection needed.
- **Visibility flag:** `comment_to_lead_funnel` in tier_limits, is_globally_visible = false.
- **Related:** [[DECISIONS]] 2026-04-01 (dark data strategy)

---

- **ID:** FEAT-032
- **Date:** 2026-04-01
- **Status:** planned
- **Priority:** LOW
- **Description:** Dark data — Seasonal engagement patterns (Tier 1 reveal)
- **Reason:** postTypeCalendarAgent uses a 60-day window. Extend to 90-180 days and add monthly bucketing. Marketing hook: "Q4 is your strongest quarter — your audience buys in November."
- **Data source:** posts + post_metrics already collected. Just needs longer window + monthly grouping in postTypeCalendarAgent.
- **Visibility flag:** `seasonal_patterns` in tier_limits, is_globally_visible = false.
- **Related:** [[DECISIONS]] 2026-04-01 (dark data strategy)

---

- **ID:** FEAT-031
- **Date:** 2026-04-01
- **Status:** planned
- **Priority:** LOW
- **Description:** Dark data — Audience response speed (Tier 1 reveal)
- **Reason:** post_comments.ingested_at vs posts.published_at already available. Time-to-first-comment is a strong signal for best posting windows. Marketing hook: "Your audience responds fastest on Tuesday mornings."
- **Data source:** post_comments.ingested_at (already stored) vs posts.published_at. Zero new collection.
- **Visibility flag:** `audience_response_speed` in tier_limits, is_globally_visible = false.
- **Related:** [[DECISIONS]] 2026-04-01 (dark data strategy)

---

- **ID:** FEAT-030
- **Date:** 2026-04-01
- **Status:** planned
- **Priority:** MEDIUM
- **Description:** Dark data — Hashtag performance (Tier 1 reveal)
- **Reason:** posts.hashtags[] and post_metrics.reach already stored. hashtagPerformanceAgent (already planned as deferred) just needs building. Marketing hook: "These 3 hashtags are pulling 40% of your reach."
- **Data source:** posts.hashtags + post_metrics. Zero new collection.
- **Visibility flag:** `hashtag_performance` in tier_limits, is_globally_visible = false.
- **Related:** [[DECISIONS]] 2026-04-01 (dark data strategy), feature-roadmap-handoff Section 5

---

- **ID:** FEAT-029
- **Date:** 2026-04-01
- **Status:** planned
- **Priority:** MEDIUM
- **Description:** Dark data — Viral coefficient trend (Tier 1 reveal)
- **Reason:** shares/reach ratio over time already derivable from post_metrics. Tracks whether content is gaining or losing shareability momentum. Marketing hook: "Your content is being shared more — momentum is building."
- **Data source:** post_metrics.shares + post_metrics.reach. Zero new collection.
- **Visibility flag:** `viral_coefficient` in tier_limits, is_globally_visible = false.
- **Related:** [[DECISIONS]] 2026-04-01 (dark data strategy)

---

- **ID:** FEAT-028
- **Date:** 2026-04-01
- **Status:** planned
- **Priority:** MEDIUM
- **Description:** Dark data — Cross-platform performance split (Tier 1 reveal)
- **Reason:** post_metrics already scoped per post which has a platform field. Compare Facebook vs Instagram engagement for the same user. Marketing hook: "Your Facebook posts outperform Instagram by 2x — here's why."
- **Data source:** posts.platform + post_metrics. Zero new collection.
- **Visibility flag:** `cross_platform_performance` in tier_limits, is_globally_visible = false.
- **Related:** [[DECISIONS]] 2026-04-01 (dark data strategy)

---

- **ID:** FEAT-027
- **Date:** 2026-04-01
- **Status:** planned
- **Priority:** MEDIUM
- **Description:** Dark data — DM conversion benchmarks vs cohort (Tier 1 reveal)
- **Reason:** dm_conversations already tracked per user. cohort_performance already aggregates by industry. Comparing a user's DM trigger rate vs cohort is a one-query reveal. Marketing hook: "How does your comment-to-DM rate stack up against others in your industry?"
- **Data source:** dm_conversations + cohort_performance. Zero new collection.
- **Visibility flag:** `dm_conversion_benchmarks` in tier_limits, is_globally_visible = false.
- **Related:** [[DECISIONS]] 2026-04-01 (dark data strategy)

---

- **ID:** FEAT-026
- **Date:** 2026-04-01
- **Status:** planned
- **Priority:** HIGH
- **Description:** Feature visibility admin control — `is_globally_visible` on tier_limits. Admin can hide any feature from all users regardless of tier (data still collected), then flip to visible to announce a new feature instantly without a code deploy. Separate "Feature Visibility" section in admin Limits tab. Dark data features default to is_globally_visible = false.
- **Files:** `migration_feature_visibility.sql` (run in Supabase), `backend/routes/admin.js` (PUT accepts is_globally_visible), `frontend/public/js/admin.js` v47 (visibility section with Live/Dark badges + toggle).
- **SQL to run:** `migration_feature_visibility.sql`
- **Related:** [[DECISIONS]] 2026-04-01 (dark data strategy), FEAT-027 through FEAT-036

---

- **ID:** FEAT-025
- **Date:** 2026-04-01
- **Status:** planned
- **Priority:** MEDIUM
- **Description:** Admin-injectable agent directives — per-agent, per-user prompt guidance editable from the admin dashboard.
- **What it is:** Admin writes free-text guidance (e.g. "Have you considered seasonal patterns?" / "What would it look like if video posts were weighted 1.5x?") stored in an `admin_agent_directives` table. Agents fetch their directive at run time and either inject it into the LLM prompt (LLM agents) or store it in signal_weights for contextBuilder to surface (math agents).
- **Scope:** Global directive (all agents, all users), per-agent directive (all users), per-user directive (one agent), per-user+per-agent (most targeted).
- **What needs building:**
  1. `admin_agent_directives` table migration (agent_name, user_id nullable, directive text, is_active, updated_at, updated_by)
  2. Uncomment real implementation in `agentDirectiveService.js`
  3. Admin UI: directive editor card per agent in admin dashboard (new "Agents" section, not a new tab — fits in existing Users or Watchdog tab)
  4. Admin: re-run agent for specific user button (triggers new signal-weights-user BullMQ job)
  5. Admin: reset signal_weights for specific user (clears JSONB, with confirm dialog)
- **Prerequisite:** Build all agents first. Admin UI should show all agents at once.
- **Files:** `backend/services/agentDirectiveService.js` (stub already wired into all agents), all agent files (hook already present), `backend/services/contextBuilder.js` (already reads agent_directive_* keys from signal_weights)
- **Related:** [[DECISIONS]] 2026-04-01 (admin directives), FEAT-024 (always collect agent data)

---

- **ID:** FEAT-024
- **Date:** 2026-04-01
- **Status:** planned
- **Priority:** HIGH
- **Description:** AI agent data collection runs for ALL users regardless of subscription tier. Agent intelligence (signal_weights, hook performance, tone/objective fit, cohort benchmarks, pain points, voice profile) is always collected in the background. Subscription tier only gates the DISPLAY of this data — not its collection. This ensures rich data exists the moment a user upgrades, with no cold-start delay.
- **Reason:** If we only run agents for paid tiers, free users who upgrade get a blank intelligence dashboard for the first week while agents backfill. That's a terrible upgrade experience. Always collect, selectively reveal.
- **Tier gating plan:**
  - Free Trial: post generation only. No intelligence dashboard access.
  - Starter: Basic preflight panel (cohort benchmarks, research summary).
  - Professional: Full signal_weights panel — hook rankings, tone/objective combo warnings, best posting times.
  - Enterprise: All agents including platformAlgorithmAgent (cohort-wide algorithm shift detection).
- **Files:** All agent files (no changes — they already run for all users). Gate only in `routes/intelligence.js` `checkLimit('intelligence_dashboard')` and frontend rendering.
- **Related:** [[DECISIONS]] 2026-04-01 (subscription packaging), [[feature-roadmap-handoff]] Section 10

---

## Done

_(none yet)_