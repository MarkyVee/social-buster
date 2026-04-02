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

- **ID:** ISSUE-032
- **Date:** 2026-04-02
- **Status:** resolved (2026-04-02)
- **Category:** HIGH / AI Generation
- **Description:** "Generate Posts with AI" failing with HTTP 413 on every attempt for all users. Brief form would submit, LLM call would fire, then fail with `Request failed with status code 413` on both attempts (retry included). No posts generated.

  **Root cause:** Groq's `llama-3.1-8b-instant` model has a 6,000 TPM (tokens per minute) limit. The request was calculated as: input tokens (~1,100) + `max_tokens` (5,120) = ~6,220 — just over the 6,000 limit. Groq returns 413 (not 429) when the combined input+output token budget exceeds the TPM quota.

  **Steps taken:**
  1. Confirmed error was `[LLM] Attempt 1 failed (Request failed with status code 413)` — not a network or body-size issue.
  2. Checked `express.json({ limit: '10mb' })` — not the cause, incoming brief POST is tiny.
  3. Checked Coolify env vars (`LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`) — all correct.
  4. Measured prompt file sizes: system prompt 1,930 chars, Facebook platform guide 383 chars, brief fields ~330 chars, style notes ~226 chars.
  5. First fix: capped shared context at 4,000 chars (commit `df90dc0`) — still 413.
  6. Second fix: reduced cap to 1,500 chars (commit `a2283a9`) — still 413. Context size was not the real problem.
  7. Consulted Grok — identified that `max_tokens: 5120` + ~1,100 input = ~6,220 total, exceeding Groq's 6,000 TPM limit. Groq uses input + max_tokens combined for the quota check.
  8. **Final fix (commit `dcd9537`):** Reduced `max_tokens` from 5,120 to 2,048. New total: ~1,100 + 2,048 = ~3,148 — well under the 6,000 limit. 3 posts × 3 options × ~300 tokens = ~2,700 output tokens needed max, so 2,048 is sufficient.

- **Found in:** `backend/services/llmService.js` — `callLLM()` `max_tokens` parameter
- **Resolution:** ✅ Resolved. Reduced `max_tokens` to 2,048. AI generation working again (2026-04-02).

---

- **ID:** ISSUE-031
- **Date:** 2026-04-01
- **Status:** resolved (2026-04-02)
- **Category:** HIGH / DM Automation
- **Description:** Facebook DM automation firing via 15-minute polling cycle instead of real-time (instant) webhook path. Mark Vidano's "GO" comment triggered a DM but 9 minutes later, not instantly. Realtime path (`processRealtimeComment`) was silently returning when it couldn't find the post by `platform_post_id` — the format Meta sends in `val.post_id` (e.g. `{page_id}_{post_id}`) did not always match what we stored in the DB (video posts store just the object ID without the page prefix).

  **Steps taken:**
  1. Confirmed webhook firing correctly — `[Webhooks] Realtime facebook comment from Mark Vidano` appeared in logs.
  2. Confirmed DM fired 9 minutes later via polling cycle — not realtime.
  3. Identified `processRealtimeComment()` silently returned on post-not-found with zero logging.
  4. Added diagnostic `console.warn` logging to the silent return (commit `8dec077`) — to capture what ID Meta was sending.
  5. Diagnosed root cause: Facebook webhook `val.post_id` sends `{page_id}_{post_id}` format, but video posts store just the object ID (no page prefix) from `videoRes.data.id`.
  6. **Fix applied (commit `7f32acb`):** Replaced single exact-match query with 3-strategy fallback lookup:
     - Strategy 1: Exact match on full webhook ID (e.g. `270008739520883_122273...`)
     - Strategy 2: Match on suffix after first underscore (e.g. `122273...`) — catches video object IDs stored without page prefix
     - Strategy 3: Fallback to most recent published post on the page by `platform_page_id`
  7. Switched all queries from `.single()` to `.maybeSingle()` to prevent silent Supabase errors on 0 rows.

- **Found in:** `backend/agents/commentAgent.js` — `processRealtimeComment()`
- **Resolution:** ✅ Resolved. Multi-strategy post lookup deployed (commit `7f32acb`, 2026-04-02). DMs now fire instantly via realtime webhook path.

---

- **ID:** ISSUE-030
- **Date:** 2026-04-01
- **Status:** wont-fix (Meta platform limitation)
- **Category:** LOW / DM Automation
- **Description:** Facebook comment webhook payload omits `val.from?.id` when a commenter has strict privacy settings. `commentAgent.js` reads `authorId = val.from?.id` — if undefined, `processRealtimeComment` receives a null `authorPlatformId` and logs `[CommentAgent] Trigger matched for @Unknown but no authorPlatformId — cannot DM` then skips the DM. DM automation otherwise works correctly; this is a per-user Meta privacy edge case that cannot be resolved on our end.
- **Found in:** `backend/agents/commentAgent.js` — `processRealtimeComment()`
- **Resolution:** None possible. Meta does not include the commenter's user ID in the webhook payload when their privacy settings block it. We cannot DM a user we have no ID for. Existing warning log is sufficient. No code change needed. See also [[platform_publishing_guide]].

---

- **ID:** ISSUE-029
- **Date:** 2026-04-01
- **Status:** resolved (2026-04-01)
- **Category:** CRITICAL / Database
- **Description:** `auth.role() = 'service_role'` RLS policy pattern is broken across the entire database. `supabaseAdmin` (service role key) was being blocked from writing to every table — subscription overrides, DM automation, media, platform connections, comments, tier limits, and more were all silently failing. Root cause: Supabase does not evaluate `auth.role()` correctly for the service role key in this setup.
- **Found in:** All 15 tables with service role policies — `user_profiles`, `subscriptions`, `briefs`, `posts`, `media_items`, `platform_connections`, `post_metrics`, `comments`, `trigger_phrases`, `cloud_connections`, `video_segments`, `plans`, `cohort_performance`, `dm_automations`, `dm_automation_steps`, `dm_conversations`, `dm_collected_data`, `admin_messages`
- **Resolution:** Replaced all `USING (auth.role() = 'service_role')` policies with `USING (true) WITH CHECK (true)` on every affected table. Fixed via Supabase SQL Editor — no redeploy needed. User-facing SELECT policies (e.g. `auth.uid() = recipient_id` on admin_messages) were left intact. Future migrations must use `USING (true) WITH CHECK (true)` for service role policies — never `auth.role() = 'service_role'`.

---

- **ID:** ISSUE-028
- **Date:** 2026-04-01
- **Status:** resolved (2026-04-01)
- **Category:** HIGH / Database
- **Description:** `system_events` and `system_state` tables missing in Supabase — watchdog migration was never run. Watchdog tab threw `Could not find the table 'public.system_events' in the schema cache` on every health check cycle.
- **Found in:** Watchdog tab, `watchdogAgent.js`
- **Resolution:** Ran `migration_system_events.sql` in Supabase SQL Editor. Created both tables, 3 indexes, RLS policies (service role full access), seeded `system_state` pause key. No redeploy needed.

---

- **ID:** ISSUE-027
- **Date:** 2026-04-01
- **Status:** resolved (2026-04-01)
- **Category:** HIGH / Database
- **Description:** `tier_limits` RLS policy blocked auto-seed. Table was empty so Limits tab showed nothing. Auto-seed in `GET /admin/tier-limits` ran but failed with "new row violates row-level security policy" — even though `supabaseAdmin` uses the service role key. RLS policy was written to only allow SELECT for authenticated users, not INSERT for service role.
- **Found in:** `backend/routes/admin.js` auto-seed, `tier_limits` RLS policy in Supabase
- **Resolution:** Fixed RLS policy (`USING (true) WITH CHECK (true)` for service role). Manually seeded all 40 tier_limit rows (10 features × 4 tiers) via SQL. No redeploy needed.

---

- **ID:** ISSUE-026
- **Date:** 2026-03-31
- **Status:** resolved (2026-03-31)
- **Category:** HIGH / Frontend
- **Description:** ISSUE-025 fix was admin-only. Regular users loading `brief.js`, `preview.js`, `publish.js`, `media.js`, and `app.js` had no stale JS detection at all. A version bump miss would silently break features for the entire user base with no warning.
- **Found in:** `frontend/public/js/app.js` — no version check for regular users
- **Resolution:** Built platform-wide version check. `APP_VERSION = 1` constant in both `frontend/public/js/app.js` and `backend/server.js`. Public `GET /app-version` endpoint (no auth). `checkAppVersion()` runs after every successful login for all users. If stale, shows a non-blocking yellow banner: "A new version is available — Refresh Now." Future rule: bump `APP_VERSION` in both places whenever ANY frontend JS or CSS file changes.

---

- **ID:** ISSUE-025
- **Date:** 2026-03-31
- **Status:** resolved (2026-03-31)
- **Category:** HIGH / Frontend
- **Description:** Recurring pattern — admin.js updated but `?v=` cache-busting number not bumped in `index.html`. Browser (and Cloudflare CDN) serve stale JS, causing controls on tabs (Limits, Diagnostics, etc.) to silently disappear or misbehave. Has happened at least 3 times: ISSUE-019 (2026-03-26), commit d4c4ef8 (2026-03-30), and again 2026-03-31.
- **Found in:** `frontend/public/index.html` `?v=` version on `admin.js`
- **Resolution:** Built a server-side version handshake. `ADMIN_JS_VERSION` constant lives in both `backend/routes/admin.js` and `frontend/public/js/admin.js`. Backend exposes `GET /admin/version`. On every dashboard load, `checkAdminJsVersion()` fetches this and compares. If stale, a sticky yellow banner appears with a one-click "Purge Cache & Reload" button that calls the Cloudflare purge endpoint then hard-reloads the page. Future rule: bump all three numbers together — `?v=` in index.html, `ADMIN_JS_VERSION` in admin.js, `ADMIN_JS_VERSION` in routes/admin.js.

---

- **ID:** ISSUE-021
- **Date:** 2026-03-27
- **Status:** open (blocked — likely Meta platform bug)
- **Category:** HIGH / Integration
- **Description:** Threads OAuth authorize endpoint returns "No app ID was sent" despite `client_id` being in the URL. The "Generate Access Token" button in Meta Developer Portal works fine for the same app — proving config is correct.
- **Suspected cause:** Meta platform bug — the OAuth authorize endpoint on `threads.net`/`www.threads.com` is not reading the `client_id` query parameter.
- **Found in:** Threads OAuth flow
- **Resolution:** Pending — Threads moved to "Coming Soon"

---

- **ID:** ISSUE-024
- **Date:** 2026-03-27
- **Status:** resolved (2026-03-28)
- **Category:** HIGH / Integration
- **Description:** Instagram DM automation — 5 issues found and fixed: invalid subscribed_apps endpoint, comment field mismatch (`text` vs `message`), wrong DM endpoint (`/me/messages` not `/{id}/messages`), ManyChat intercepting webhooks, wrong OAuth scope names.
- **Resolution:** All fixes deployed. Full 3-step multi-step DM flow confirmed working on Instagram (2026-03-28): trigger comment → name → zip → email → resource URL delivered.
- **Found in:** `backend/services/messagingService.js`, `backend/workers/dmWorker.js`

---

## Resolved Issues (one-line summaries)

| ID | Date | Category | Problem → Fix |
|----|------|----------|---------------|
| ISSUE-001 | 2026-03-25 | CRITICAL/Security | OAuth state used plain base64 → cryptographic nonces in Redis |
| ISSUE-002 | 2026-03-25 | CRITICAL/Security | X OAuth PKCE keyed by untrusted state → keyed by nonce |
| ISSUE-003 | 2026-03-25 | CRITICAL/Security | Webhook signature verification optional → mandatory |
| ISSUE-004 | 2026-03-25 | HIGH/Security | Rate limiting fails open when Redis down → in-memory fallback |
| ISSUE-005 | 2026-03-25 | HIGH/Security | Logout didn't clear session → clears `active_session_id` |
| ISSUE-006 | 2026-03-25 | HIGH/Security | No rate limiting on OAuth callbacks → `authLimiter` added |
| ISSUE-007 | 2026-03-25 | HIGH/Security | Helmet CSP disabled → configured with proper directives |
| ISSUE-008 | 2026-03-25 | CRITICAL/Scalability | Missing composite index on posts → migration SQL created |
| ISSUE-009 | 2026-03-25 | wont-fix | Supabase client per request flagged → correct pattern, no change needed |
| ISSUE-010 | 2026-03-25 | HIGH/Scalability | Admin dashboard N+1 queries → parallel count queries |
| ISSUE-011 | 2026-03-25 | HIGH/Scalability | performanceAgent loads all posts → cursor-based pagination |
| ISSUE-012 | 2026-03-25 | HIGH/Scalability | No per-account API rate limiting → Redis mutex + daily counters |
| ISSUE-013 | 2026-03-25 | CRITICAL/Security | LLM prompt injection → `sanitizeForPrompt()` on all free-text fields |
| ISSUE-014 | 2026-03-25 | wont-fix | Admin XSS flagged → false positive, all fields already escaped |
| ISSUE-015 | 2026-03-25 | HIGH/Security | DM reply text no length limit → `.slice(0, 2000)` truncation |
| ISSUE-016 | 2026-03-25 | HIGH/Security | OAuth cookies missing Secure flag → added for production |
| ISSUE-017 | 2026-03-25 | MEDIUM/Security | No startup env var validation → 5 required vars checked at boot |
| ISSUE-018 | 2026-03-25 | MEDIUM/Security | Outdated axios with CVEs → updated to 1.13.6 |
| ISSUE-019 | 2026-03-26 | HIGH/Frontend | Cache-busting not bumped after JS change → bumped, added to pre-commit checklist |
| ISSUE-020 | 2026-03-26 | CRITICAL/Frontend | Helmet CSP `useDefaults:true` broke inline onclick → set `useDefaults:false`, explicit directives |
| ISSUE-022 | 2026-03-27 | HIGH/Integration | Page picker showed 4 of 9 Pages → cross-reference `debug_token` granular_scopes |
| ISSUE-023 | 2026-03-27 | CRITICAL/Integration | DM broken after reconnect → Page ID mismatch + stale dedup. Cleaned DB, added pageId fallback |
| ISSUE-030 | 2026-04-01 | wont-fix | Facebook webhook omits `val.from.id` for privacy-restricted commenters → cannot DM, Meta limitation |
| ISSUE-031 | 2026-04-02 | resolved | Facebook DM realtime path silently dropped comments — platform_post_id format mismatch. Fixed with 3-strategy fallback lookup (commit `7f32acb`) |
| ISSUE-032 | 2026-04-02 | resolved | AI generation 413 error — Groq TPM limit hit by `max_tokens:5120` + input. Fixed by dropping to `max_tokens:2048` (commit `dcd9537`) |
