# Social Buster — Core Claude Instructions

This file is automatically loaded at the start of every session. It contains the highest-priority behavioral rules and coding standards for this workspace.

Reference material (tech stack, directory structure, env vars, integrations, deployment, detailed gotchas): see `.claude/docs/SYSTEM_OVERVIEW.md`.

---

## Documentation Discipline (Strict & Non-Negotiable)

Keep the living documentation in `.claude/docs/` up to date. All files are Obsidian-compatible Markdown. Use `[[wiki-links]]` for cross-referencing.

### When to Log

| Event                          | File          | When to log                          |
|--------------------------------|---------------|--------------------------------------|
| Architecture / design decision | [[DECISIONS]] | Any non-trivial choice (X over Y)   |
| Bug, problem, or blocker       | [[ISSUES]]    | When something is broken or blocking |
| Feature idea or enhancement    | [[FEATURES]]  | When a new idea comes up             |
| Work completed                 | [[CHANGELOG]] | End of session or after milestone    |

**Rules:**
- Never edit any `.claude/docs/` file without my explicit confirmation.
- Always suggest the exact markdown entry first (using the established format: ID, Date, Status, Description, etc.).
- Update status when issues are resolved or features are completed.
- Never delete history — move entries to resolved/done/wont-fix sections.
- Use [[wiki-links]] to connect related entries ([[SYSTEM_OVERVIEW]], [[DECISIONS]], [[ISSUES]], etc.).
- Keep [[SYSTEM_OVERVIEW]] "Current Focus" and "Next Actions" sections accurate.
- Increment IDs consistently (ISSUE-001, FEAT-001, etc.).

---

## Project Overview

**Social Buster** is an enterprise-grade AI-powered social media marketing platform with three core functions:
1. AI post generation from user briefs (hooks, captions, hashtags, CTAs)
2. Comment-to-lead DM automation via Meta Graph API
3. Auto-publishing and scheduling to multiple social platforms

We maintain a strict adapter pattern so external providers can be swapped by changing one file.

---

## Core Coding Conventions

- Use **async/await + try/catch** everywhere — never `.then()/.catch()` chains.
- No hardcoded values — everything configurable belongs in `.env`.
- Comment every non-obvious block — the codebase must be readable by beginners.
- **No business logic in routes** — routes only validate input and delegate to agents/services.
- **Adapter pattern is mandatory** — every external API or service gets its own dedicated service file.
- Frontend: Plain HTML/CSS/JS only. No React, no bundler, no TypeScript. Use hash-based routing and `fetch()` with JWT from `localStorage`.

---

## Multi-Tenancy (Sacred Rule)

- In **route handlers**: always use `req.db` (never `supabaseAdmin`). It is pre-scoped to the current user.
- In **workers/agents**: use `supabaseAdmin` but **always** add `.eq('user_id', userId)` on every query.
- Never remove the `user_id` filter. RLS is only a safety net.

---

## Error Handling

- **Routes**: Catch errors and return `res.status(500).json({ error: '...' })`. Never let Express crash.
- **Workers**: Re-throw errors so BullMQ marks the job as failed and triggers retries.
- **Per-post failures in agents**: Mark the post as `failed` with `error_message`, do **not** re-throw (do not block the rest of the queue).

---

## Files You Should Never Modify Directly

| File                                | Reason |
|-------------------------------------|--------|
| `backend/middleware/auth.js`        | JWT validation chain — breaking it locks out all users |
| `backend/middleware/tenancy.js`     | Multi-tenancy isolation — risk of data leakage |
| `backend/services/tokenEncryption.js` | Changes break decryption of all stored OAuth tokens |
| `backend/queues/index.js`           | Referenced by all workers — wrong changes break background jobs |
| `frontend/public/index.html`        | Nav structure and auth guard tightly coupled to `app.js` |

---

## Pre-Commit Checklist (Non-Negotiable)

1. Changed ANY frontend JS or CSS? → Bump `APP_VERSION` in BOTH `frontend/public/js/app.js` AND `backend/server.js` — this triggers the platform-wide "new version" banner for all users. Also bump the file's own `?v=` in `index.html`. Changed `admin.js` specifically? → Also bump `ADMIN_JS_VERSION` in BOTH `frontend/public/js/admin.js` AND `backend/routes/admin.js`.
2. Added a new route or `require()` in `server.js`? → Verify the file exists and exports correctly
3. Added a new DB table or query? → Confirm the table exists or flag the migration
4. Changed any shared module (queues, middleware, services)? → Check all files that import it
5. Introduced anything not yet deployed (new table, Redis key, env var)? → Flag it clearly

---

## Landmines (Quick Reference)

- `supabaseAdmin` vs `req.db`: Admin only in workers + always filter by `user_id`. `req.db` for routes.
- Stripe webhook must be mounted **before** `express.json()` in `server.js`.
- BullMQ requires `maxRetriesPerRequest: null` in Redis config.
- Helmet CSP must keep `useDefaults: false` or inline `onclick` handlers break.
- `process_status` uses `.in(['pending', 'failed'])` as concurrency lock — do not simplify.
- Google Drive `webViewLink` is **not** a download URL — use `downloadGoogleDriveFile()`.
- OAuth redirect URIs must match **exactly** (Google is strict; Threads still uses localhost).
- Platform stubs (TikTok, LinkedIn, X, Threads, YouTube) throw intentionally — do not bypass.
- FFmpeg is background-only (BullMQ workers only).
- Media processing seed must stay scoped to pending posts only.
- Pending SQL migration on `media_items` table (see handoff.md).
- **RLS service role policies must use `USING (true) WITH CHECK (true)`** — never `auth.role() = 'service_role'`. The latter does not work in this Supabase setup and silently blocks all `supabaseAdmin` writes. (ISSUE-029)

---

## Do Not Attempt — Proven Failures

1. Do not use Drive `webViewLink` as a download URL.
2. Do not download media from Drive at publish time — copy to Supabase at attach time.
3. Do not call platform APIs with `axios` without `timeout: 30_000`.
4. Do not set publishing recovery window > 2–3 minutes.
5. Do not query `ai_image_url` on the `posts` table.
6. Do not seed `media-process` jobs for the entire media library.
7. Do not wrap `startAllWorkers()` in a single try/catch.
8. Do not pass raw axios errors from Facebook — use `fbCall()` wrapper.
9. Do not remove the DELETE before INSERT in `videoAnalysisService.js`.
10. Do not auto-reset 'failed' analysis items to 'pending'.
11. Do not remove `knownLength` from Facebook multipart video upload.
12. Do not move `access_token` from URL params to form body for video uploads.
13. Do not call `queueVideoAnalysis()` without first removing the existing BullMQ job.
14. Do not use `instagram_business_*` scope names in the Facebook Login OAuth flow — they belong to a separate Instagram Business Login product and will break ALL OAuth connections with "Invalid Scopes" error.

---

## Do Not Break What's Working (Sacred Rule)

If a feature is confirmed working in production, **do not change it** without a clear reason AND explicit warning to the user. Before every code change, ask yourself:

1. **Is this already working?** If yes, leave it alone unless there's a specific bug to fix.
2. **Could this change break something that works?** If yes, flag it with an **⚠️ IMPORTANT** warning before proceeding.
3. **Am I adding diagnostic code that could have side effects?** Keep diagnostics log-only — never change behavior.
4. **Am I going in circles?** If the same area has been "fixed" multiple times, STOP and talk to the user instead of adding more code.

When debugging, always check the docs first to see if the problem was already solved. If you find yourself re-fixing something, you're probably looking at the wrong problem.

---

## When You Don't Have the Answer

It is okay to not have the answer. If you don't, **say so clearly** and suggest:
- Getting a second opinion (another LLM, Stack Overflow, platform docs)
- Testing in the platform's API Explorer to isolate code vs config issues
- Talking through the problem together to narrow down the cause

**Do not guess and push code changes when you're not sure.** A wrong fix is worse than no fix — it wastes time and can break working features. When uncertain, ask the user how they'd like to proceed.

---

## Project Awareness Rule

Before suggesting any significant change:
- Read `.claude/docs/SYSTEM_OVERVIEW.md` first
- Align with the current "Next Action"
- Respect past decisions in [[DECISIONS]]

If your suggestion conflicts with documented decisions, ask for confirmation before proceeding.