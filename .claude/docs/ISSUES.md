# Issues Log

Track bugs, problems, and blockers discovered during development. It is okay to not have the answer. We can get second opinions. 

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
- **Status:** resolved
- **Category:** HIGH / Security
- **Description:** No rate limiting on public OAuth callback endpoints. Attacker can spam these to trigger repeated OAuth flows.
- **Found in:** `backend/routes/publish.js` (line 64), `backend/routes/media.js` (line 58)
- **Resolution:** Added `authLimiter` (20 req/min per IP) to all 6 OAuth callback endpoints: Meta, Threads, TikTok, LinkedIn, X, and Google Drive.

---

- **ID:** ISSUE-007
- **Date:** 2026-03-25
- **Status:** resolved
- **Category:** HIGH / Security
- **Description:** Helmet CSP is disabled (`contentSecurityPolicy: false`). No clickjacking protection (`X-Frame-Options`), no script injection prevention. App can be iframed by attackers.
- **Found in:** `backend/server.js`
- **Resolution:** Configured Helmet with proper CSP directives (self + unsafe-inline for our plain JS frontend, https for images/APIs), frameguard deny (blocks iframing), noSniff, and xssFilter.

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
- **Status:** resolved
- **Category:** HIGH / Scalability
- **Description:** Admin dashboard N+1 query pattern. Single-user detail fetched ALL post rows just to count by status.
- **Found in:** `backend/routes/admin.js` (line 593)
- **Resolution:** Replaced row-fetch-then-count with parallel `{ count: 'exact', head: true }` queries per known status. Returns only counts, never loads post rows.

---

- **ID:** ISSUE-011
- **Date:** 2026-03-25
- **Status:** resolved
- **Category:** HIGH / Scalability
- **Description:** `performanceAgent` loads ALL published posts from last 30 days into memory with no pagination. At 5,000 users (~50K posts), this is 50+ MB per cycle (every 2 hours).
- **Found in:** `backend/agents/performanceAgent.js` (lines 42-47)
- **Resolution:** Added cursor-based pagination with BATCH_SIZE=500. Both the main post fetch and cohort metric aggregation now paginate through results instead of loading everything at once.

---

- **ID:** ISSUE-012
- **Date:** 2026-03-25
- **Status:** resolved
- **Category:** HIGH / Scalability
- **Description:** No per-account rate limiting on platform API calls. Multiple publishing jobs can hit the same user's platform account simultaneously. Risks platform bans (24-hour lockouts).
- **Found in:** `backend/services/platformAPIs.js`
- **Resolution:** Two-layer Redis-based rate limiting: (1) per-account mutex lock prevents simultaneous API calls to the same user+platform, with 5 retries at 2s intervals; (2) daily counter with platform-specific limits (Instagram: 50, Facebook: 200, others: 100). Both fail open if Redis is down.

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
- **Status:** resolved
- **Category:** HIGH / Security
- **Description:** OAuth result cookies missing `Secure` flag. On HTTPS production site, cookies can be sent over HTTP if user visits non-HTTPS URL. Also `SameSite=lax` instead of `strict`.
- **Found in:** `backend/routes/publish.js` (lines 68-74)
- **Resolution:** Added `secure: process.env.NODE_ENV === 'production'` to all 6 OAuth result cookies (5 in publish.js, 1 in media.js). Cookies are now HTTPS-only in production.

---

### HIGH — Integration

- **ID:** ISSUE-021
- **Date:** 2026-03-27
- **Status:** open (blocked — likely Meta platform bug)
- **Category:** HIGH / Integration
- **Description:** Threads OAuth authorize endpoint returns `{"error_message":"Authorization Failed: No app ID was sent with the request.","error_code":4476002}` despite `client_id` being correctly included in the URL query string. The full OAuth redirect flow is non-functional. However, the "Generate Access Token" button in Meta Developer Portal → Threads API → Settings works perfectly for the same app and tester account, proving the App ID, secret, tester config, and permissions are all valid.
- **Found in:** Threads OAuth flow (`threads.net/oauth/authorize` → `www.threads.com/oauth/authorize`)
- **What was tried (all failed with same error):**
  1. `https://threads.net/oauth/authorize?client_id=895936300985012` (Threads App ID) — 301 redirects to `www.threads.com`, then returns error
  2. `https://www.threads.com/oauth/authorize?client_id=895936300985012` — direct, same error
  3. Both URLs with Meta App ID `1240290211015400` instead — same error
  4. `https://graph.threads.net/oauth/authorize?client_id=...` — different error: "Invalid client_id" (not the right endpoint)
  5. URL-encoding the scope parameter — no difference
  6. Incognito browser while logged into Threads as tester — same error
  7. Re-saved Threads API settings in Meta Developer Portal — same error
  8. Added `social-buster.com` to App domains in App Settings → Advanced — same error
  9. Verified via browser Network tab that `client_id` IS present in every request URL
- **Confirmed working:** "Generate Access Token" button in portal, Threads Tester accepted, permissions `threads_basic` + `threads_content_publish` both "Ready for testing", redirect URI matches exactly, app is Published/Live
- **Suspected cause:** Meta platform bug — the OAuth authorize endpoint on `threads.net`/`www.threads.com` is not reading the `client_id` query parameter. The 301 redirect from `threads.net` → `www.threads.com` may be related. Other developers may be experiencing this.
- **Resolution:** Pending. Need to research if this is a known Meta bug and/or file a bug report with Meta.

---

### MEDIUM — Security (Deep Review)

- **ID:** ISSUE-017
- **Date:** 2026-03-25
- **Status:** resolved
- **Category:** MEDIUM / Security
- **Description:** No startup validation of required environment variables. Server starts even if critical vars (`TOKEN_ENCRYPTION_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `REDIS_HOST`) are missing. Failures surface at runtime, not boot.
- **Found in:** `backend/server.js`
- **Resolution:** Added startup validation that checks 5 required env vars (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, REDIS_HOST, TOKEN_ENCRYPTION_KEY). Server exits with clear error message if any are missing.

---

- **ID:** ISSUE-018
- **Date:** 2026-03-25
- **Status:** resolved
- **Category:** MEDIUM / Security
- **Description:** `axios` package is outdated (2023 version) with known CVEs for prototype pollution. Used for all external API calls (platform APIs, LLM, Cloudflare).
- **Found in:** `backend/package.json`
- **Resolution:** Updated axios from 1.6.2 to 1.13.6 (latest).

---

## Resolved Issues

- **ID:** ISSUE-020
- **Date:** 2026-03-26
- **Status:** resolved
- **Severity:** CRITICAL — broke all frontend navigation (inline onclick handlers)
- **Description:** Helmet CSP debugging cascade. Started as Cloudflare beacon blocked, ended with broken navigation.
- **Full timeline:**
  1. ISSUE-007 enabled Helmet CSP with `scriptSrc: ['self', 'unsafe-inline']`. Worked fine.
  2. Cloudflare's auto-injected beacon blocked by CSP. Added domain to `scriptSrc` — didn't help (Cloudflare proxy caching/overriding header).
  3. Purged Cloudflare edge cache — still blocked.
  4. Added `scriptSrcElem` explicitly — **THIS BROKE EVERYTHING.** Helmet's `useDefaults: true` includes a hidden default: `scriptSrcAttr: ["'none'"]`. Before adding `scriptSrcElem`, browser fell back from `script-src-attr` to `script-src` (which has `'unsafe-inline'`). After adding `scriptSrcElem`, browser honored the explicit `script-src-attr 'none'` from Helmet defaults, blocking every `onclick="..."` handler in the app.
  5. Disabled Cloudflare Web Analytics in dashboard (correct — we don't need it).
- **Root cause:** Helmet's default CSP includes `scriptSrcAttr: ["'none'"]`. We never overrode it. It was invisible until `scriptSrcElem` changed the browser's fallback chain.
- **Resolution:** Set `useDefaults: false` in Helmet CSP. We now control every directive explicitly — no hidden defaults. Removed `scriptSrcElem` and `scriptSrcAttr`. Replaced `frameSrc` with `frameAncestors` (CSP Level 2 proper). Disabled Cloudflare Web Analytics beacon injection.
- **Lesson:** NEVER use Helmet CSP with `useDefaults: true` (the default) on a plain JS frontend that uses inline event handlers. The hidden `scriptSrcAttr: 'none'` default will silently break them.
- **Found in:** `backend/server.js` (Helmet CSP config)
- **Related:** ISSUE-007, ISSUE-019, FEAT-016

---

- **ID:** ISSUE-019
- **Date:** 2026-03-25
- **Status:** resolved
- **Severity:** HIGH — broke all frontend navigation
- **Description:** Watchdog commit added 517 lines to `admin.js` but did not bump the `?v=24` cache-busting parameter in `index.html`. After deploy, browsers served the stale cached admin.js. This caused a frontend mismatch that broke sidebar navigation (New Brief, Generated Posts, Publishing Queue — all unresponsive). 20+ minutes spent debugging a problem that didn't exist before the commit.
- **Found in:** `frontend/public/index.html` (stale `?v=24` on admin.js script tag)
- **Root cause:** Claude failed to update cache-busting version when modifying a frontend JS file. No pre-commit checklist was in place.
- **Resolution:** Bumped `?v=24` → `?v=25` in index.html. Added "Pre-Commit Rule: Don't Break What's Working" section to CLAUDE.md with a 5-point mental checklist. Updated persistent feedback memory with the incident and checklist. This class of bug is now preventable.
- **Lesson:** Every frontend JS/CSS file change MUST bump its `?v=` in index.html. This is non-negotiable.

---

- **ID:** ISSUE-022
- **Date:** 2026-03-27
- **Status:** resolved
- **Severity:** HIGH — Meta Page picker only showed 4 of 9 authorized Pages
- **Description:** After Meta OAuth consent, the Page picker only displayed 4 Pages despite the user granting access to 9. Instagram accounts (patriot_filming, sharonvidano, markvidano) could not be connected because their linked Pages were missing from the picker.
- **Root cause:** Meta's `/me/accounts` endpoint only returns Pages where the user has an **admin** role. Pages where the user is an editor, moderator, or other role are silently excluded — even though the OAuth consent screen shows them and `granular_scopes` confirms the token has permissions for them.
- **Found in:** `backend/routes/publish.js` (Meta OAuth callback, `/me/accounts` call)
- **Resolution:** After calling `/me/accounts`, we now call `debug_token` to get all authorized Page IDs from `granular_scopes` (`pages_show_list`). Any Page IDs present in granular_scopes but missing from `/me/accounts` are fetched individually via `GET /{page_id}?fields=id,name,access_token,instagram_business_account`. All authorized Pages now appear in the picker regardless of the user's role on that Page. Fix is permanent and automatic for all users.
- **Lesson:** Never trust `/me/accounts` as the complete list of authorized Pages. Always cross-reference with `debug_token` granular_scopes.

---

- **ID:** ISSUE-023
- **Date:** 2026-03-27
- **Status:** resolved
- **Severity:** CRITICAL — DM automation broken after reconnecting Facebook
- **Description:** After reconnecting Facebook to test the new 9-Page picker (ISSUE-022 fix), DM automation stopped working. Comments were detected by webhook but DMWorker failed due to Page ID mismatch and stale dedup data.
- **Root cause (multi-layered):**
  1. **Page ID mismatch:** Webhook sent Page ID `1010798405456306` (Social Buster Page) but only `101465745099191` (World Wide Treasure Hunt) was connected. Token lookup failed with "No facebook connection for user."
  2. **Stale dedup guard:** Old `dm_conversations` row with `status: completed` blocked all retries for the same (automation, person) pair.
  3. **Bad backfill:** Multi-page migration stamped wrong `platform_page_id` on existing posts.
- **Resolution:**
  1. Cleaned database: deleted all `dm_conversations`, `dm_collected_data`, and `comments`
  2. Published new post to the correct connected Page
  3. Had Sharon comment on the new post — DM delivered successfully
  4. Code fixes: added `platform_page_id` fallback (parse from `platform_post_id`), `UnrecoverableError` for duplicate private replies, migration SQL for bad backfill
- **Found in:** `backend/agents/commentAgent.js`, `backend/workers/dmWorker.js`, `backend/agents/publishingAgent.js`
- **Related:** ISSUE-022, platform_publishing_guide.md (ISSUE-023 Resolution section)

---

### HIGH — Integration

- **ID:** ISSUE-024
- **Date:** 2026-03-27
- **Status:** open (in progress — two new fixes deployed, ready for end-to-end test)
- **Category:** HIGH / Integration
- **Description:** Instagram DM automation cannot be tested. Multiple root causes found and fixed:
  1. `POST /{ig_account_id}/subscribed_apps` was failing with error #3 — endpoint doesn't exist for Instagram (Facebook Pages only). Removed.
  2. OAuth scopes were wrong — requesting old `instagram_basic`, `instagram_manage_messages` instead of `instagram_business_basic`, `instagram_business_manage_messages`. Fixed in commit `5d70d1b`.
  3. Instagram Messaging webhooks in Meta Developer Portal were showing "0 fields" for all Pages — no webhook subscriptions at page level. Manually subscribed all Pages to `messages`, `message_reactions`, `comments` (2026-03-27).
- **What was tried:**
  1. Connected Patriot Films & Studios Page (linked to @markvidano Instagram) — Instagram connected successfully, publishing works
  2. App-level webhook subscription in Meta Developer Portal shows `comments`, `messages`, `message_reactions` all subscribed with correct callback URL
  3. @markvidano added as Instagram Tester in Meta Developer Portal — accepted
  4. @sharonvidano added as Instagram Tester — status stuck on "Pending", no invitation appears in Sharon's Instagram settings
  5. Sharon commented on published Instagram post — zero webhook log lines appeared
  6. **FIXED:** Removed the invalid `POST /{ig_id}/subscribed_apps` call from `publish.js` — that endpoint is Facebook Pages only (commit `8889439`)
  7. **FIXED:** Updated OAuth scopes — `instagram_basic` → `instagram_business_basic`, `instagram_content_publish` → `instagram_business_content_publish`, `instagram_manage_messages` → `instagram_business_manage_messages` (commit `5d70d1b`)
  8. **FIXED:** Instagram Messaging webhook subscriptions in Meta Developer Portal were at "0 fields" for all Pages. Manually subscribed Patriot Films & Studios, Sharon N. Vidano, and Social-Buster to `messages`, `message_reactions`, `comments` via Edit Subscriptions (2026-03-27)
- **What to do next (step by step):**
  1. Wait for Coolify to deploy commit `5d70d1b` (OAuth scope fix)
  2. **Reconnect Facebook/Instagram** in Social Buster — so the new `instagram_business_*` scopes are granted
  3. **Publish a new Instagram post** from Social Buster with a DM automation attached
  4. **Have Sharon comment** on the Instagram post with the trigger keyword
  5. **Check Coolify logs** for `[Webhooks] Realtime instagram comment...` lines
  6. If still no webhook: check `instagram_manage_comments` permission status in Meta Developer Portal → Permissions and Features — must be "Ready for testing"
  7. If permission is missing: submit for App Review
- **Key findings:**
  - `/{ig_account_id}/subscribed_apps` does NOT exist — Instagram webhooks rely on (1) app-level webhook config + (2) Facebook Page subscription
  - Instagram Business Login uses different scope names than old Instagram API (`instagram_business_basic` not `instagram_basic`, etc.)
  - Instagram Messaging webhook subscriptions must be configured at page level in Meta Developer Portal (Messenger from Meta → Instagram settings) — this is separate from the app-level webhook subscriptions
- **Found in:** `backend/routes/publish.js`
- **Related:** ISSUE-023, platform_publishing_guide.md
