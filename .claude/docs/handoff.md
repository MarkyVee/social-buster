# Social Buster — Developer Handoff

**Last updated:** 2026-03-20
**Status:** Core platform (Phases 1–7) built and deployed on Coolify. Media publishing working (SQL migration completed). DM automation system fully built (backend + frontend). Facebook OAuth + text/image/video publishing all functional. DM automation testing blocked by Meta test user creation (temporarily disabled by Meta).

---

## What This App Is

Enterprise AI-powered social media marketing platform. Three core functions:

1. **AI post generation** — user submits a brief, LLM generates hook/caption/hashtags/CTA for each selected platform
2. **Comment-to-lead DM automation** — monitors comments for trigger phrases, fires DMs directly via Meta Graph API (no n8n)
3. **Auto-publishing** — scheduled or immediate publishing to 7 platforms via their native APIs

Target: 5,000 U.S. users. The stack is deliberately low-cost and swappable at every layer.

---

## Tech Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Runtime | Node.js + Express | Simple, async I/O matches our workload |
| Frontend | Plain HTML/CSS/JS (no React) | Zero build step, no framework updates to chase |
| Database | PostgreSQL via Supabase | RLS multi-tenancy out of the box, free tier |
| Auth | Supabase Auth | Email/password, JWT, no rolling your own sessions |
| Job Queue | BullMQ on Redis | Retry, backoff, visibility, survives restarts |
| LLM | OpenAI-compatible endpoint (default: Groq) | Swap provider by changing one env var |
| AI Images | Cloudflare Workers AI (Flux Schnell) | ~$0.0023/image, returns bytes directly |
| Video | FFmpeg (background only, never on request path) | Industry standard, full control |
| Storage | Supabase Storage (public buckets) | Same vendor as DB, public URLs, no auth at read time |
| DM Automation | Direct Meta Graph API (replaced n8n) | Zero cost, full conversation state control |
| Billing | Stripe (scaffolded, not live) | Not yet implemented |
| Deployment | Docker + Docker Compose → Coolify | Auto-deploy on push to main |

---

## Full Directory Structure

```
/social-buster
├── backend/
│   ├── server.js                     Main entry point. Starts Express, Redis, workers.
│   │                                 Contains: startup validation, health check loop,
│   │                                 global error handler, static file serving.
│   │                                 NOTE: Meta webhook route mounted BEFORE express.json()
│   │
│   ├── routes/
│   │   ├── auth.js                   Login, signup, logout, profile CRUD
│   │   ├── briefs.js                 Brief CRUD + triggers LLM generation via llmService
│   │   ├── posts.js                  Post CRUD (view/edit/delete generated posts).
│   │   │                             PUT /:id triggers mediaProcessQueue when media_id set.
│   │   │                             Checks analysis_status before re-queuing video analysis.
│   │   ├── media.js                  Media library, Drive scan trigger, video probe,
│   │   │                             AI image generation, media attachment
│   │   ├── publish.js                Platform OAuth connect/disconnect, manual publish.
│   │   │                             OAuth scopes: pages_show_list, pages_read_engagement,
│   │   │                             pages_manage_posts, pages_messaging, instagram_basic,
│   │   │                             instagram_content_publish
│   │   ├── automations.js            DM automation CRUD, lead listing, CSV export, stats.
│   │   │                             Routes: /automations (GET/POST), /:id (GET/PUT/DELETE),
│   │   │                             /:id/leads, /leads/export, /stats
│   │   ├── webhooks.js               Meta webhook receiver. GET = verify challenge,
│   │   │                             POST = incoming DM replies. HMAC-SHA256 signature check.
│   │   │                             Mounted BEFORE express.json() (needs raw body).
│   │   ├── intelligence.js           Intelligence dashboard data, research refresh
│   │   ├── billing.js                Stripe checkout + webhook (skeleton only)
│   │   ├── admin.js                  AdminJS dashboard + BullMQ Board (requireAdmin middleware)
│   │   └── messages.js               User-to-admin inbox (Tawk.to planned replacement)
│   │
│   ├── middleware/
│   │   ├── auth.js                   Validates Supabase JWT on every request.
│   │   │                             Sets req.user = { id, email }
│   │   ├── tenancy.js                Creates user-scoped Supabase client on req.db.
│   │   │                             All queries through req.db are auto-filtered to user_id.
│   │   └── rateLimit.js              express-rate-limit. standardLimiter, strictLimiter.
│   │
│   ├── agents/
│   │   ├── publishingAgent.js        Core publishing logic. processQueue() finds all
│   │   │                             scheduled posts, publishPost() handles retries.
│   │   │                             Checks process_status/processed_url, never
│   │   │                             touches Drive or OAuth directly.
│   │   ├── mediaProcessAgent.js      Copies media from cloud → Supabase Storage
│   │   │                             at post-attach time. Sets process_status = 'ready'.
│   │   ├── dmAgent.js                DM conversation state machine. startConversation(),
│   │   │                             processIncomingReply(), expireStaleConversations().
│   │   │                             Handles multi-step flows, data collection, opt-out.
│   │   ├── commentAgent.js           Ingests platform comments, matches against
│   │   │                             dm_automations trigger keywords, dispatches to dmAgent.
│   │   │                             Stores author_platform_id for DM sending.
│   │   ├── mediaAgent.js             Scans Google Drive/Dropbox, catalogs new files
│   │   │                             into media_items, triggers video analysis queue
│   │   ├── researchAgent.js          LLM-based niche/trend research. Result cached in
│   │   │                             Redis at research:{userId} with 7-day TTL
│   │   └── performanceAgent.js       Polls platform APIs for post metrics (likes,
│   │                                 comments, shares, reach) and stores in DB
│   │
│   ├── workers/
│   │   ├── index.js                  Orchestrator. require()s all workers (starts them),
│   │   │                             registers repeatable BullMQ jobs, seeds startup jobs.
│   │   │                             startAllWorkers() uses independent run() wrappers.
│   │   ├── publishWorker.js          Worker for 'publish' queue. Concurrency: 2.
│   │   │                             Calls processQueue() every 60 seconds.
│   │   ├── mediaProcessWorker.js     Worker for 'media-process' queue. Concurrency: 2.
│   │   │                             Calls processMediaItem() when user attaches media.
│   │   ├── dmWorker.js               Worker for 'dm' queue. Concurrency: 2, rate limited
│   │   │                             (max 10/minute). Handles send-dm and expire-stale jobs.
│   │   ├── mediaWorker.js            Worker for 'media-scan' queue. Runs Drive scan.
│   │   ├── mediaAnalysisWorker.js    Worker for 'media-analysis' queue. FFmpeg scene
│   │   │                             detection on videos. Concurrency: 2.
│   │   ├── commentWorker.js          Worker for 'comment' queue. Every 15 minutes.
│   │   ├── performanceWorker.js      Worker for 'performance' queue. Every 2 hours.
│   │   └── researchWorker.js         Worker for 'research' queue. Per-user, weekly cadence.
│   │
│   ├── services/
│   │   ├── platformAPIs.js           publish(), fetchMetrics(), fetchComments() for all 7
│   │   │                             platforms. Facebook fully implemented (text/image/video).
│   │   │                             fetchFacebookComments() and fetchInstagramComments()
│   │   │                             implemented — return authorPlatformId for DM sending.
│   │   │                             Others are documented stubs. Contains fbCall() wrapper.
│   │   ├── messagingService.js       DM sending adapter for Facebook + Instagram via
│   │   │                             Meta Graph API. Rate limited via Redis counters
│   │   │                             (100/day FB, 80/day IG). Uses POST /me/messages.
│   │   ├── llmService.js             OpenAI-compatible wrapper. Batches 3 platforms per
│   │   │                             LLM call to stay within token limits. Groq default.
│   │   ├── ffmpegService.js          downloadToTemp, probeVideo, trimVideo, cleanupTemp,
│   │   │                             PLATFORM_LIMITS. Never call from route handlers.
│   │   ├── imageGenerationService.js Cloudflare Workers AI (Flux Schnell). Returns PNG
│   │   │                             bytes directly — no temp URL download step.
│   │   ├── googleDriveService.js     Drive scan, downloadGoogleDriveFile().
│   │   │                             downloadGoogleDriveFile uses drive.files.get with
│   │   │                             alt:'media' (binary stream, not webViewLink).
│   │   ├── supabaseService.js        supabaseAdmin client (service role key). Use this
│   │   │                             in workers/agents. Use req.db in routes.
│   │   ├── tokenEncryption.js        AES-256-GCM encrypt/decrypt for stored OAuth tokens.
│   │   │                             TOKEN_ENCRYPTION_KEY must be ≥ 32 chars.
│   │   ├── redisService.js           ioredis wrapper. cacheGet/cacheSet/cacheDel.
│   │   ├── videoAnalysisService.js   FFmpeg scene detection + audio energy. Writes to
│   │   │                             video_segments table. retagUntaggedSegments() called
│   │   │                             at startup.
│   │   ├── visionTaggingService.js   LLM-based visual tagging of video segments
│   │   ├── promptLoader.js           Loads .txt prompt templates from /prompts/ folder
│   │   ├── alertService.js           SMTP email alerts (optional). Used by health check.
│   │   └── stripeService.js          Stripe SDK wrapper (skeleton only)
│   │
│   ├── queues/
│   │   └── index.js                  Defines all 7 BullMQ queues + shared Redis connection.
│   │                                 Exports: publishQueue, commentQueue, mediaScanQueue,
│   │                                 performanceQueue, researchQueue, mediaAnalysisQueue,
│   │                                 mediaProcessQueue, dmQueue, connection
│   │
│   ├── data/                         Temp files ONLY. Always cleaned up. Never commit.
│   │   └── migration_dm_automations.sql  SQL migration for DM automation tables (already run)
│   └── .env                          All environment variables. Never commit.
│
├── frontend/public/
│   ├── index.html                    Single HTML file. All views are hash-routed (#brief,
│   │                                 #dashboard, #media, #queue, #intelligence, #automations)
│   ├── css/
│   │   ├── styles.css                Main app styles
│   │   └── platforms.css             Platform-specific icons and color chips
│   └── js/
│       ├── app.js                    Main shell. Auth, routing, post rendering, queue
│       │                             rendering. Includes DM Automations sidebar nav +
│       │                             automations view with stats/leads tables.
│       ├── brief.js                  Brief form + AI generation UI. Multi-step wizard.
│       ├── preview.js                WYSIWYG post preview — renders per-platform mock.
│       │                             Includes DM automation panel (keyword tags, flow type,
│       │                             step builder, auto-CTA on save).
│       ├── publish.js                Publishing queue UI, status polling, platform
│       │                             OAuth connect/disconnect flows
│       ├── media.js                  Media library, Drive connect, clip picker, video
│       │                             analysis badges, AI image generation UI
│       ├── messages.js               User inbox UI
│       └── admin.js                  Admin dashboard UI (requireAdmin)
│
├── docker/
│   ├── docker-compose.yml            Defines: backend, redis services + volumes (n8n removed)
│   └── Dockerfile.backend            Node.js image with FFmpeg installed
│
└── CLAUDE.md                         Project context for Claude Code sessions
```

---

## Every Major Feature Built

### Phase 1 — Auth + Multi-Tenancy
- Supabase Auth (email/password). JWT validated via `middleware/auth.js` on every request.
- `middleware/tenancy.js` creates a user-scoped Supabase client at `req.db`. Every query through `req.db` is automatically filtered to the authenticated user's `user_id`. Workers use `supabaseAdmin` directly.
- Supabase RLS policies enforce data isolation at the database level — even if application code has a bug, the DB won't serve another user's data.
- **Missing:** Password/email recovery flow (not yet built).

### Phase 2 — Brief System + AI Post Generation
- Brief form: niche, platform selection, tone, post type, objective, style notes, media options.
- Submit triggers `llmService.generatePosts()` — LLM produces hook/caption/hashtags/CTA for each platform.
- Posts saved to `posts` table with `status = 'draft'`, linked to brief via `brief_id`.
- LLM batches 3 platforms per call (token limit management). 7 platforms = 3 sequential LLM calls.
- **Removed:** "Who is this post for?" (`target_audience`) field — redundant because target audience is already in the user profile.

### Phase 3 — User Profile Expansion
- `user_profiles` table extended with: `industry`, `business_type`, `geo_region`, `target_age_range`, `content_preferences`, `posting_frequency`, `brand_voice_notes`.
- These feed the intelligence engine's cohort matching key: `industry + business_type + geo_region + target_age_range + platform`.

### Phase 4 — Media Library
- Users connect Google Drive via OAuth. `mediaAgent` scans every 30 minutes, catalogs files into `media_items` table.
- AI image generation: user prompts Cloudflare Workers AI (Flux Schnell), image saved to Supabase Storage bucket `ai-generated-images`, cataloged with `cloud_provider = 'ai_generated'`.
- Media attached to posts by setting `media_id` on the post row.
- `media_items` table columns: `id, user_id, cloud_url, cloud_provider, file_type, filename, duration_seconds, analysis_status, process_status, processed_url, process_error, processed_at`.
- **SQL migration completed** — `process_status`, `processed_url`, `process_error`, `processed_at` columns exist and are working.

### Phase 4b — Video Analysis Pipeline
- Videos analyzed once in background on upload via FFmpeg scene detection + audio energy.
- Results stored in `video_segments` table: `start_time, end_time, thumbnail_url, energy_level, pacing, mood, tags`.
- Clip picker UI shows 3–5 suggested segments. User selects one — clip is pre-rendered at selection time.
- Pre-rendered clip uploaded to Supabase Storage bucket `video-segments`.
- `analysis_status` state machine: `pending → analyzing → done / failed`.
- **Fixed:** Videos no longer re-analyze when attached to a new post if `analysis_status` is already `ready` or `analyzing`.

### Phase 5 — Publishing Queue + Platform OAuth
- **UX change:** Replaced "Approve → modal → Schedule" flow with inline buttons: **Save Draft**, **Schedule**, **Publish Now**.
- Post statuses: `draft → scheduled → publishing → published / failed`.
- Publishing queue and Generated Posts both render newest-first.
- Facebook OAuth fully functional. Stores Page ID as `platform_user_id`, encrypted Page Access Token in `platform_connections`.
- OAuth scopes: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `pages_messaging`, `instagram_basic`, `instagram_content_publish`.
- Other platforms (Instagram, TikTok, LinkedIn, X, Threads, YouTube) are OAuth-scaffolded but not completed.

### Phase 5b — BullMQ Job Queue
- Replaced all `setInterval` polling loops with BullMQ workers backed by Redis.
- 7 queues: `publish` (60s), `comment` (15min), `media-scan` (30min), `media-analysis` (per video), `media-process` (per post-attach), `dm` (per DM send, rate limited), `performance` (2hr), `research` (weekly per user).
- All repeatable jobs use fixed `jobId` — safe to restart server without creating duplicate jobs.
- `workers/index.js` `startAllWorkers()` uses independent `run(label, fn)` wrapper per step.

### Phase 6 — Collective Intelligence Schema
- `video_segments` stores per-segment metadata for collective intelligence matching.
- `performanceAgent` polls platform metrics and feeds the intelligence loop.
- Intelligence dashboard shows signals and posting recommendations.

### Phase 7 — Enriched Brief Metadata
- Brief selections have semantic profiles: `video_energy`, `video_pacing`, `video_mood`, `ideal_segments`, `llm_style_note`.
- Brief is the single source of truth for copy generation, clip matching, and intelligence signals.

### Phase 8 — DM Automation System (Comment-to-Lead)
- **Architecture:** Direct Meta Graph API calls (n8n completely removed from the project).
- **Per-post trigger keywords:** Each post gets its own automation with trigger keywords, DM flow type, and message steps.
- **Two flow types:**
  - **Single:** One DM sent immediately (e.g., a link or resource).
  - **Multi-step:** Back-and-forth conversation collecting data (email, phone, name, custom fields).
- **Conversation state machine:** `active → collecting → completed | expired | opted_out`.
- **24-hour messaging window:** Meta only allows DMs to users who interacted within 24 hours. `expireStaleConversations()` runs every 30 minutes.
- **Rate limiting:** 100 DMs/day Facebook, 80/day Instagram (Redis counters in messagingService).
- **Meta webhook:** `POST /webhooks/meta` receives incoming DM replies. HMAC-SHA256 signature verification. Must be registered in Meta Developer Portal.
- **Auto-CTA:** When a user saves a DM automation, the post's CTA field automatically gets a line like `Comment "KEYWORD" below to get it!` — user can edit freely before publishing.
- **Frontend:**
  - DM Automation button on every Facebook/Instagram post card (any status, not just published).
  - Full automation panel: keyword tag chips, flow type radio, step builder with field collection dropdowns.
  - DM Automations sidebar nav → dedicated view with stats cards (active automations, conversations, leads, daily DM usage), automations list, leads table, CSV export.
- **Database tables (migration completed):**
  - `dm_automations` — per-post automation config (trigger_keywords, flow_type, active flag)
  - `dm_automation_steps` — ordered steps with message_template and collects_field
  - `dm_conversations` — conversation state per commenter (status, current_step, author info)
  - `dm_collected_data` — field/value pairs collected during multi-step conversations

### Health Check System (built into server.js)
- Quick check every 5 minutes: Redis ping, worker liveness, failed job counts.
- Full check every 60 minutes: DB connectivity, env vars, Cloudflare AI, LLM endpoint.
- Auto-remediates: retries failed BullMQ jobs up to 3 times, discards permanently failed jobs.
- Email alerts (SMTP) on status CHANGE only — not on every check. Falls back to console logs if SMTP not configured.
- Log prefixes for monitoring: `[HEALTH OK]`, `[HEALTH DEGRADED]`, `[HEALTH CRITICAL]`.

---

## Media Architecture (Two-Phase, Do Not Revert)

### Phase 1 — Copy at Attach Time (`mediaProcessAgent.js`)
Triggered from `routes/posts.js` PUT `/:id` whenever `media_id` is set on a post.

| Provider | Action |
|----------|--------|
| `ai_generated` | Already in Supabase — sets `processed_url = cloud_url` directly, no upload needed |
| `google_drive` | Downloads via `drive.files.get({alt: 'media'})` (authenticated binary stream) → uploads to Supabase Storage `processed-media` bucket |
| `manual` / others | Assumes cloud_url is publicly accessible — uses it directly |

After this runs: `process_status = 'ready'`, `processed_url` = permanent Supabase public URL.

### Phase 2 — Publish Using Supabase URL (`publishingAgent.js`)
No Drive API. No OAuth. No token refresh. The agent:
1. Checks `process_status === 'ready'` — if not, marks post `failed` with clear message.
2. Reads `processed_url` — passes directly to Facebook API.
3. **Images**: URL passed to Facebook `/photos?url=` — Facebook fetches from Supabase directly. No local file.
4. **Videos**: Downloads from Supabase to temp file → FFmpeg trim if needed → temp file path to platform API.

### Supabase Storage Buckets (all PUBLIC — required)
| Bucket | Contents |
|--------|----------|
| `ai-generated-images` | AI-generated images (Cloudflare Workers AI output) |
| `video-segments` | Pre-rendered trimmed clips (selected via clip picker) |
| `processed-media` | Copies of Drive/manual media, used at publish time |

---

## DM Automation Architecture

### How It Works (End to End)
1. **User creates automation** on a post via the DM Automation panel in preview.js.
2. **Auto-CTA** is appended to the post's CTA field (e.g., `Comment "BTS" below to get it!`).
3. **User publishes** the post to Facebook/Instagram.
4. **Someone comments** with the trigger keyword.
5. **commentWorker** (every 15 min) ingests comments via `fetchFacebookComments()`/`fetchInstagramComments()`.
6. **commentAgent** matches comment text against `dm_automations.trigger_keywords` for that post.
7. If match found, **dmAgent.startConversation()** creates a `dm_conversations` row and queues a `send-dm` job.
8. **dmWorker** decrypts the page access token and calls `messagingService.sendDM()`.
9. For **multi-step flows**, incoming replies arrive via **Meta webhook** → `dmAgent.processIncomingReply()` advances steps and collects data.
10. **Collected data** (email, phone, etc.) stored in `dm_collected_data` table, viewable and exportable as CSV.

### Meta Webhook Setup (Required for Multi-Step DMs)
1. In Meta Developer Portal → Your App → Webhooks
2. Subscribe to `messages` field on the Page
3. Callback URL: `https://yourdomain.com/webhooks/meta`
4. Verify token: set `META_WEBHOOK_VERIFY_TOKEN` env var to match

### Important Limitations
- **24-hour window:** Meta only allows messaging users who interacted within 24 hours.
- **App Review required for production:** `pages_messaging` and `pages_read_engagement` need Meta App Review to work with non-test users in Live mode.
- **Page owner can't DM self:** When the page admin comments on their own post, Facebook identifies them as the Page, not a user. Can't send DM to yourself.
- **Test user creation temporarily disabled by Meta** (as of 2026-03-20). Alternative: add a real person as a "Tester" role in App Roles.

---

## All Approaches Tried That Failed

### 1. Using Google Drive `webViewLink` URL directly
**Tried:** Passing `cloud_url` (a `https://drive.google.com/file/d/{id}/view` URL) directly to Facebook's `/photos?url=` parameter or to `downloadToTemp()`.
**Failed because:** `webViewLink` requires a browser session with Google login cookies. Raw HTTP requests get an HTML redirect/login page — not the file binary. Facebook received HTML and returned 400. `downloadToTemp()` wrote the HTML to disk and sent it as an "image".

### 2. `downloadToTemp` with unauthenticated Drive URL
**Tried:** Using `ffmpegService.downloadToTemp()` to download the Drive URL before publishing.
**Failed because:** Same root cause — `downloadToTemp` uses plain `https.get()` with no Drive OAuth. The URL is not a direct download endpoint.

### 3. `axios` with no timeout in Docker/VPS
**Tried:** Original `axios.post()` calls to Facebook API had no `timeout` parameter.
**Failed because:** In Docker/VPS networking, TCP connections to Facebook's servers can stall at the network layer without triggering a socket error. Node's default socket timeout doesn't apply to established but stalled connections. `axios` waited forever, causing posts to hang in "Publishing..." indefinitely.
**Fix applied:** Added `timeout: 30_000` to every `axios` call in `publishToFacebook()`.

### 4. 5-minute stale post recovery window
**Tried:** Original stale `publishing` recovery was 5 minutes.
**Wrong because:** Legitimate publish time (3 attempts × 30s timeout + backoffs) ≈ 105 seconds. 5 minutes was too long — posts were stuck in "Publishing..." for 5 minutes before being reset.
**Fix:** Reduced to 2 minutes.

### 5. `seedPendingMediaProcessing` queuing ALL media items
**Tried:** On server startup, seeded `process-media-item` jobs for every `media_items` row where `process_status != 'ready'`.
**Failed because:** This queued large video downloads for every item in the media library — including videos that had nothing to do with pending posts. Competed with `mediaAnalysisQueue` for disk and CPU, broke the video analysis pipeline entirely, and could fill VPS disk.
**Fix:** Scoped the seed to only media attached to posts with `status IN ('draft', 'approved', 'scheduled', 'failed')`.

### 6. Single try/catch in `startAllWorkers()`
**Tried:** One top-level try/catch wrapping all startup seed functions.
**Failed because:** If any seed function threw (e.g., `seedPendingVideoAnalysis`), all subsequent functions were silently skipped. `retagUntaggedSegments()` never ran after the refactor.
**Fix:** Independent `run(label, fn)` wrapper per step — each logs its own failure, never blocks others.

### 7. `posts.ai_image_url` column in SELECT query
**Tried:** Old `publishingAgent` SELECT included `ai_image_url` in the column list.
**Failed because:** That column never existed in `posts` (it was tracked in `media_items`). This crashed the entire publishing queue — every single post failed with "column posts.ai_image_url does not exist" before any publish attempt was made.
**Fix:** Removed from SELECT entirely. AI images tracked via `media_items.cloud_url` with `cloud_provider = 'ai_generated'`.

### 8. Facebook 400 errors showing as generic axios message
**Tried:** Reading `err.message` from failed axios calls.
**Got:** Always "Request failed with status code 400" — zero information.
**Fix:** Added `fbCall()` wrapper in `publishToFacebook()` that reads `err.response?.data?.error` and re-throws as `Facebook error {code}: {message} (type: {type})`. Now logs show actual Facebook errors (e.g., "error 506: Duplicate post", "error 190: Invalid token").

### 9. Google Drive `redirect_uri_mismatch` in production
**Tried:** Google Drive OAuth redirect URI was hardcoded to `http://localhost:3000/auth/google/callback`.
**Failed in production:** Google rejected it because the actual redirect came from the production domain.
**Fix:** Replaced hardcode with `${process.env.FRONTEND_URL}/auth/google/callback`. Added `FRONTEND_URL` to `.env`. Must register this exact URI in Google Cloud Console OAuth credentials.

### 10. `instagram_manage_messages` as OAuth scope
**Tried:** Adding `instagram_manage_messages` to Facebook Login OAuth scopes for Instagram DM support.
**Failed because:** Facebook returned "Invalid Scopes: instagram_manage_messages" — this scope does not exist for Facebook Login. It's an Instagram Graph API permission, not a Facebook Login scope.
**Fix:** Removed entirely. `pages_messaging` covers both Facebook Messenger and Instagram DMs.

### 11. n8n for DM automation
**Tried:** Using n8n (self-hosted) to send DMs after comment trigger.
**Removed because:** n8n doesn't have access to encrypted OAuth tokens, can't manage conversation state (multi-step flows), adds Docker complexity, and the integration was a single webhook call. Direct Meta Graph API is simpler, free, and gives full control.
**Fix:** n8n completely removed from docker-compose.yml. DMs sent directly via `messagingService.js`.

### 12. Re-analyzing already-analyzed videos on post attach
**Tried:** `posts.js` PUT route queued video analysis for every video attached to a post, regardless of `analysis_status`.
**Failed because:** FFmpeg scene detection + audio analysis takes time. Re-running it on every attachment to a new post was wasteful and caused "Analyzing..." delays on videos that had already been analyzed.
**Fix:** Added `analysis_status !== 'ready' && analysis_status !== 'analyzing'` check before queuing analysis.

---

## Key Architectural Decisions

### No OAuth at publish time — ever
The publish worker must NEVER call Drive API, Google OAuth, token refresh, or any authenticated external service. All auth-dependent operations run at attach time via `mediaProcessAgent`. This is the single most important architectural rule for reliability.

### Multi-tenancy is enforced at two layers
1. **Application layer:** All route queries use `req.db` (tenant-scoped client from `tenancy.js`). Workers use `supabaseAdmin` with explicit `.eq('user_id', userId)` on every query.
2. **Database layer:** Supabase RLS policies. Data cannot leak between users even if application code has a bug.

Never remove the user_id filter from any query. Never use `supabaseAdmin` in a route handler without manually filtering by user_id.

### No vendor lock-in — adapter pattern everywhere
- LLM: swap Groq → OpenAI → local by changing `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`
- Platform APIs: all publishing goes through `services/platformAPIs.js`
- DM sending: all goes through `services/messagingService.js`
- Storage uploads: all go through `mediaProcessAgent.uploadToSupabase()`
- Never call third-party SDKs directly from route handlers or agents

### BullMQ jobId deduplication
Every job that could be queued multiple times uses a fixed `jobId`:
- `repeatable:scan-and-publish` — never create two scan cycles
- `process-media-{mediaItemId}` — never download the same Drive file twice concurrently
- `analyze-video-{mediaItemId}` — never double-analyze the same video
- `research-user-weekly-{userId}` — never run research for the same user twice

### Videos vs images at publish time
- **Images:** URL passed to platform API. Platform fetches from Supabase. No temp file, no FFmpeg.
- **Videos:** Downloaded from Supabase to temp (`ffmpegService.downloadToTemp`) → FFmpeg trim if needed → `post.media_local_path` set → platform API receives local file path. Temp files always cleaned in `finally` block.

### `process_status` state machine
```
pending  →  processing  →  ready
                        ↘  failed  (process_error explains why)
```
The `processing` state is the concurrent-access guard — only one BullMQ job can move an item from `pending/failed` to `processing` at a time (the `.in('process_status', ['pending', 'failed'])` filter on the UPDATE is the lock).

### Billing cycles
30-day rolling cycles (not calendar monthly). User renews 30 days from their signup date. Plan prices in `.env`: `PLAN_PRICE_STARTER`, `PLAN_PRICE_PROFESSIONAL`, `PLAN_PRICE_ENTERPRISE`.

---

## Platform Publishing Status

| Platform | OAuth | Publish | Comments | DMs | Notes |
|----------|-------|---------|----------|-----|-------|
| Facebook | ✅ Working | ✅ Text+Image+Video | ✅ Fetching works | ✅ Built (needs App Review) | Only live platform |
| Instagram | ✅ Scaffolded | ❌ Stub | ✅ Fetching works | ✅ Built (needs App Review) | Uses same Page token as FB |
| TikTok | ❌ | ❌ Stub | ❌ | ❌ | Needs `TIKTOK_CLIENT_KEY/SECRET` |
| LinkedIn | ❌ | ❌ Stub | ❌ | ❌ | Needs `LINKEDIN_CLIENT_ID/SECRET` |
| X | ❌ | ❌ Stub | ❌ | ❌ | Needs `X_CLIENT_ID/SECRET` |
| Threads | ✅ Scaffolded | ❌ Stub | ❌ | ❌ | Redirect URIs need real domain |
| YouTube | ❌ | ❌ Stub | ❌ | ❌ | Needs separate OAuth setup |

---

## How to Read Logs (Coolify)

Coolify → project → **Deployments** → live deployment → **Logs**.

Key log prefixes:
- `[PublishingAgent]` — publishing flow, per-post
- `[MediaProcess]` — media copy job (attach time)
- `[MediaProcessWorker]` — worker-level errors
- `[PublishWorker]` — worker-level errors
- `[PlatformAPIs]` — Facebook API calls, actual errors
- `[CommentAgent]` — comment ingestion, trigger matching, DM dispatch
- `[DMAgent]` — conversation state changes, data collection
- `[DMWorker]` — DM send attempts, token decryption
- `[MessagingService]` — actual DM API calls, rate limit checks
- `[HEALTH OK/DEGRADED/CRITICAL]` — health check results

Good publish flow looks like:
```
[PublishingAgent] ── START post {id} → facebook ──
[PublishingAgent]    media_id={id} scheduled_at={time}
[PublishingAgent]    platform_user_id={pageId}
[PublishingAgent]    media lookup: found=true err=none
[PublishingAgent]    media: provider=google_drive type=image status=ready processedUrl=https://...
[PublishingAgent]    media ready: image @ https://...supabase.co/...
[PlatformAPIs] Facebook publish — pageId=... mediaType=image mediaLocalPath=none mediaUrl=https://...
[PublishingAgent] ── DONE post {id} → published ──
```

Good DM flow looks like:
```
[CommentAgent] Matched keyword "BTS" for post {postId}, automation {autoId}
[DMAgent] Starting conversation for {authorHandle} on facebook
[DMWorker] Processing send-dm job {jobId}
[MessagingService] Facebook DM sent to {recipientId}
```

If you see `Facebook error 506` → duplicate content (testing artifact, not a bug).
If you see `Facebook error 190` → access token expired or revoked.
If you see `Comment error 10` → `pages_read_engagement` needs Meta App Review.

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

# Facebook OAuth
FACEBOOK_APP_ID=
FACEBOOK_APP_SECRET=

# Google Drive OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://yourdomain.com/auth/google/callback

# Meta Webhook (for DM automation reply handling)
META_WEBHOOK_VERIFY_TOKEN=

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

## What's Pending (In Priority Order)

1. **Password/email recovery** — no way for users to reset forgotten passwords or change email (next up)
2. **Meta App Review** — required for `pages_messaging` and `pages_read_engagement` to work with real users (not just testers). Blocks DM automation + comment ingestion in production.
3. **Meta webhook registration** — register `https://yourdomain.com/webhooks/meta` in Meta Developer Portal for multi-step DM reply handling
4. **DM automation end-to-end test** — blocked by Meta test user creation being temporarily disabled. Alternative: add a real person as "Tester" role.
5. **Stripe billing** — checkout sessions, webhook handler, tier gating on routes
6. **Tier limits editor** — DB-driven per-tier feature caps, admin can change without redeploy
7. **Privacy Policy page** — required before Meta App Review (blocks Instagram/Threads/DMs in production)
8. **Help section** — written docs + video tutorials
9. **Tawk.to messaging widget** — replace current messages system
10. **OAuth for remaining platforms** — Instagram publish, LinkedIn, TikTok, X, YouTube
11. **Single session enforcement** — `active_session_id` on `user_profiles`, check in auth middleware
12. **Admin dashboard** — user management, daily health check UI
13. **Repost from Intelligence Dashboard** — one-click reschedule
14. **Threads + Meta redirect URIs** — update to real domain after deployment
15. **WhatsApp** — 8th platform via WhatsApp Business API (future)
