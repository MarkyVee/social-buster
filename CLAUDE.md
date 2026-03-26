# Social Buster — Claude Code Instructions

This file is read automatically by Claude Code at the start of every session.
It is the authoritative context document for this codebase.

---

## Documentation Rules (Auto-Logging)

Claude MUST keep the following logs in `.claude/docs/` updated automatically during every session. These are Obsidian-compatible markdown files. Use `[[wiki-links]]` when cross-referencing between docs.

### What to log and where

| Event | File | When |
|-------|------|------|
| Architecture or design decision | [[DECISIONS]] | Any non-trivial "we chose X over Y" moment |
| Bug, problem, or blocker discovered | [[ISSUES]] | When you find something broken or blocking |
| Feature idea or enhancement discussed | [[FEATURES]] | When a new idea comes up, even casually |
| Work completed in a session | [[CHANGELOG]] | End of each work session or after significant milestone |

### Rules
1. **Log immediately** — don't batch. When a decision is made, log it right then.
2. **Use the format** already established in each file (ID, date, status, description, reason).
3. **Update status** — when an issue is resolved or a feature is built, move it and update its status.
4. **Cross-link** — use `[[DECISIONS]]`, `[[ISSUES]]`, `[[FEATURES]]` wiki-links to connect related entries.
5. **Keep [[SYSTEM_OVERVIEW]]** current — update the "Current Focus" section when priorities shift.
6. **Increment IDs** — ISSUE-001, ISSUE-002, FEAT-001, FEAT-002, etc.
7. **Never delete entries** — move them to the appropriate status section (resolved, done, wont-fix).

### Files
- `.claude/docs/DECISIONS.md` — Decision log (architecture, design, tool choices)
- `.claude/docs/ISSUES.md` — Bug and problem tracker
- `.claude/docs/FEATURES.md` — Feature ideas and backlog
- `.claude/docs/CHANGELOG.md` — What was built/shipped per session
- `.claude/docs/SYSTEM_OVERVIEW.md` — Current focus, blockers, next action (hub page)

---

## Project Overview

**Social Buster** is an enterprise-grade AI-powered social media marketing platform.
Three core functions:
1. **AI post generation** — user submits a brief, LLM generates hook/caption/hashtags/CTA per platform using research and data that is gathered from the platform from an individuals post or the collective posts of all users on the platform to make it extremely effective and relevant. 
2. **Comment-to-lead DM automation** — monitors comments for trigger phrases, fires DMs via n8n
3. **Auto-publishing** — scheduled and immediate publishing to 7 social platforms

Target: 5,000 U.S. users. Every external dependency has an adapter layer — swapping providers means changing one file, not the codebase.

---

## Tech Stack

| Layer | Choice |
|-------|--------|
| Runtime | Node.js + Express |
| Frontend | Plain HTML/CSS/JS — **NO React, no build step** |
| Database | PostgreSQL via Supabase (RLS for multi-tenancy) |
| Auth | Supabase Auth (email/password + JWT) |
| Job Queue | BullMQ on Redis (AOF persistence required) |
| LLM | OpenAI-compatible (default: Groq) — env-var driven |
| AI Images | Cloudflare Workers AI (Flux Schnell) |
| Video | FFmpeg — background only, never on request path |
| Storage | Supabase Storage (3 public buckets) |
| Automation | n8n (self-hosted Docker) — plugin, not engine |
| Deployment | Docker Compose → Coolify |

---

## Directory Structure

```
/social-buster
├── backend/
│   ├── server.js               Entry point. Express setup, startup validation,
│   │                           health check scheduler, worker startup.
│   ├── routes/                 HTTP route handlers (never contain business logic)
│   │   ├── auth.js             Login, signup, logout, profile CRUD
│   │   ├── briefs.js           Brief CRUD + LLM generation trigger
│   │   ├── posts.js            Post CRUD. PUT /:id triggers mediaProcessQueue.
│   │   ├── media.js            Media library, Drive scan, probe, AI image gen
│   │   ├── publish.js          Platform OAuth + manual publish trigger
│   │   ├── intelligence.js     Intelligence dashboard + research refresh
│   │   ├── billing.js          Stripe (skeleton — not live)
│   │   ├── admin.js            AdminJS + BullMQ Board
│   │   ├── messages.js         User inbox
│   │   ├── automations.js      DM automation CRUD + leads export (CSV)
│   │   └── webhooks.js         Meta webhook receiver for incoming DM replies
│   ├── middleware/
│   │   ├── auth.js             JWT validation → req.user = { id, email }
│   │   ├── tenancy.js          User-scoped DB client → req.db (auto-filtered)
│   │   └── rateLimit.js        standardLimiter, strictLimiter
│   ├── agents/                 Business logic — called only by workers, never routes
│   │   ├── publishingAgent.js  Core publish logic + retry. Uses process_status/processed_url.
│   │   ├── mediaProcessAgent.js NEW. Copies media → Supabase Storage at attach time.
│   │   ├── commentAgent.js     Comment ingestion + DM automation trigger
│   │   ├── dmAgent.js          DM conversation state machine (single + multi-step)
│   │   ├── mediaAgent.js       Cloud storage scanning + file cataloging
│   │   ├── researchAgent.js    LLM trend research, cached in Redis
│   │   └── performanceAgent.js Platform metrics polling
│   ├── workers/                BullMQ worker files — each starts on require()
│   │   ├── index.js            Orchestrator. Registers repeatable jobs, seeds startup jobs.
│   │   ├── publishWorker.js    'publish' queue. Runs processQueue() every 60s.
│   │   ├── mediaProcessWorker.js 'media-process' queue. Runs at media attach time.
│   │   ├── mediaWorker.js      'media-scan' queue. Every 30 min.
│   │   ├── mediaAnalysisWorker.js 'media-analysis' queue. FFmpeg per video.
│   │   ├── commentWorker.js    'comment' queue. Every 15 min.
│   │   ├── dmWorker.js         'dm' queue. Sends DMs + expires stale conversations.
│   │   ├── performanceWorker.js 'performance' queue. Every 2 hours.
│   │   └── researchWorker.js   'research' queue. Weekly per user.
│   ├── services/               External integrations + shared utilities
│   │   ├── platformAPIs.js     publish/fetchMetrics/fetchComments for all 7 platforms
│   │   ├── messagingService.js  DM sending via Meta Graph API (Facebook + Instagram)
│   │   ├── llmService.js       OpenAI-compatible wrapper (swap provider via .env)
│   │   ├── ffmpegService.js    Video probe/trim/download/cleanup + PLATFORM_LIMITS
│   │   ├── imageGenerationService.js  Cloudflare Workers AI image generation
│   │   ├── googleDriveService.js      Drive scan + downloadGoogleDriveFile()
│   │   ├── supabaseService.js         supabaseAdmin client (service role)
│   │   ├── tokenEncryption.js         AES-256-GCM for OAuth token storage
│   │   ├── redisService.js            cacheGet/cacheSet/cacheDel wrappers
│   │   ├── videoAnalysisService.js    FFmpeg scene detection → video_segments table
│   │   ├── visionTaggingService.js    LLM visual tagging of segments
│   │   ├── promptLoader.js            Loads .txt prompt templates from /prompts/
│   │   ├── alertService.js            SMTP email alerts for health check
│   │   └── stripeService.js           Stripe SDK wrapper (skeleton)
│   ├── queues/
│   │   └── index.js            All 6 BullMQ queue definitions + Redis connection config
│   ├── data/                   Temp files only. Always cleaned up. Never commit anything here.
│   └── .env                    ALL environment variables. Never commit.
│
├── frontend/public/
│   ├── index.html              Single HTML file. Hash-routed (#dashboard, #brief, etc.)
│   ├── css/
│   │   ├── styles.css          Main styles
│   │   └── platforms.css       Platform icons + color chips
│   └── js/
│       ├── app.js              Shell, auth, routing, post + queue rendering
│       ├── brief.js            Brief form + generation UI
│       ├── preview.js          WYSIWYG per-platform post preview
│       ├── publish.js          Queue UI, status polling, OAuth connect/disconnect
│       ├── media.js            Media library, clip picker, AI image gen UI
│       ├── messages.js         User inbox UI
│       └── admin.js            Admin dashboard UI
│
├── docker/
│   ├── docker-compose.yml      Services: backend, redis, n8n
│   └── Dockerfile.backend      Node.js + FFmpeg image
│
├── n8n/                        Workflow template files
├── CLAUDE.md                   This file
└── .claude/
    └── docs/
        └── handoff.md          Full developer handoff (features, bugs, failed approaches)
```

---

## Coding Conventions

### General
- **async/await with try/catch everywhere** — never `.then()/.catch()` chains
- **No hardcoded values** — everything that could change goes in `.env`
- **Comment every non-obvious block** — this codebase should be readable by a beginner
- **No inline business logic in routes** — routes validate input and delegate to agents/services

### Multi-Tenancy (non-negotiable)
- In **route handlers**: always use `req.db` (never `supabaseAdmin`). `req.db` is pre-scoped to the user.
- In **workers/agents**: use `supabaseAdmin` but ALWAYS include `.eq('user_id', userId)` on every query.
- Never remove the user_id filter from any query. RLS is a safety net, not the primary guard.

### Error Handling
- Route handlers: catch errors, return `res.status(500).json({ error: '...' })` — never let Express crash.
- Workers/agents: re-throw errors so BullMQ marks the job failed and triggers retry.
- Per-post failures in agents: mark the post as `failed` with `error_message`, don't re-throw (don't block the rest of the queue).

### Services
- Every external API gets its own service file. Never call axios/SDKs directly from routes or agents.
- The adapter pattern is mandatory: swap providers by changing the service file, not call sites.

### Frontend
- No React, no bundler, no TypeScript. Plain ES6+ in `<script>` tags or JS files.
- Hash-based routing: all navigation is `window.location.hash` changes.
- API calls use `fetch()` with the JWT from `localStorage.getItem('access_token')`.

---

## Files You Should Never Modify Directly

| File | Why |
|------|-----|
| `backend/middleware/auth.js` | JWT validation chain. Breaking this locks out all users. |
| `backend/middleware/tenancy.js` | Multi-tenancy isolation. Breaking this risks data leakage between users. |
| `backend/services/tokenEncryption.js` | Changing the encryption logic will break decryption of all stored OAuth tokens. |
| `backend/queues/index.js` | Queue definitions are referenced by 7 workers. Wrong changes break all background jobs. |
| `frontend/public/index.html` | Nav structure + auth guard wiring are tightly coupled to `app.js`. |

---

## How to Run / Build / Deploy

### Local Development
```bash
# 1. Copy and fill in your .env
cp backend/.env.example backend/.env

# 2. Start everything
cd docker
docker compose up --build

# App:   http://localhost:3001
# n8n:   http://localhost:5678  (admin / changeme_n8n)
# Redis: localhost:6379
```

### Production (Coolify)
- Coolify watches the Git repo and rebuilds on push to `main`.
- Environment variables are set in Coolify's UI — they override the `.env` file.
- Required: set `NODE_ENV=production`, `FRONTEND_URL=https://yourdomain.com`, all credentials.
- To check logs: Coolify → project → Deployments → live deployment → Logs tab.
- To redeploy: push to `main` or click "Redeploy" in Coolify.

### Health Check
- Automatic — runs every 5 min (quick) and 60 min (full) after server start.
- No manual trigger needed in production.
- Log prefixes for monitoring: `[HEALTH OK]`, `[HEALTH DEGRADED]`, `[HEALTH CRITICAL]`.
- Admin endpoint: `GET /admin/health` (requires admin auth).

### Running a SQL Migration
1. Supabase project → **SQL Editor**
2. Paste and run the SQL
3. Redeploy (workers seed from DB state on startup)

---

## Required Environment Variables

```bash
# Supabase
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

# Redis (used by BullMQ)
REDIS_HOST=
REDIS_PORT=6379
REDIS_PASSWORD=

# Token encryption (AES-256 — must be ≥ 32 characters)
TOKEN_ENCRYPTION_KEY=

# LLM — Groq default, swap to any OpenAI-compatible endpoint
LLM_BASE_URL=https://api.groq.com/openai/v1
LLM_API_KEY=
LLM_MODEL=llama-3.1-8b-instant

# AI Image generation (Cloudflare Workers AI)
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=

# Facebook / Meta OAuth
FACEBOOK_APP_ID=
FACEBOOK_APP_SECRET=

# Meta Webhook (for DM reply handling — any random string)
META_WEBHOOK_VERIFY_TOKEN=

# Google Drive OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://yourdomain.com/auth/google/callback

# Frontend URL — used for OAuth redirects. No trailing slash.
FRONTEND_URL=https://yourdomain.com

# FFmpeg
FFMPEG_PATH=/usr/bin/ffmpeg
FFMPEG_TEMP_DIR=/tmp/social-buster/videos

# Stripe (not yet live)
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
PLAN_PRICE_STARTER=29
PLAN_PRICE_PROFESSIONAL=79
PLAN_PRICE_ENTERPRISE=199

# SMTP email alerts (optional — falls back to console logs if not set)
SMTP_HOST=
SMTP_USER=
SMTP_PASS=
ALERT_EMAIL_TO=

# App
PORT=3000
NODE_ENV=production
```

---

## Third-Party Integrations

### Supabase
- **Auth:** Supabase Auth (email/password). JWT returned to frontend, validated via `SUPABASE_ANON_KEY` on every request.
- **Database:** PostgreSQL. RLS policies on every table. `supabaseAdmin` (service role) bypasses RLS — only use in workers.
- **Storage:** 3 public buckets: `ai-generated-images`, `video-segments`, `processed-media`. All must be set to PUBLIC in Supabase dashboard.

### Google Drive OAuth
- App registered in Google Cloud Console. Credentials in `.env`: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- **CRITICAL:** The redirect URI registered in Google Cloud Console must exactly match `GOOGLE_REDIRECT_URI` in `.env`. Mismatch causes `redirect_uri_mismatch` OAuth error. In production it must be the real domain, not localhost.
- OAuth tokens stored encrypted in `cloud_connections` table.

### Facebook / Meta Graph API
- App registered in Meta Developer Portal. `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` in `.env`.
- Publishing to a **Page** (not personal profile). `platform_user_id` = Page ID. Access token = Page Access Token (not User Access Token).
- Scopes needed: `pages_manage_posts`, `pages_read_engagement`, `pages_messaging`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_messages`.
- All API calls use `fbCall()` wrapper in `platformAPIs.js` which extracts real error codes from 400 responses.

### Groq (LLM)
- Default LLM provider. Free tier: 14,400 requests/day. Cost beyond free: ~$0.59/M tokens.
- Swap to any OpenAI-compatible provider by changing `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`. Zero code changes.

### Cloudflare Workers AI
- Used for AI image generation (Flux Schnell model).
- Free tier: ~47 images/day. Production: ~$0.0023/image.
- Returns PNG bytes directly in HTTP response (no temp URL). Bytes uploaded directly to Supabase Storage.

### Redis (BullMQ)
- Must have AOF persistence enabled: `--appendonly yes --appendfsync everysec`.
- BullMQ requires `maxRetriesPerRequest: null` in the ioredis connection config.
- In Docker: service name `redis`, port 6379. Set `REDIS_HOST=redis`.

### DM Automation (Meta Graph API)
- n8n was removed (2026-03-20). DM sending uses the Meta Graph API directly via `messagingService.js`.
- Facebook Messenger: `POST /me/messages` with Page Access Token. Requires `pages_messaging` scope.
- Instagram DMs: `POST /me/messages` with Page Access Token. Requires `instagram_manage_messages` scope.
- Both enforce a 24-hour messaging window: you can only DM users who interacted with your content within 24 hours.
- Rate limits: 100 DMs/day per Facebook Page, 80 DMs/day per Instagram account (enforced via Redis counters).
- Multi-step conversations: Meta sends replies via webhook → `POST /webhooks/meta` → `dmAgent.processIncomingReply()`.
- Webhook setup: register `https://yourdomain.com/webhooks/meta` in Meta Developer Portal with `META_WEBHOOK_VERIFY_TOKEN`.

---

## Known Landmines and Gotchas

### CRITICAL: SQL Migration Pending
`media_items` is missing four columns (`processed_url`, `process_status`, `process_error`, `processed_at`). Until the migration is run, **all media publishing fails silently** (posts publish as text-only or fail). See `.claude/docs/handoff.md` for the exact SQL.

### Google Drive `webViewLink` is NOT a download URL
`cloud_url` for Drive items is a `https://drive.google.com/file/d/{id}/view` link. This requires a browser session — raw HTTP gets HTML, not the file binary. To download a Drive file in code, use `downloadGoogleDriveFile()` in `googleDriveService.js` which calls `drive.files.get({fileId, alt: 'media'})` with the authenticated Drive client.

### `supabaseAdmin` vs `req.db`
- `supabaseAdmin` — service role key, bypasses RLS. Use ONLY in workers/agents where there's no HTTP request context. Always add `.eq('user_id', userId)` manually.
- `req.db` — user-scoped client from `tenancy.js`, auto-filtered to `req.user.id`. Use in ALL route handlers. Never pass `req.db` to background agents.

### BullMQ requires `maxRetriesPerRequest: null`
Without this, ioredis will throw on every Redis command and crash the BullMQ worker. It's set in `queues/index.js` — don't remove it.

### Stripe webhook must be mounted BEFORE `express.json()`
In `server.js`, `app.use('/billing/webhook', billingRoutes)` is intentionally above the `express.json()` middleware. Stripe requires the raw request body Buffer for signature verification. If `express.json()` runs first, the raw body is consumed and webhook verification fails.

### Platform publishing stubs will throw
`publishToInstagram`, `publishToTikTok`, `publishToLinkedIn`, `publishToX`, `publishToThreads`, `publishToYoutube` in `platformAPIs.js` are stubs that throw errors. If a user has one of these platforms connected and tries to publish, it will fail. This is intentional — don't "fix" it by silently returning success.

### FFmpeg is background-only
Never call `ffmpegService` functions from a route handler. FFmpeg processing is CPU-intensive and can take seconds to minutes. All video operations run inside BullMQ workers.

### `process_status` concurrent guard
`mediaProcessAgent.js` updates `process_status` from `pending/failed` to `processing` using `.in('process_status', ['pending', 'failed'])`. This is the concurrency lock. Don't change this to a plain `.eq('id', id)` — it would allow two jobs to race.

### OAuth redirect URIs must match exactly
Google rejects any redirect URI that doesn't exactly match what's registered in Google Cloud Console. For local dev: register `http://localhost:3000/auth/google/callback`. For production: register `https://yourdomain.com/auth/google/callback`. They cannot be used interchangeably.

### Threads OAuth redirect URIs are localhost
`routes/publish.js` Threads OAuth redirect URI is currently `http://localhost:3000/...`. This must be updated to the real domain before Threads publishing can work in production.

### Video analysis can be blocked by media processing
If `seedPendingMediaProcessing` ever queues jobs for the entire media library (not just posts needing publishing), it will compete with `mediaAnalysisQueue` for disk space, CPU, and Docker volume capacity. The seed is intentionally scoped to media on pending posts — keep it that way.

### Facebook error 506 during testing
Error 506 = "Duplicate content." Facebook rejects posts with identical text within a short window. This is normal when testing the same post repeatedly. Use slightly different content each test or wait a few minutes.

---

## Do Not Attempt — Approaches That Have Already Failed

1. **Do not use Google Drive `webViewLink` URL as a direct download.** It returns HTML. Use `downloadGoogleDriveFile()`.

2. **Do not download media from Drive at publish time.** The entire media architecture was redesigned to prevent this. Drive must be copied to Supabase Storage at attach time. Never move this back.

3. **Do not use `axios` without a `timeout` on platform API calls.** In Docker/VPS environments, stalled TCP connections will hang forever. Every platform API call needs `timeout: 30_000`.

4. **Do not set the stale `publishing` recovery window to more than 2–3 minutes.** Legitimate publishes take ≤ 105 seconds (3 attempts × 30s + backoffs). 5 minutes is too long — posts stay stuck.

5. **Do not include `ai_image_url` in any `posts` SELECT query.** That column does not exist on the `posts` table. AI image URLs live in `media_items.cloud_url` where `cloud_provider = 'ai_generated'`.

6. **Do not seed `media-process` jobs for all media items.** Only seed for media attached to posts that still need publishing (`status IN ('draft', 'approved', 'scheduled', 'failed')`). Seeding the whole library kills video analysis and risks filling disk.

7. **Do not wrap all `startAllWorkers()` steps in a single try/catch.** Use independent `run(label, fn)` wrappers per step so one failure can't silently skip subsequent steps.

8. **Do not pass raw axios errors from Facebook to the user.** They say "Request failed with status code 400" which is useless. Always use the `fbCall()` wrapper that extracts `err.response?.data?.error`.

9. **Do not remove the DELETE before INSERT in `videoAnalysisService.js`.** The DELETE wipes old segments before inserting new ones. Without it, every re-run of analysis stacks duplicate rows — caused a real bug with 50 duplicate segments per video.

10. **Do not auto-reset 'failed' analysis items to 'pending' in `workers/index.js`.** Only 'analyzing' items (crashed mid-run) should be reset. Resetting 'failed' causes an infinite loop that holds the concurrency-1 analysis queue and starves all new video uploads.

11. **Do not remove `knownLength` from the Facebook multipart video upload.** Without it, `form-data` cannot set the `Content-Length` header on the file part and Facebook immediately rejects the upload with error 351.

12. **Do not move `access_token` from URL params into the form body for Facebook video uploads.** URL params are more reliable for large multipart uploads. This distinction took significant debugging to confirm.

13. **Do not call `queueVideoAnalysis()` without first removing any existing BullMQ job with the same jobId.** BullMQ deduplicates by jobId across ALL states including completed/failed. Without removal, re-analysis silently never runs. See `mediaAgent.js` for the correct pattern.

---

## Current Status (as of 2026-03-20)

**What works:**
- Auth, briefs, AI generation, WYSIWYG previews
- Media library, Google Drive integration
- AI image generation (Cloudflare Workers AI)
- Video analysis + clip picker UI (with live badge polling)
- Publishing queue (scheduling, status tracking, retry logic)
- Facebook OAuth + text publishing + **video publishing** ✅
- Instagram publishing (image + video via Reels) ✅
- **Comment-to-DM automation** (Facebook + Instagram) ✅
  - Per-post trigger keywords + single-message or multi-step flows
  - Conversation state machine with 24hr window enforcement
  - Lead collection (email, phone, name, custom fields) + CSV export
  - Rate-limited DM sending via Meta Graph API (no n8n dependency)
  - Frontend: per-post automation panel + leads dashboard
- BullMQ workers for all background jobs (7 queues + dm queue)
- Health check system with auto-remediation
- Intelligence dashboard

**What's pending:**
- All other platforms (Threads, TikTok, LinkedIn, X, YouTube) — stubs exist
- Stripe billing — skeleton only
- Threads OAuth — redirect URI needs real domain
- Meta App Review — `pages_messaging` and `instagram_manage_messages` scopes need approval
- Meta Webhook setup — register webhook URL in Meta Developer Portal for DM reply handling

**Immediate next action:**
1. Run the DM automation SQL migration in Supabase (see `backend/data/migration_dm_automations.sql`)
2. Reconnect Facebook in the app (to grant new messaging scopes)
3. Register Meta webhook (for multi-step DM reply handling)
4. Test with a published Facebook post: add trigger keyword, comment on it, verify DM arrives

## Decision Logging Rule

When a meaningful system or architecture decision is made:

- Suggest logging it in DECISIONS.md
- Format it as:

- Date:
- Decision:
- Reason:
- Impact:

Do not automatically modify files.
Wait for user confirmation before writing.

## Project Awareness Rule

Always check and follow the documentation inside:

/.claude/docs/

(This is the source of truth for system-level decisions, priorities, and direction)

Key files:
- SYSTEM_OVERVIEW.md (current focus and priorities)
- DECISIONS.md (past decisions and reasoning)
- handoff.md (system state and architecture)

Before suggesting solutions:
1. Read SYSTEM_OVERVIEW
2. Align with the current "Next Action"
3. Respect past decisions in DECISIONS

If a suggestion conflicts with documented decisions, ask before proceeding.