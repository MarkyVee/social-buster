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

## Done

_(none yet)_
