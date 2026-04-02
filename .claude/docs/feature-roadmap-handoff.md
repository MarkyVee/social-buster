# Social Buster — Feature Roadmap & Handoff

> **Last updated:** 2026-04-02 (session 4)
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
| Brief system + AI generation + WYSIWYG previews | Done — ISSUE-032: Groq 413 TPM fix deployed 2026-04-02 (max_tokens 5120→2048) |
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
| Admin dashboard — Legacy, Affiliates, Payouts tabs | Built (v41) — tab bar scrollable |
| Legacy Membership + Affiliate Program (backend + admin) | Built — migration run, needs Stripe price ID seeded |
| Plan card logo_url field (admin Plans editor) | Built — requires SQL: `ALTER TABLE plans ADD COLUMN IF NOT EXISTS logo_url TEXT` |
| Platform "Coming Soon" in My Profile | Done (app.js v6) — only Instagram + Facebook selectable. Remove from exclusion list when OAuth ships. |
| AI agent data collection (all tiers) | All agents run for every user. Intelligence display gated by tier, not collection. |
| Signal weights learning engine (Layer 1) | Built (2026-04-01) — hookPerformanceAgent + toneObjectiveFitAgent + contextBuilder injection |
| Admin agent directives (FEAT-025) | Built (v51) — `admin_agent_directives` table + CRUD UI in Avatars tab. Run `migration_agent_directives.sql` in Supabase |
| Avatar eval stats + Add Avatar button | Built (v51) — Evaluations count column in avatar roster, create-avatar route + modal |
| Context Inspector (admin user detail) | Built (v51) — shows `agent_context`, `research`, `intelligence` Redis cache state per user |
| Async intelligence refresh | Built (app.js v54) — queues BullMQ job, frontend polls status every 2s. No more 10-20s blocked HTTP |
| Intelligence Agent Controls (admin user detail) | Built (v51) — manual run-agents + reset signal_weights buttons per user |
| Affiliate slug (admin user detail) | Built (v51) — assign-once, read-only after set, 409 block on any re-assign attempt |
| Demo seed script | Built — `scripts/seed-demo-data.js`. Seeds: evaluations (12/avatar), post_metrics (instagram+facebook), signal_weights, comments (19 with sentiment split), pending prompt suggestion. `--clean` flag removes seeded data only, leaves real data intact |
| Cloudflare CDN cache purge (admin Diagnostics tab) | Built — needs `CLOUDFLARE_CACHE_TOKEN` env var in Coolify |
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

1. **Test Facebook DM realtime path** — publish a new post, have Mark comment "GO", confirm logs show `[CommentAgent] Realtime: matched post via...` instead of the polling fallback (ISSUE-031 fix deployed, needs verification)
2. **Platform validation + content compliance** — Character counters for all platforms, image aspect ratio validation, centralized `platformSpecs.json` (active plan exists)
3. **Meta App Review** — `pages_messaging` + `instagram_manage_messages` need approval for non-admin users
4. **Remove diagnostic logging** — clean verbose DM/publishing logs after realtime DM confirmed working
4. **Repost from Intelligence Dashboard** — not yet built
5. **Platform OAuth** — TikTok, LinkedIn, X, YouTube (deferred by user)
6. **Horizontal block scaling** — deferred, full architecture designed (see Section 10). Implement at ~8-9K users.
7. **Platform availability + tier gating** — TikTok/LinkedIn/X/Threads/WhatsApp/Telegram show "Coming Soon" in profile (done v6). Add tier-based platform caps to Limits dashboard. See [[FEATURES]] FEAT-022/023.
8. ~~**Agent data collection for all tiers**~~ — Done. Agents always run regardless of tier. Gate only the display. See [[FEATURES]] FEAT-024.

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

| ID | Feature | Priority | Status |
|----|---------|----------|--------|
| FEAT-016 | Cloudflare cache purge from admin Diagnostics tab | Low | Done — needs `CLOUDFLARE_CACHE_TOKEN` env var |
| FEAT-018 | ADA/WCAG accessibility compliance | Medium | Planned |
| FEAT-019 | Admin OAuth Token Diagnostics Panel | Low | Planned |
| FEAT-020 | Admin Publishing Error Diagnostics + Maintenance Panel | Medium | Done (2026-03-29) |

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
| `hookPerformanceAgent.js` | Scores hook formats by engagement outcome | On signal-weights job |
| `toneObjectiveFitAgent.js` | Detects poor tone/objective combos | On signal-weights job |
| `postTypeCalendarAgent.js` | Best post types by day/time | On signal-weights job |
| `contentFatigueAgent.js` | Detects declining engagement on repeated formats | On signal-weights job |
| `platformAlgorithmAgent.js` | Cohort-wide algorithm shift detection | On signal-weights job |
| `briefOptimizationAgent.js` | Brief field patterns that predict top posts | On signal-weights job |
| `contentGapAgent.js` | Topics/formats the user hasn't tried yet | On signal-weights job |
| `evaluationMetaAgent.js` | Analyzes avatar evaluation outcomes, suggests prompt improvements | On-demand (admin trigger) |
| `signalWeightsWorker.js` | Orchestrates all signal agents sequentially, writes to `signal_weights` | On signal-weights-user BullMQ job |

### 10 BullMQ Queues
`publish`, `comment`, `media-scan`, `media-analysis`, `media-process`, `dm`, `performance`, `research`, `signal-weights`, `watchdog`

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
- **Seed `legacy_cohorts`** with real Stripe Price ID once created in Stripe dashboard
- **`CLOUDFLARE_CACHE_TOKEN`** — created in Cloudflare (Zone → Cache Purge), needs adding to Coolify env vars
- **`ALTER TABLE plans ADD COLUMN IF NOT EXISTS logo_url TEXT`** — run in Supabase if not done
- **Run `migration_agent_directives.sql`** in Supabase — creates `admin_agent_directives` table required for agent directive UI (admin Avatars tab)
- Legacy public signup page with slot countdown (not yet built)
- Affiliate terms + ToS update
- Stripe Connect platform account verification (Stripe sent email — not a code issue)
- End-to-end affiliate test: referral signup → commission → payout cycle
- ~~`legacy_slots` seed row~~ — fixed (deleted duplicate row, table now has exactly 1 row)
- ~~`display_name` column bug~~ — fixed (user_profiles uses `full_name`, all affiliate/legacy routes updated)
- ~~Legacy tier missing from admin subscription override~~ — fixed (v43)

---

---

## 8. Legacy Membership & Affiliate Program

### What's built
| File | Purpose |
|------|---------|
| `backend/routes/affiliate.js` | 9 user-facing routes: dashboard, referrals, earnings, payouts, clawbacks, slug, connect status, connect onboard |
| `backend/routes/admin.js` | Legacy slots, cohorts, members list, affiliates list + detail, payouts queue, fraud flags, clawbacks |
| `backend/services/affiliateService.js` | Commission logic, payout processing, clawback handling, Stripe Connect, reserve release |
| `backend/workers/payoutWorker.js` | Monthly payout on 15th (cron: `0 2 15 * *`), daily reserve release |
| `backend/data/migration_affiliate_program.sql` | 12 blocks — all run in Supabase (2026-04-01) |
| `frontend/public/js/app.js` | Affiliate Program sidebar link (Legacy members only) + full user dashboard |
| `frontend/public/js/admin.js` | Legacy tab (slots + cohorts + members table), Affiliates tab, Payouts tab |

### How the pricing works
- Each calendar year has a `legacy_cohorts` row with its own locked `stripe_price_id`
- Legacy checkout reads from `legacy_cohorts`, NOT from `plans.stripe_price_id`
- When admin adds a cohort, the `plans` row for Legacy auto-updates its `stripe_price_id` to match
- Existing members never move to a new cohort price — locked at signup year forever

### What still needs doing before it's live
1. **Create the Legacy product in Stripe** — recurring, `interval: day`, `interval_count: 30`
2. **Seed first cohort** in Supabase once you have the Stripe Price ID:
   ```sql
   INSERT INTO legacy_cohorts (cohort_year, price_monthly, stripe_price_id, is_current)
   VALUES (2026, 5900, 'price_REAL_ID_HERE', true);
   ```
3. **Complete Stripe Connect platform verification** — Stripe sent an email, not a code issue
4. **End-to-end test:** referral signup → commission → payout cycle
5. **Public-facing Legacy signup page** with slot countdown (not yet built)
6. **Affiliate terms** — update Terms page with affiliate/Legacy legal copy

### Lifetime Affiliate Lock (BUSINESS RULE — DO NOT CHANGE)
Once a user signs up via an affiliate's referral link, that user is permanently tied to that affiliate.
- The referring affiliate earns commission on that user for life, regardless of plan changes
- The user **cannot** change their affiliate — no UI, no admin override, no exception
- The `referrals` table row is the source of truth — it is never deleted, never reassigned
- If a user asks to switch affiliates: decline. If an admin tries to reassign: do not build that feature.
- Rationale: affiliates trust that referred users are theirs permanently — changing this retroactively destroys trust in the program

### Key landmines
- Admin tab bar has 14 tabs — Legacy/Affiliates/Payouts are at the far right, scroll horizontally
- `claim_legacy_slot` RPC uses `SELECT FOR UPDATE` — atomic, race-condition safe
- All affiliate RLS policies use `USING (true) WITH CHECK (true)` per ISSUE-029 — never use `auth.role() = 'service_role'`
- `CLOUDFLARE_CACHE_TOKEN` is separate from `CLOUDFLARE_API_TOKEN` (AI image gen) — do not mix them
- Stripe Connect type is `standard` — user completes onboarding on Stripe's hosted page
- Payout schedule: 15th of each month covering prior month earnings (cron `0 2 15 * *`)
- 10% reserve withheld per payout, released after 60 days clean (no chargebacks/refunds)

---

## 10. Horizontal Block Scaling (Spoke-and-Wheel Architecture)

**Status:** Deferred — implement when approaching 8-9K users. Current fixes handle load to ~10K on a single block.

### Concept
Each "block" = independent Docker Compose stack (Express API + Redis + BullMQ workers) serving its own shard of users. All blocks share one Supabase DB (the hub/wheel). Workers filter by `shard_id` so Block 1 only processes users assigned `shard_id=1`, Block 2 only processes `shard_id=2`, etc. API layer stays fully stateless — load balancer routes any user to any available block.

### Architecture
```
                     ┌──────────────────────────┐
                     │   SUPABASE (shared hub)   │
                     │   Postgres + Storage      │
                     └────────────┬─────────────┘
                                  │
           ┌──────────────────────┼──────────────────────┐
           │                      │                      │
  ┌────────▼────────┐  ┌─────────▼───────┐  ┌──────────▼──────┐
  │    BLOCK 1      │  │    BLOCK 2      │  │    BLOCK N      │
  │  shard_id = 1   │  │  shard_id = 2   │  │  shard_id = N   │
  │  Users 0-10K    │  │  Users 10K-20K  │  │  Users N×10K    │
  │  Express API    │  │  Express API    │  │  Express API    │
  │  Redis          │  │  Redis          │  │  Redis          │
  │  BullMQ Workers │  │  BullMQ Workers │  │  BullMQ Workers │
  └─────────────────┘  └─────────────────┘  └─────────────────┘
```

### What's Required to Implement
1. `ALTER TABLE user_profiles ADD COLUMN shard_id SMALLINT DEFAULT 1;` + index
2. Assign `shard_id` at signup: `hash(user_id) % TOTAL_SHARDS + 1` (consistent hash — stable if shards added)
3. Worker queries filtered by `SHARD_ID` env var (~15 lines across 3 agents: commentAgent, performanceAgent, researchAgent seed)
4. Global workers pinned to Block 1 only: watchdog, payout, email (check `SHARD_ID === 1` before starting)
5. `docker-compose.yml` per block: identical image, different `SHARD_ID` + `TOTAL_SHARDS` + `REDIS_URL`

### Deploying a New Block
No code changes needed after initial implementation. Block 2 = same Docker image + env vars:
- `SHARD_ID=2`, `TOTAL_SHARDS=2`, `REDIS_URL=redis://redis-block2:6379`
- Existing users stay on Block 1. New signups hash to shard 1 or 2 automatically.

### Cost at 20K Users (2 Blocks)
~$90-110/mo: 2× VPS ~$50 + LLM research ~$24 + Supabase Pro $25

### Scale Fixes Already Shipped (2026-04-01)
These handle load up to ~10K on a single block:
- `researchAgent`: skips LLM call if cache still fresh; weekly seed only for users active last 60 days
- `commentAgent` + `performanceAgent`: early return if user has no platform connections
- `commentAgent` + `performanceAgent`: 5 users processed concurrently per batch (was sequential)

---

## 11. Data Retention Policy

On account deletion or Meta access revocation:
- **DELETE:** Email, name, username, platform connections, tokens, DM conversations, lead data, automation configs
- **KEEP:** Anonymized aggregated metrics (engagement rates, cohort benchmarks, sentiment distributions) — these feed the collective intelligence engine and contain no identifying information
- Privacy policy Section 5 and Section 8 disclose this explicitly
