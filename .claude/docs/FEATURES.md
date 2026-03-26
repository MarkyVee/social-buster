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
- **Status:** planned
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

## Done

_(none yet)_