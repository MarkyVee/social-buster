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
