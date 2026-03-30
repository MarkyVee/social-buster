# Social Buster — Feature Roadmap & Handoff

> **Last updated:** 2026-03-28
> **Purpose:** Quick-reference for any AI or developer picking up the project. For detailed history, see [[CHANGELOG]], [[ISSUES]], and [[platform_publishing_guide]].

---

## 1. Project Overview

**Social Buster** — enterprise-grade AI-powered social media marketing platform.

**Three core functions:**
1. **AI post generation** — brief → LLM generates hook/caption/hashtags/CTA per platform
2. **Comment-to-lead DM automation** — monitors comments for triggers, sends DMs, collects leads
3. **Auto-publishing** — scheduled/immediate publishing to social platforms

**Tech stack:** Node.js + Express, plain HTML/CSS/JS (no React), PostgreSQL via Supabase (RLS), BullMQ on Redis, Groq LLM, Cloudflare Workers AI for images, FFmpeg for video, Docker Compose → Coolify.

**Billing:** Free Trial → Starter ($29) → Professional ($49) → Buster ($89). 30-day rolling. Stripe fully working.

---

## 2. What's Built & Working (Summary)

| Area | Status |
|------|--------|
| Auth, multi-tenancy, RLS | Done |
| Brief system + AI generation + WYSIWYG previews | Done |
| Media library (Google Drive), AI images, video analysis, clip picker | Done |
| Facebook publishing (text, image, video) | Done |
| Instagram publishing (image, Reels) | Done |
| Facebook DM automation (single + multi-step + leads) | Confirmed working |
| Instagram DM automation (single + multi-step + leads) | Confirmed working (2026-03-28) |
| Comment ingestion (webhook + polling fallback) | Done |
| Intelligence: research agent, performance agent, cohort benchmarks, preflight panel | Done |
| Tier 1 premium: Performance Predictor, Pain-Point Miner, Brand Voice Tracker | Done |
| Shared context pipeline (`contextBuilder.js`) | Done |
| Admin dashboard (users, queues, messages, limits, revenue, email, plans) | Done |
| Tier limits (DB-driven, admin-configurable, frontend upgrade prompts) | Done |
| Stripe billing (subscribe, upgrade, downgrade, cancel, webhook, admin override) | Done |
| Help & Tutorials page | Done |
| In-app messaging (user-to-admin) | Done |
| Single session enforcement | Done |
| System watchdog (health monitoring, auto-pause, alerts) | Done |
| Data viz (Chart.js KPI cards, sparklines, doughnuts, bars) | Done |
| Privacy policy | Done (updated 2026-03-28) |
| Meta deauthorize + data deletion endpoints | Done |

---

## 3. Platform Status

| Platform | Publishing | DMs | OAuth | Notes |
|----------|-----------|-----|-------|-------|
| Facebook | Done | Done | Done | Fully working |
| Instagram | Done | Done | Via FB | Fully working (2026-03-28) |
| Threads | — | — | Blocked | ISSUE-021: Meta OAuth bug. "Coming Soon" |
| TikTok | — | — | — | Backend stubs exist. Deferred. |
| LinkedIn | — | — | — | Backend stubs exist. Deferred. |
| X (Twitter) | — | — | — | Backend stubs exist. Deferred. |
| YouTube | — | — | — | Backend stubs exist. Deferred. |

---

## 4. What's Next (Priority Order)

1. **Platform validation + content compliance** — Character counters for all platforms, image aspect ratio validation, centralized `platformSpecs.json` (active plan exists)
2. **Meta App Review** — `pages_messaging` + `instagram_manage_messages` need approval for non-admin users
3. **Remove diagnostic logging** — clean verbose DM/publishing logs
4. **Repost from Intelligence Dashboard** — not yet built
5. **Platform OAuth** — TikTok, LinkedIn, X, YouTube (deferred by user)

---

## 5. Feature Roadmap — Premium Features

### Tier 1 (Low Risk, High Impact — built on existing code)

| Feature | Status | Key Files |
|---------|--------|-----------|
| Performance Predictor | Done | `performancePredictorService.js`, `intelligence.js` |
| Audience Pain-Point Miner | Done | `painPointMinerService.js`, `pain-point-mining.md` |
| Brand Voice Tracker | Done | `brandVoiceService.js`, `brand-voice-analysis.md` |
| "Why This Will Work" Explainer | Done | Built into `llmService.js` generation |

### Tier 2 (Medium Effort — extends existing infrastructure)

| Feature | Description |
|---------|-------------|
| Niche Trend Forecaster | Google Trends + Reddit signals → auto content packs, First Mover Alerts |
| Algorithm-Aware Tuning | Dynamic platform rules from aggregated data, smart repurpose flow |
| Content Fatigue Detector | Flag declining engagement on repeated formats |
| Competitor Shadow Mode | Track public competitor accounts, surface what's working |

### Tier 3 (Bigger Lift — differentiation features)

| Feature | Description |
|---------|-------------|
| Multi-Persona Brainstorm | 4-6 AI personas debate topic, user picks winner |
| Accessibility Optimizer | Alt text, captions, reading level, WCAG scoring |
| Authenticity Shield | Bias scan, originality check, content fingerprint |
| Campaign Planner | Multi-post campaign sequences with narrative arc |

### Additional Ideas (backlog)

| ID | Feature | Priority |
|----|---------|----------|
| FEAT-016 | Cloudflare cache purge + CSP diagnostics from admin | Low |
| FEAT-018 | ADA/WCAG accessibility compliance | Medium |
| FEAT-019 | Admin OAuth Token Diagnostics Panel | Low |
| FEAT-020 | Admin Publishing Error Diagnostics | Medium |

---

## 6. Key Architecture Reference

### Backend Agents
| File | Purpose | Schedule |
|------|---------|----------|
| `publishingAgent.js` | Publish queue processor | Every 60s |
| `commentAgent.js` | Comment ingestion + DM triggers | Every 15min + realtime webhooks |
| `dmAgent.js` | DM state machine | Event-driven |
| `performanceAgent.js` | Platform metrics + cohort benchmarks | Every 2hr |
| `researchAgent.js` | LLM trend research | Weekly |
| `mediaAgent.js` | Cloud storage scan + video analysis queue | Every 30min |
| `mediaProcessAgent.js` | Copy media → Supabase at attach time | Event-driven |
| `watchdogAgent.js` | Health monitoring + auto-pause | Every 5min |

### 8 BullMQ Queues
`publish`, `comment`, `media-scan`, `media-analysis`, `media-process`, `dm`, `performance`, `research`

### Shared Context Pipeline
`contextBuilder.js` pulls 9 sections (profile, research, performance, cohort, comments, content_patterns, video_tags, pain_points, voice_profile) → injected into LLM prompts via `{{context_shared}}`. 1-hour Redis cache.

### Never-Modify Files
`middleware/auth.js`, `middleware/tenancy.js`, `services/tokenEncryption.js`, `queues/index.js`

---

## 7. Pending Items (Non-Feature)

- Meta App Review submission
- Age gating on brief target_audience
- Help section video tutorials (placeholder ready)
- Email sender name customization
- Anti-cloning / IP protection
- WhatsApp as 8th platform
- LinkedIn, TikTok, X, YouTube OAuth
- Privacy Policy URL → Meta Developer Portal (2 places)

---

## 8. Data Retention Policy

On account deletion or Meta access revocation:
- **DELETE:** Email, name, username, platform connections, tokens, DM conversations, lead data, automation configs
- **KEEP:** Anonymized aggregated metrics (engagement rates, cohort benchmarks, sentiment distributions) — these feed the collective intelligence engine and contain no identifying information
- Privacy policy Section 5 and Section 8 disclose this explicitly
