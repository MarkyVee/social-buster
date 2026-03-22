# Social Buster — Feature Roadmap & Full Handoff

> **Last updated:** 2026-03-21 (evening session)
> **Purpose:** Complete context document so any AI or developer can pick up exactly where we left off.
> Covers: what's built, what's in progress, what's next, and the full feature roadmap with implementation notes.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [What's Built & Working](#2-whats-built--working)
3. [What's In Progress](#3-whats-in-progress)
4. [What's Pending (Infrastructure)](#4-whats-pending-infrastructure)
5. [Feature Roadmap — 8 Premium Features](#5-feature-roadmap--8-premium-features)
6. [Additional Feature Ideas](#6-additional-feature-ideas)
7. [Implementation Priority Order](#7-implementation-priority-order)
8. [Key Architecture & Files Reference](#8-key-architecture--files-reference)
9. [Known Landmines](#9-known-landmines)
10. [Database Tables Reference](#10-database-tables-reference)
11. [Platform Publishing Status](#11-platform-publishing-status)
12. [Environment & Deployment](#12-environment--deployment)

---

## 1. Project Overview

**Social Buster** is an enterprise-grade AI-powered social media marketing platform.

**Three core functions:**
1. **AI post generation** — user submits a brief → LLM generates hook/caption/hashtags/CTA per platform, informed by research data and collective intelligence
2. **Comment-to-lead DM automation** — monitors post comments for trigger phrases, sends personalized DMs via Meta Graph API, collects leads
3. **Auto-publishing** — scheduled and immediate publishing to 7 social platforms

**Target:** 5,000 U.S. users. Every external dependency has an adapter layer — swapping providers means changing one file, not the codebase.

**Tech stack:** Node.js + Express, plain HTML/CSS/JS frontend (no React), PostgreSQL via Supabase (RLS), BullMQ on Redis, Groq LLM (OpenAI-compatible), Cloudflare Workers AI for images, FFmpeg for video, Docker Compose → Coolify deployment.

**Billing tiers:** Free Trial → Starter ($29/mo) → Professional ($49/mo) → Buster ($89/mo). 30-day rolling cycles. Stripe integration fully working (subscribe, upgrade, downgrade, cancel, webhook).

---

## 2. What's Built & Working

### Core Platform
- **Auth system** — Supabase Auth (email/password), JWT validation, token refresh, password recovery flow
- **Multi-tenancy** — RLS on every table, `req.db` (user-scoped) in routes, `supabaseAdmin` with `.eq('user_id')` in workers
- **Brief system** — Full form with niche, platforms, tone, post type, objective, semantic metadata (energy, pacing, mood profiles via `briefSemantics.js`)
- **AI post generation** — LLM generates 3 options per platform, informed by user profile, brand voice, research cache, and cohort intelligence
- **WYSIWYG post previews** — Per-platform mock-ups showing exactly how posts will render
- **Publishing queue** — Scheduling (date/time), status tracking, retry with exponential backoff, stale post recovery

### Media & Video
- **Media library** — Google Drive OAuth integration, file browsing and selection
- **AI image generation** — Cloudflare Workers AI (Flux Schnell), ~47 free images/day
- **Video analysis pipeline** — FFmpeg scene detection + audio energy analysis → `video_segments` table
- **Clip picker UI** — Visual segment selector with live analysis status badges
- **Media processing** — Two-phase: copy to Supabase at attach time, publish from Supabase URL (never from Drive)
- **Platform-specific optimization** — Auto-trim video to platform limits, image downsampling, codec re-encode (H.264/AAC)

### Publishing (Live)
- **Facebook** — Text, image, and video publishing via Graph API (multipart upload for video)
- **Instagram** — Image and video publishing via Reels (shares Facebook Page token)

### DM Automation
- **Comment ingestion** — Every 15 minutes via `commentWorker`, stored with sentiment analysis
- **Trigger matching** — Per-post trigger keywords matched against comment text
- **DM sending** — Meta Graph API (Facebook Messenger + Instagram DMs), rate-limited (100/day FB, 80/day IG)
- **Multi-step conversations** — State machine (active → collecting → completed/expired/opted_out)
- **Lead collection** — Email, phone, name, custom fields stored in `dm_collected_data`, exportable as CSV
- **Auto-CTA** — Trigger phrase automatically appended to post CTA at publish time
- **24-hour window enforcement** — Meta messaging policy respected

### Intelligence & Research
- **Research agent** — Weekly per-user LLM-generated niche/trend research, cached in Redis (7-day TTL)
- **Performance agent** — Polls platform metrics every 2 hours, builds per-user intelligence summary
- **Cohort benchmarking** — Aggregates performance across users with same industry/geo/platform/post_type
- **Preflight intelligence panel** — Blends 3 signals (own history, cohort, research) into recommendations shown before generation
- **Intelligence dashboard** — Frontend UI showing performance signals and posting recommendations

### Admin & Billing
- **Admin dashboard** — Tabs: Overview, Users, Queues, Messages, Limits, Revenue, Email, Plans
- **DB-driven plans editor** — Admin can edit plan names, prices, features, colors, Stripe price IDs without code changes
- **Tier limits editor** — DB-driven per-tier feature caps with toggle on/off (briefs/month, AI images/month, platforms, queue size, comment monitoring, DM/lead capture, intelligence dashboard)
- **Feature flag toggles** — Simple on/off for comment monitoring, DM & lead capture, intelligence dashboard per tier
- **Bulk email system** — Admin email campaigns via Resend (groups + campaigns)
- **In-app subscription management** — Plan cards, upgrade via Stripe Checkout, downgrade to free, cancel subscription (all working with Stripe)
- **Revenue tab** — Pulls prices from plans DB table
- **Health check system** — Quick (5min) + full (60min) checks, auto-remediation, email alerts

### Auth & Token Refresh
- **JWT-aware proactive refresh** — checks token expiry before every API call, refreshes if within 5 minutes of expiring
- **Shared refresh lock** — `refreshTokenOnce()` with subscriber queue prevents race conditions when multiple requests hit 401 simultaneously
- **`auth:expired` event** — logout/login screen rendering decoupled from `apiFetch` so catch blocks run first
- **No more silent 401s** — diagnostic logging on all refresh attempts

### Global Toast System
- **`#global-toasts`** container in `index.html` — lives outside `#app`, immune to all view re-renders
- **`showToast(message, type, duration)`** — fixed-position notifications (top-right) with slide-in animation
- **Used for all billing actions** — cancel, downgrade, change plan, upgrade errors, portal errors
- **`showAlert()`** still exists for in-page alerts where the container won't be re-rendered (OAuth results, platform connections, etc.)

### Background Workers (8 BullMQ Queues)
1. `publish` — Processes publishing queue every 60s
2. `comment` — Ingests comments every 15min
3. `media-scan` — Scans Google Drive every 30min
4. `media-analysis` — FFmpeg video analysis (concurrency: 1)
5. `media-process` — Copies media to Supabase at attach time
6. `dm` — Sends DMs + expires stale conversations
7. `performance` — Polls platform metrics every 2 hours
8. `research` — Weekly per-user trend research

---

## 3. What's In Progress

### Stripe Billing — WORKING (as of 2026-03-21 evening)
- **Working:** Subscribe (Stripe Checkout for free→paid), change plan (paid→paid with proration), cancel at period end, downgrade to free (immediate), Stripe customer portal
- **Working:** Webhook receives events correctly, `STRIPE_WEBHOOK_SECRET` confirmed working in Coolify
- **Working:** Plan cards UI, upgrade/downgrade/cancel buttons with loading states
- **Fixed this session:**
  - Webhook was overwriting `cancelling` status back to `active` — Stripe keeps status=`active` when `cancel_at_period_end=true`. Webhook now checks `cancel_at_period_end` and maps to `cancelling`. (commit `5fa5553`)
  - Billing success/error notifications were invisible — `showAlert` inserted into DOM that got rebuilt by `renderSubscriptionSection()`. Added global toast system (`#global-toasts` outside `#app`, `showToast()` function) that is immune to DOM re-renders. (commit `ad2a1f1`)
  - Downgrade-to-free confirmation now warns about losing credit and needing new payment to re-upgrade. (commit `0289131`)
  - Added loading states ("Cancelling...", "Changing...", "Downgrading...") to all billing buttons. (commit `af4e7a6`)
- **Not done:** Tier gating enforcement in backend routes (checking limits before allowing actions)

### Admin Limits Tab Bug
- **Issue:** Limits tab showed "No tier limits configured" when navigating away and back
- **Fix applied:** Moved `panel.dataset.loaded` flag to after successful data fetch (commit `f023bf4`)
- **Status:** Needs verification after next Coolify redeploy

---

## 4. What's Pending (Infrastructure)

These are non-feature items that need to be done for production readiness:

| Item | Priority | Notes |
|------|----------|-------|
| **Meta App Review** | HIGH | `pages_messaging`, `pages_read_engagement`, `instagram_manage_messages` scopes needed for production DM automation |
| **Meta webhook registration** | HIGH | Register `https://yourdomain.com/webhooks/meta` in Meta Developer Portal for multi-step DM replies |
| **Privacy Policy page** | HIGH | Required before Meta App Review. Page exists at `/privacy.html` but may need content review |
| **Tier limit enforcement** | HIGH | Backend `checkLimit` middleware exists but feature flags (comment_monitoring, dm_lead_capture, intelligence_dashboard) need wiring into routes |
| **Stripe end-to-end test** | DONE | Subscribe, upgrade, downgrade, cancel all tested and working. Webhook confirmed receiving events. |
| **LinkedIn OAuth** | MEDIUM | Stub exists, needs credentials + OAuth flow |
| **TikTok OAuth** | MEDIUM | Stub exists, needs credentials + OAuth flow |
| **X (Twitter) OAuth** | MEDIUM | Stub exists, needs credentials + OAuth flow |
| **YouTube OAuth** | MEDIUM | Stub exists, needs credentials + OAuth flow |
| **Threads OAuth** | MEDIUM | Scaffolded but redirect URIs are localhost — need real domain |
| **Single session enforcement** | LOW | Prevent account sharing via `active_session_id` on `user_profiles` |
| **Help section** | LOW | Written docs + video tutorials |
| **Tawk.to widget** | LOW | User-to-admin messaging |
| **WhatsApp** | LOW | 8th platform via WhatsApp Business API |
| **Email sender name** | LOW | Change from "Social Buster" to user's brand name |

---

## 5. Feature Roadmap — 8 Premium Features

These features go beyond what Canva, CapCut, Buffer, Jasper, or Hootsuite offer. They solve real creator pain points: creative burnout, guessing what performs, missing trends, feeling overwhelmed.

---

### Feature 1: Pre-Post Performance Simulator

**What it does:** Before posting, the AI predicts engagement (likes, comments, shares, watch time) using the user's real analytics + cohort data. Shows a confidence score + specific tweaks ("Shorten hook by 3 seconds for 18–24 demo"). Optional: build 5-10 audience avatars from analytics + public data to simulate reactions.

**What we already have:**
- Cohort benchmarking in `performanceAgent.js` (lines 254-503) — aggregates metrics across users with same industry/geo/platform/post_type
- Per-user performance summary (avg likes, reach, best hours, top hooks) cached at `intelligence:{userId}`
- Preflight intelligence panel (`routes/intelligence.js` lines 242-290) — blends own history + cohort + research
- `cohort_performance` DB table storing aggregated metrics

**What needs building:**
- **Prediction model** — Take cohort averages + user's own metrics + brief metadata (tone, post type, objective, platform) → estimate engagement range with confidence interval
- **Tweak suggestions** — LLM pass comparing draft against top-performing patterns in cohort ("Your hook is 8 seconds — top posts in your niche average 3.2 seconds")
- **UI** — "Predicted Performance" card on preview page showing estimated likes/comments/reach range + confidence score + actionable tweaks
- **Audience avatars** (v2) — Build persona profiles from user's actual follower demographics (requires platform API data)

**Files to modify:**
- `backend/services/llmService.js` — Add prediction prompt
- `backend/routes/intelligence.js` — New endpoint `GET /intelligence/predict` taking post draft + platform
- `frontend/public/js/preview.js` — Add prediction card to preview UI
- `backend/agents/performanceAgent.js` — Enhance cohort data with engagement percentiles

**Risk level:** LOW — builds directly on existing cohort infrastructure. No new external dependencies.

---

### Feature 2: Niche Trend Forecaster (1-2 Weeks Ahead)

**What it does:** AI predicts what's about to explode in the user's specific niche using multi-platform listening + external signals. Auto-generates 7-day content packs with hooks, visuals, and captions already optimized. "First Mover Alert" notifications.

**What we already have:**
- `researchAgent.js` — Weekly LLM-generated niche research per user
- Research prompt template (`research-agent.md`) guiding LLM to produce trend insights
- Research cache in Redis (`research:{userId}`, 7-day TTL) fed into post generation
- `briefSemantics.js` — Semantic profiles for post types, objectives, tones

**What needs building:**
- **External signal integration:**
  - Google Trends API (free, public) — trending searches in user's niche
  - Reddit public JSON feeds (`/r/{subreddit}/hot.json`) — emerging topics
  - RSS feeds for industry news
  - YouTube trending API (public)
- **Trend scoring** — Classify trends as emerging/peak/declining with velocity score
- **Content pack generation** — From top 3-5 emerging trends, auto-generate 3-5 pre-filled briefs (hook, tone, post type, platforms) ready to submit
- **First Mover Alerts** — Push notification or dashboard banner when a trend in user's niche starts accelerating
- **UI** — New "Trends" section on Intelligence dashboard with trend cards, velocity indicators, and "Create Post from This Trend" one-click

**Files to modify:**
- `backend/agents/researchAgent.js` — Add external API calls before LLM synthesis
- `backend/services/` — New `trendService.js` for Google Trends / Reddit / RSS
- `backend/routes/intelligence.js` — New endpoints for trends and content packs
- `frontend/public/js/brief.js` — "Start from trend" flow
- `backend/workers/researchWorker.js` — Increase frequency for trend checking (daily vs weekly)

**Risk level:** MEDIUM — new external API dependencies, but adapter pattern keeps it clean. Google Trends and Reddit are free/public.

---

### Feature 3: AI Co-Creation War Room (Multi-Persona Brainstorm)

**What it does:** Open a brainstorm session where specialized AI personas ("Trend Analyst," "Humor Genius," "Emotional Storyteller," "Data-Driven Optimizer") debate the user's topic, reference their past top posts, and build campaign ideas. User can pick which persona's take to develop.

**What we already have:**
- `llmService.js` — Single LLM generation producing 3 variants per platform
- Brief form with tone/post type/objective selections (`brief.js`)
- Semantic style injection (`briefSemantics.js`) combining style notes per selection
- Research cache and cohort data already available to inject into prompts

**What needs building:**
- **Persona definitions** — 4-6 predefined personas with distinct system prompts, writing styles, and priorities
- **Multi-shot generation** — Run parallel LLM calls (one per persona) with different system prompts but same brief context
- **Brainstorm UI** — Side-by-side persona cards showing each perspective's take. User can "promote" a persona's version to develop further
- **Campaign mode** (v2) — Personas collaborate to build a multi-post campaign (e.g., "Trend Analyst picks the topic, Humor Genius writes the hook, Storyteller crafts the narrative")
- **Custom personas** (v2) — Users can define their own persona profiles

**Files to modify:**
- `backend/services/llmService.js` — New `generatePersonaBrainstorm()` function with parallel LLM calls
- `backend/data/personas.js` — New file defining persona system prompts
- `backend/routes/briefs.js` — New endpoint for brainstorm generation
- `frontend/public/js/brief.js` — New "Brainstorm" button and persona selection UI

**Risk level:** MEDIUM — Multiple LLM calls increase cost and latency. Mitigate with parallel execution and clear cost display to user.

---

### Feature 4: Smart Repurpose Engine with Algorithm-Specific Tuning

**What it does:** Upload one long video/blog/podcast → AI doesn't just clip it. It rewrites hooks, changes pacing, adds platform-native effects, and tweaks length/tone based on each platform's current algorithm preferences.

**What we already have:**
- Platform-specific video limits in `ffmpegService.js` (TikTok 60s, Instagram 90s, etc.)
- Image resizing to platform specs
- Video trimming + codec re-encoding (H.264/AAC)
- Clip matching with energy/pacing/mood scores (`briefSemantics.js` lines 229-305)
- Per-platform writing rules in LLM prompts (`post-generation-platforms.md`)
- WYSIWYG per-platform preview (`preview.js`)

**What needs building:**
- **Algorithm awareness** — Track which formats/durations/hooks perform best per platform from our own aggregated user data (extend `cohort_performance`)
- **Dynamic platform rules** — Instead of static LLM prompt rules, pull "what's working now" from aggregated data ("Reels under 30s are getting 2.3x reach this week")
- **Smart repurpose flow** — Upload long-form content → AI identifies key moments → generates platform-specific versions with different hooks, pacing, length, CTA
- **Per-platform hook optimization** — "TikTok wants a pattern-interrupt hook in first 2s; LinkedIn wants data-first opening"
- **Content fatigue detection** — Flag when same format gets declining engagement, suggest variations

**Files to modify:**
- `backend/agents/performanceAgent.js` — Add algorithm trend tracking (avg duration of top posts per platform)
- `backend/services/llmService.js` — Inject dynamic platform recommendations
- `backend/routes/briefs.js` — New "repurpose" endpoint accepting long-form content
- `frontend/public/js/brief.js` — "Repurpose" tab/flow

**Risk level:** LOW-MEDIUM — Mostly extends existing infrastructure. Algorithm awareness derived from our own data, not external APIs.

---

### Feature 5: Audience Pain-Point Miner + Auto Content Generator

**What it does:** Scans comments, DMs, mentions across all linked accounts. Surfaces real audience frustrations ("I keep seeing this question about X") and auto-generates ready-to-post content in the user's brand voice.

**What we already have:**
- Comment ingestion every 15min via `commentAgent.js`
- Sentiment analysis (keyword-based: positive/neutral/negative)
- Comments stored with author, text, sentiment, platform in `post_comments` table
- Trigger phrase matching for DM automation
- Intelligence dashboard showing recent comments with sentiment counts

**What needs building:**
- **Theme clustering** — LLM pass over recent comments (last 30 days) to group by topic/theme/question
- **Pain-point extraction** — Identify recurring questions, complaints, feature requests, objections
- **Auto-brief generation** — Turn top 3-5 pain points into pre-filled briefs ("Your audience keeps asking about X — here's a carousel idea")
- **Trend tracking** — Is a pain point growing or shrinking? New this week?
- **UI** — New "Audience Insights" tab on Intelligence dashboard with theme cards, trend indicators, and "Create Post" buttons
- **Semantic sentiment** (upgrade from keyword-based) — LLM-powered nuanced sentiment analysis

**Files to modify:**
- `backend/agents/commentAgent.js` — Add theme clustering pass after ingestion
- `backend/services/llmService.js` — New `clusterCommentThemes()` and `generateFromPainPoint()` functions
- `backend/routes/intelligence.js` — New endpoint for pain-point themes
- `frontend/public/js/` — New intelligence sub-view for audience insights

**Risk level:** LOW — Builds on existing comment pipeline. LLM cost is the main consideration (batch comments to minimize calls).

---

### Feature 6: Authenticity + Inclusivity Shield

**What it does:** Before posting, AI scans for unintentional bias, cultural missteps, or too-similar-to-viral content. Suggests fixes and adds an "Originality Certificate."

**What we already have:**
- LLM-generated posts (inherit model's built-in safety)
- Nothing else in this area

**What needs building:**
- **Bias/sensitivity scan** — Additional LLM pass with a specialized prompt checking for stereotypes, cultural insensitivity, exclusionary language
- **Originality check** — Compare generated text against user's own past posts (embedding similarity) + optionally against a web plagiarism API
- **Fix suggestions** — Specific rewrites for flagged issues
- **Originality score** — 0-100 novelty rating
- **Content fingerprint** (v2) — Invisible watermark on images for copyright proof
- **UI** — "Safety Check" panel on preview page with flags, suggestions, and originality score

**Files to modify:**
- `backend/services/llmService.js` — New `runSafetyCheck()` function
- `backend/routes/posts.js` — New endpoint for on-demand safety check
- `frontend/public/js/preview.js` — Safety check card in preview UI

**Risk level:** LOW for LLM-based checks. MEDIUM-HIGH for watermarking (requires image processing library). Consider phasing: v1 = LLM scan only, v2 = watermarking.

---

### Feature 7: Eco-Impact & Accessibility Auto-Optimizer

**What it does:** Every piece of content gets scored for accessibility (alt text, captions, color contrast, reading level). One-click optimization. Optional eco-footprint scoring.

**What we already have:**
- Image downsampling (`ffmpegService.js` — Lanczos filtering to 2048px max)
- Video codec optimization (H.264/AAC, ultrafast preset)

**What needs building:**
- **Alt text generation** — LLM vision model generates descriptive alt text for all images
- **Video caption generation** — Whisper API or similar for auto-transcription → SRT/VTT captions
- **Reading level scoring** — Flesch-Kincaid / Gunning Fog index on generated text (no API needed, pure math)
- **Color contrast check** — Analyze image for WCAG AA/AAA compliance (requires image analysis)
- **One-click optimize** — Simplify language, add alt text, compress media
- **Accessibility score** — Composite 0-100 rating
- **UI** — "Accessibility" card on preview page with score breakdown and fix buttons

**Files to modify:**
- `backend/services/` — New `accessibilityService.js`
- `backend/services/llmService.js` — Add alt text generation prompt
- `frontend/public/js/preview.js` — Accessibility card in preview UI

**Risk level:** LOW for reading level + alt text. MEDIUM for video captions (new API dependency). HIGH for color contrast (image analysis).

---

### Feature 8: Personal Brand Voice Evolution Tracker

**What it does:** AI continuously learns the user's voice from approved posts. Tracks how audience responds to voice shifts. Monthly "Voice Health Report" with evolution suggestions.

**What we already have:**
- Static `brand_voice` field in `user_profiles` table
- Brand voice fed to LLM generation prompts
- Tone selection in brief form with semantic profiles
- Performance metrics per post

**What needs building:**
- **Voice profiling** — LLM analysis of user's last 50 approved posts to build a detailed voice fingerprint (vocabulary complexity, sentence structure, emotional range, humor level, formality)
- **Consistency scoring** — Compare each new generated post against the voice fingerprint
- **Audience response correlation** — Track engagement changes when voice shifts (e.g., "Posts where you're more vulnerable get 40% more comments")
- **Monthly Voice Report** — Automated analysis showing voice evolution, audience response, and recommendations
- **Voice comparison** — Compare against cohort average voice profile
- **UI** — New "Brand Voice" section in Settings or Intelligence dashboard

**Files to modify:**
- `backend/agents/` — New `voiceAgent.js` for periodic voice analysis
- `backend/workers/` — New `voiceWorker.js` (monthly schedule)
- `backend/services/llmService.js` — Voice profiling and consistency prompts
- `frontend/public/js/app.js` — Voice report UI in Settings

**Risk level:** LOW — Pure LLM analysis on existing data. No new external dependencies.

---

## 6. Additional Feature Ideas

These emerged from analyzing the codebase capabilities and creator pain points:

### A. "Why This Will Work" Explainer
After AI generates a post, show a brief explanation: "This hook uses the curiosity gap pattern, which got 3.2x engagement for your cohort on Instagram. The CTA matches your top-performing format." Makes the AI feel trustworthy, not magic. **Low effort** — add an explanation field to the LLM generation prompt and display it alongside each option.

### B. Content Fatigue Detector
Flag when a user keeps posting the same format/topic and engagement is declining. "You've posted 4 carousels about productivity this month — engagement dropped 18%. Try a Reel or a personal story." **Medium effort** — extend `performanceAgent.js` to track format/topic frequency and engagement trends. We already have the post history and metrics.

### C. Competitor Shadow Mode
Let users add 3-5 competitor public accounts. The research agent pulls their public posts, analyzes what's working, and surfaces insights: "Competitor X just got 10x engagement on a post about Y — want to create your take?" **Medium effort** — new `competitorAgent.js` that fetches public posts via platform APIs. Legal (public data only), extremely sticky feature.

### D. Campaign Planner
Instead of one-off posts, let users plan multi-post campaigns: "Product launch week: Day 1 teaser, Day 2 behind-the-scenes, Day 3 reveal, Day 4 testimonials, Day 5 offer." AI generates the entire sequence with consistent narrative arc. **Medium effort** — new campaign data model + UI, but generation logic extends existing brief system.

---

## 7. Implementation Priority Order

### Tier 1 — Build Next (Low Risk, High Impact, Uses Existing Code)

| # | Feature | Effort | Why First |
|---|---------|--------|-----------|
| 1 | **Performance Predictor** | 1-2 weeks | Cohort data + preflight panel already exist. Just needs prediction prompt + UI card. Instant "wow" factor. |
| 5 | **Audience Pain-Point Miner** | 1-2 weeks | Comment pipeline already ingests and stores data. LLM clustering is one function. Solves "#1 creator pain: what to post." |
| 8 | **Brand Voice Tracker** | 1-2 weeks | Posts and brand_voice field exist. Monthly LLM analysis on existing data. No new infrastructure. |
| A | **"Why This Will Work" Explainer** | 2-3 days | Single prompt enhancement + one UI element. Builds trust in AI recommendations. |

### Tier 2 — Build After Tier 1 (Medium Effort, Very Compelling)

| # | Feature | Effort | Why Second |
|---|---------|--------|------------|
| 2 | **Trend Forecaster Upgrade** | 2-3 weeks | Research agent exists. Adding Google Trends + Reddit signals makes research dramatically better. Auto content packs = killer feature. |
| 4 | **Algorithm-Aware Tuning** | 2-3 weeks | Platform rules + cohort data exist. Making rules dynamic from aggregated data is a natural extension. |
| B | **Content Fatigue Detector** | 1 week | Performance agent already tracks metrics. Just needs frequency/trend analysis layer. |
| C | **Competitor Shadow Mode** | 2-3 weeks | New agent but uses existing patterns. High stickiness — users check daily. |

### Tier 3 — Build When Core is Solid (Bigger Lift, Differentiation)

| # | Feature | Effort | Why Third |
|---|---------|--------|-----------|
| 3 | **Multi-Persona Brainstorm** | 3-4 weeks | Most visible "wow" feature but needs new UI paradigm. Multiple parallel LLM calls = higher cost. |
| 7 | **Accessibility Optimizer** | 2-3 weeks | Alt text + reading level are quick wins. Full WCAG is bigger. Great for brand differentiation. |
| 6 | **Authenticity Shield** | 3-4 weeks | Most complex. Plagiarism detection needs external API or embeddings. Save for later unless brand differentiator. |
| D | **Campaign Planner** | 3-4 weeks | New data model + UI. High value but not urgent — single posts are the core flow. |

---

## 8. Key Architecture & Files Reference

### Backend Agents (Business Logic)
| File | Purpose | Runs |
|------|---------|------|
| `publishingAgent.js` | Core publish logic + retry | Every 60s via publishWorker |
| `mediaProcessAgent.js` | Copy media → Supabase at attach time | On media attach (event-driven) |
| `commentAgent.js` | Comment ingestion + DM trigger matching | Every 15min via commentWorker |
| `dmAgent.js` | DM state machine (single + multi-step) | Event-driven via dmWorker |
| `mediaAgent.js` | Cloud storage scanning + video analysis queueing | Every 30min via mediaWorker |
| `researchAgent.js` | LLM trend research, cached in Redis | Weekly via researchWorker |
| `performanceAgent.js` | Platform metrics + cohort benchmarking | Every 2hr via performanceWorker |

### Backend Services (External Integrations)
| File | Purpose |
|------|---------|
| `llmService.js` | OpenAI-compatible LLM wrapper (Groq default) |
| `platformAPIs.js` | publish(), fetchMetrics(), fetchComments() for all platforms |
| `messagingService.js` | DM sending via Meta Graph API |
| `ffmpegService.js` | Video probe, trim, download, platform limits |
| `imageGenerationService.js` | Cloudflare Workers AI image generation |
| `googleDriveService.js` | Drive OAuth + authenticated download |
| `stripeService.js` | Stripe billing operations |
| `supabaseService.js` | Supabase admin client (service role) |
| `tokenEncryption.js` | AES-256-GCM for OAuth token storage |
| `redisService.js` | Cache get/set/del wrappers |
| `videoAnalysisService.js` | FFmpeg scene detection → video_segments |
| `visionTaggingService.js` | LLM visual tagging of segments |
| `alertService.js` | SMTP email alerts for health checks |

### Frontend JS Files
| File | Purpose |
|------|---------|
| `app.js` | Shell, auth, routing, settings, subscription UI, global toast system, token refresh |
| `brief.js` | Brief form + AI generation flow |
| `preview.js` | WYSIWYG post preview + DM automation panel |
| `publish.js` | Publishing queue UI, OAuth connect/disconnect |
| `media.js` | Media library, clip picker, AI image gen |
| `messages.js` | User inbox |
| `admin.js` | Admin dashboard (overview, users, queues, messages, limits, revenue, email, plans) |

### Key Data Files
| File | Purpose |
|------|---------|
| `briefSemantics.js` | Energy/pacing/mood profiles per post type, objective, tone. Clip matching scores. |
| `prompts/research-agent.md` | System + user prompt for research generation |
| `prompts/post-generation-*.md` | Platform-specific and general post generation prompts |

### Files You Must Never Modify
| File | Why |
|------|-----|
| `middleware/auth.js` | JWT validation. Breaking locks out all users. |
| `middleware/tenancy.js` | Multi-tenancy isolation. Breaking leaks data. |
| `services/tokenEncryption.js` | Changing breaks decryption of all OAuth tokens. |
| `queues/index.js` | Queue defs referenced by 8 workers. Wrong changes break all background jobs. |

---

## 9. Known Landmines

These are hard-won lessons. Every item here caused a real bug or hours of debugging. Do not ignore them.

1. **Never download media from Drive at publish time.** Media MUST be copied to Supabase at attach time. Publishing worker uses Supabase URLs only.
2. **Google Drive `webViewLink` is NOT a download URL.** Returns HTML. Use `downloadGoogleDriveFile()` which calls `drive.files.get({alt: 'media'})`.
3. **`supabaseAdmin` vs `req.db`** — Routes use `req.db` (auto-scoped). Workers use `supabaseAdmin` with explicit `.eq('user_id', userId)`.
4. **BullMQ requires `maxRetriesPerRequest: null`** — Set in `queues/index.js`. Removing crashes all workers.
5. **Meta/Stripe webhooks mounted BEFORE `express.json()`** — Raw body needed for signature verification.
6. **Platform stubs intentionally throw** — TikTok, LinkedIn, X, Threads, YouTube. Don't "fix" by returning success.
7. **FFmpeg is background-only** — Never call from route handlers. CPU-intensive ops run in BullMQ workers.
8. **`process_status` concurrent guard** — Uses `.in(['pending', 'failed'])`. Don't change to plain `.eq()`.
9. **OAuth redirect URIs must match exactly** — Google and Meta reject mismatches. Localhost ≠ production.
10. **Threads OAuth URIs are localhost** — Need real domain before Threads works in production.
11. **Facebook error 506** — "Duplicate content." Normal during testing. Change content or wait.
12. **No axios without timeout** — All platform API calls need `timeout: 30_000`.
13. **Stale post recovery window: 2-3 minutes max** — Not 5. Legitimate publishes take ≤105s.
14. **Only seed media-process for posts needing publishing** — Never seed the whole media library.
15. **Wrap startup steps independently** — Separate `run(label, fn)` per step in `startAllWorkers()`.
16. **`ai_image_url` doesn't exist on `posts` table** — AI images are in `media_items.cloud_url` where `cloud_provider = 'ai_generated'`.
17. **Always use `fbCall()` wrapper** — Extracts real Facebook error codes from axios 400 responses.
18. **DELETE before INSERT in video analysis** — Prevents duplicate segment rows on re-analysis.
19. **Don't auto-reset 'failed' analysis items** — Only reset 'analyzing'. Resetting 'failed' = infinite loop.
20. **Keep `knownLength` in Facebook video upload** — Without it, Facebook rejects with error 351.
21. **Keep `access_token` in URL params for Facebook video** — More reliable than form body for multipart.
22. **Remove existing BullMQ job before re-queuing** — Deduplication by jobId across ALL states including completed.
23. **`free` vs `free_trial` naming** — Standardized on `free_trial` everywhere. If you see `free` alone, it's probably a bug.
24. **Stripe `cancel_at_period_end` does NOT change status** — When a subscription is cancelled at period end, Stripe keeps `status: 'active'` but sets `cancel_at_period_end: true`. The webhook must check this flag and map to our `cancelling` status. Without this check, the webhook overwrites `cancelling` back to `active` and the cancel appears to do nothing.
25. **Never use `showAlert` for actions that trigger `renderSubscriptionSection()`** — The re-render rebuilds DOM and can destroy/displace alert elements. Use `showToast()` instead — it renders to `#global-toasts` which lives outside `#app` and survives all re-renders.
26. **Always bump `app.js?v=N` in `index.html` after frontend changes** — Without this, browsers serve cached old code and new features/fixes don't appear. Production uses Coolify which rebuilds the Docker image, but browsers cache aggressively.
27. **Always `git push origin main` after every commit** — Coolify deploys from GitHub. Unpushed commits = undeployed code. The user manually triggers redeploy in Coolify after being told code is pushed.

---

## 10. Database Tables Reference

### Core Tables
- `user_profiles` — brand_name, industry, target_audience, brand_voice, business_type, geo_region, target_age_range, content_goals
- `briefs` — niche, platforms (JSONB array), tone, post_type, objective, notes, talking_points, semantic metadata
- `posts` — brief_id, platform, hook, caption, hashtags, cta, media_id, status (draft/approved/scheduled/publishing/published/failed), scheduled_for, error_message
- `media_items` — cloud_provider, cloud_url, processed_url, process_status, file_type, duration, width, height
- `video_segments` — media_item_id, start_time, end_time, energy_level, pacing, mood, scene_description, tags
- `post_comments` — post_id, comment_text, author_handle, author_platform_id, sentiment, trigger_matched, dm_sent
- `cloud_connections` — user_id, provider, encrypted_tokens, platform_user_id
- `platform_metrics` — post_id, platform, likes, comments, shares, reach, impressions

### DM Automation Tables
- `dm_automations` — post_id, trigger_keywords (JSONB array), flow_type, dm_message, active
- `dm_automation_steps` — automation_id, step_order, message_template, collects_field
- `dm_conversations` — automation_id, commenter_platform_id, status, current_step
- `dm_collected_data` — conversation_id, field_name, field_value

### Billing & Admin Tables
- `subscriptions` — user_id, stripe_customer_id, stripe_subscription_id, plan, status, current_period_end
- `plans` — tier, name, price_display, period_label, stripe_price_id, features (JSONB), color, badge, sort_order, is_active
- `tier_limits` — tier, feature, limit_value, enabled
- `cohort_performance` — cohort_key, platform, post_type, avg_likes, avg_reach, top_hooks, top_tones, best_post_hours

---

## 11. Platform Publishing Status

| Platform | OAuth | Text | Image | Video | Comments | DMs | Status |
|----------|-------|------|-------|-------|----------|-----|--------|
| Facebook | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | **Fully working** |
| Instagram | ✅ (via FB) | ✅ | ✅ | ✅ (Reels) | ✅ | ✅ | **Working, needs App Review** |
| TikTok | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | Stub only |
| LinkedIn | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | Stub only |
| X (Twitter) | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | Stub only |
| Threads | Scaffolded | ❌ | ❌ | ❌ | ❌ | ❌ | Redirect URIs need real domain |
| YouTube | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | Stub only |

---

## 12. Environment & Deployment

### Local Development
```bash
cp backend/.env.example backend/.env   # Fill in all values
cd docker && docker compose up --build
# App: http://localhost:3001 | Redis: localhost:6379
```

### Production (Coolify)
- **Deployment workflow:** Claude commits + pushes to `main` → user manually clicks "Redeploy" in Coolify → user does Ctrl+Shift+R (hard refresh) in browser
- Env vars set in Coolify UI (override .env file)
- Required: `NODE_ENV=production`, `FRONTEND_URL=https://yourdomain.com`, all credentials
- Logs: Coolify → project → Deployments → live → Logs tab
- **CRITICAL:** Always push to GitHub after committing. Always bump `app.js?v=N` in `index.html` after frontend JS changes. Always tell the user to hard refresh (Ctrl+Shift+R) after deploy.

### Required Environment Variables
```bash
SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
REDIS_HOST, REDIS_PORT, REDIS_PASSWORD
TOKEN_ENCRYPTION_KEY (≥32 chars)
LLM_BASE_URL, LLM_API_KEY, LLM_MODEL
CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
FACEBOOK_APP_ID, FACEBOOK_APP_SECRET
META_WEBHOOK_VERIFY_TOKEN
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
FRONTEND_URL
FFMPEG_PATH, FFMPEG_TEMP_DIR
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
SMTP_HOST, SMTP_USER, SMTP_PASS, ALERT_EMAIL_TO (optional)
PORT, NODE_ENV
```

---

## Appendix: Coding Conventions

- **async/await with try/catch everywhere** — never `.then()/.catch()` chains
- **No hardcoded values** — everything changeable in `.env`
- **Comment every non-obvious block** — readable by a beginner
- **No inline business logic in routes** — routes validate, delegate to agents/services
- **Adapter pattern mandatory** — every external API gets its own service file
- **Multi-tenancy non-negotiable** — `req.db` in routes, `supabaseAdmin` + `.eq('user_id')` in workers
- **Instructions level** — All documentation and instructions written at 10th grade level, step-by-step, assuming no prior experience
- **Always push after commit** — `git push origin main` after every commit so Coolify can deploy
- **Always bump cache versions** — After changing any frontend JS file, bump `?v=N` in `index.html`
- **Use `showToast()` for billing/subscription notifications** — `showAlert()` can be destroyed by DOM re-renders
- **Separate API calls from UI refreshes** — Put the API call in its own try/catch so a re-render failure can't swallow success feedback
