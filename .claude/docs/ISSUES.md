# Issues Log

Track bugs, problems, and blockers discovered during development.

## Format
- **ID:** ISSUE-001
- **Date:** YYYY-MM-DD
- **Status:** open | in-progress | resolved | wont-fix
- **Description:**
- **Found in:** (file or area)
- **Resolution:** (if resolved)

---

## Open Issues

### CRITICAL — Security

- **ID:** ISSUE-001
- **Date:** 2026-03-25
- **Status:** resolved
- **Category:** CRITICAL / Security
- **Description:** OAuth state parameter uses plain base64 on Meta, Threads, TikTok, LinkedIn, X callbacks. No server-side nonce validation. Attacker can forge state and connect their page to a victim's account. Google Drive already does this correctly with Redis nonce — apply same pattern to all platforms.
- **Found in:** `backend/routes/publish.js` (lines 83, 269, 386, 464, 537)
- **Resolution:** All 5 OAuth start endpoints now generate `crypto.randomBytes(32)` nonce stored in Redis (`oauth_nonce:{nonce}`, 10-min TTL). All 5 callbacks look up the nonce to get userId. Single-use (deleted after lookup).

---

- **ID:** ISSUE-002
- **Date:** 2026-03-25
- **Status:** resolved
- **Category:** CRITICAL / Security
- **Description:** X OAuth PKCE code verifier is keyed by untrusted state parameter (`x_pkce:${state}`). Attacker-controlled state could load attacker's PKCE verifier, enabling replay attacks.
- **Found in:** `backend/routes/publish.js` (lines 537-541)
- **Resolution:** State is now a cryptographic nonce (not userId). PKCE verifier keyed by the nonce, which is unguessable. Nonce validated via Redis before PKCE lookup.

---

- **ID:** ISSUE-003
- **Date:** 2026-03-25
- **Status:** resolved
- **Category:** CRITICAL / Security
- **Description:** Meta webhook signature verification is optional — only runs `if (appSecret)`. If `FACEBOOK_APP_SECRET` is unset, ANY attacker can POST fake webhook events to `/webhooks/meta` and trigger DM automation, comment processing, data exfiltration.
- **Found in:** `backend/routes/webhooks.js` (lines 93-112)
- **Resolution:** Verification is now mandatory. If no app secret is configured, ALL webhooks are rejected with a log error. Also checks `META_APP_SECRET` as fallback env var name.

---

### HIGH — Security

- **ID:** ISSUE-004
- **Date:** 2026-03-25
- **Status:** resolved
- **Category:** HIGH / Security
- **Description:** Rate limiting silently allows ALL requests when Redis is down. No fallback limiter. Enables brute force and DoS during Redis outages.
- **Found in:** `backend/middleware/rateLimit.js` (lines 48-77)
- **Resolution:** Added in-memory fallback rate limiter (`checkMemoryRateLimit`). When Redis is unavailable, requests are rate-limited using a per-process Map with auto-expiring entries. Prevents brute force during outages. `X-RateLimit-Fallback: true` header set for monitoring.

---

- **ID:** ISSUE-005
- **Date:** 2026-03-25
- **Status:** resolved
- **Category:** HIGH / Security
- **Description:** Logout does not clear `active_session_id` from user_profiles or Redis. Old sessions could potentially be reused after logout.
- **Found in:** `backend/routes/auth.js` (line 201)
- **Resolution:** Logout now clears `active_session_id` from `user_profiles` after Supabase sign-out. Non-fatal if DB update fails (token is already invalidated by Supabase).

---

- **ID:** ISSUE-006
- **Date:** 2026-03-25
- **Status:** open
- **Category:** HIGH / Security
- **Description:** No rate limiting on public OAuth callback endpoints. Attacker can spam these to trigger repeated OAuth flows.
- **Found in:** `backend/routes/publish.js` (line 64), `backend/routes/media.js` (line 58)

---

- **ID:** ISSUE-007
- **Date:** 2026-03-25
- **Status:** open
- **Category:** HIGH / Security
- **Description:** Helmet CSP is disabled (`contentSecurityPolicy: false`). No clickjacking protection (`X-Frame-Options`), no script injection prevention. App can be iframed by attackers.
- **Found in:** `backend/server.js`

---

### CRITICAL — Scalability

- **ID:** ISSUE-008
- **Date:** 2026-03-25
- **Status:** resolved
- **Category:** CRITICAL / Scalability
- **Description:** Missing composite index on `posts(status, scheduled_at)`. Publish cycle runs every 60s and scans the entire posts table. At 5,000 users (~50K posts), this causes DB CPU spikes every minute.
- **Found in:** `backend/agents/publishingAgent.js` (lines 75-81)
- **Resolution:** Migration file created at `backend/data/migration_performance_indexes.sql`. Includes 4 indexes: posts(status, scheduled_at), posts(user_id, status), dm_conversations(user_id, status), post_comments(post_id, created_at). **USER ACTION: Run this SQL in Supabase SQL Editor.**

---

- **ID:** ISSUE-009
- **Date:** 2026-03-25
- **Status:** wont-fix
- **Category:** CRITICAL / Scalability (DOWNGRADED — not a real issue)
- **Description:** New Supabase client created per HTTP request in tenancy middleware. Originally flagged as "connection exhaustion" — **this was wrong.** Supabase JS client is an HTTP wrapper, NOT a connection manager. PostgREST + Supavisor handle PostgreSQL connection pooling on Supabase's infrastructure. Caching clients by JWT would introduce multitenancy security risks (token mixups, expired auth state, shared request context) for negligible GC savings (~500 bytes per request). The current pattern (one fresh client per request) is correct and recommended by Supabase.
- **Found in:** `backend/middleware/tenancy.js` (line 35)
- **Resolution:** Won't fix. Idea Destroyer analysis confirmed this is premature optimization that trades security for unmeasured gains. Real scalability bottlenecks are ISSUE-008 (indexes, fixed), ISSUE-010 (N+1 queries), ISSUE-011 (memory bloat).

---

### HIGH — Scalability

- **ID:** ISSUE-010
- **Date:** 2026-03-25
- **Status:** open
- **Category:** HIGH / Scalability
- **Description:** Admin dashboard N+1 query pattern. Loads all users, then loops to count posts individually per user. At 5,000 users, dashboard takes 60-120 seconds to load.
- **Found in:** `backend/routes/admin.js` (lines 477-494, 599-600)

---

- **ID:** ISSUE-011
- **Date:** 2026-03-25
- **Status:** open
- **Category:** HIGH / Scalability
- **Description:** `performanceAgent` loads ALL published posts from last 30 days into memory with no pagination. At 5,000 users (~50K posts), this is 50+ MB per cycle (every 2 hours). Then fetches metrics 1-by-1 per post via platform API.
- **Found in:** `backend/agents/performanceAgent.js` (lines 42-47, 95-120)

---

- **ID:** ISSUE-012
- **Date:** 2026-03-25
- **Status:** open
- **Category:** HIGH / Scalability
- **Description:** No per-account rate limiting on platform API calls. Multiple publishing jobs can hit the same user's platform account simultaneously. Risks platform bans (24-hour lockouts).
- **Found in:** `backend/services/platformAPIs.js`

---

### CRITICAL — Security (Deep Review)

- **ID:** ISSUE-013
- **Date:** 2026-03-25
- **Status:** resolved
- **Category:** CRITICAL / Security
- **Description:** LLM Prompt Injection — user brief content (tone, notes, objective) is interpolated directly into LLM system prompts in `llmService.js` without sanitization. Malicious user can craft a brief that leaks system prompts, bypasses content filters, or generates harmful content that gets published to social platforms.
- **Found in:** `backend/services/llmService.js` (lines 108-130), `backend/routes/briefs.js` (lines 80-135)
- **Resolution:** Added `sanitizeForPrompt()` function that strips role overrides, instruction resets, system prompt leak attempts, and prompt boundary manipulation. Applied to all free-text fields (notes, target_audience, brand_name, industry, brand_voice). Enum fields already validated in routes. 2000-char limit prevents context stuffing.

---

### HIGH — Security (Deep Review)

- **ID:** ISSUE-014
- **Date:** 2026-03-25
- **Status:** wont-fix (false positive)
- **Category:** HIGH / Security
- **Description:** Admin dashboard XSS — `brand_name`, `subscription.plan`, and other user-controlled fields rendered via `innerHTML` without calling `escapeAdminHtml()`. Stored XSS fires when admin views user list. Attacker sets brand_name to script payload → admin session exfiltrated.
- **Found in:** `frontend/public/js/admin.js` (line ~350)
- **Resolution:** Manual code review confirmed all user-controlled fields (email, brand_name, industry, subscription_tier, hooks, platform, admin_notes) are consistently escaped with `escapeAdminHtml()`. The audit agent was wrong — this was a false positive.

---

- **ID:** ISSUE-015
- **Date:** 2026-03-25
- **Status:** resolved
- **Category:** HIGH / Security
- **Description:** DM reply text has no length validation. Attacker can reply to a DM with a 10MB text string, causing database bloat and crashing CSV exports / admin UI when rendering lead data.
- **Found in:** `backend/agents/dmAgent.js` (lines 233-245)
- **Resolution:** Added `.slice(0, 2000)` truncation on DM reply text before inserting into `dm_collected_data`. 2000 chars is generous for email/phone/name fields while preventing abuse.

---

- **ID:** ISSUE-016
- **Date:** 2026-03-25
- **Status:** open
- **Category:** HIGH / Security
- **Description:** OAuth result cookies missing `Secure` flag. On HTTPS production site, cookies can be sent over HTTP if user visits non-HTTPS URL. Also `SameSite=lax` instead of `strict`.
- **Found in:** `backend/routes/publish.js` (lines 68-74)

---

### MEDIUM — Security (Deep Review)

- **ID:** ISSUE-017
- **Date:** 2026-03-25
- **Status:** open
- **Category:** MEDIUM / Security
- **Description:** No startup validation of required environment variables. Server starts even if critical vars (`TOKEN_ENCRYPTION_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `REDIS_HOST`) are missing. Failures surface at runtime, not boot.
- **Found in:** `backend/server.js`

---

- **ID:** ISSUE-018
- **Date:** 2026-03-25
- **Status:** open
- **Category:** MEDIUM / Security
- **Description:** `axios` package is outdated (2023 version) with known CVEs for prototype pollution. Used for all external API calls (platform APIs, LLM, Cloudflare).
- **Found in:** `backend/package.json`

---

## Resolved Issues

_(none yet)_
