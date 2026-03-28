# Platform Publishing Guide

Authoritative reference for platform publishing in Social Buster. Read BEFORE starting any new platform integration.

---

## Rule #1: Test in the Platform's API Explorer First

Before writing or debugging code, make the exact API call in the platform's test tool. If it fails there, the problem is configuration — not code.

- **Facebook/Instagram/Threads:** [Graph API Explorer](https://developers.facebook.com/tools/explorer)
- **TikTok:** TikTok Developer Portal → API Explorer
- **LinkedIn:** LinkedIn Developer Portal → OAuth Token Inspector
- **X (Twitter):** [OAuth Playground](https://developer.x.com/en/docs/authentication/oauth-2-0)
- **YouTube:** [Google OAuth Playground](https://developers.google.com/oauthplayground)

---

## Facebook Video Publishing (SOLVED ✅)

**Problem:** Error 351 on every video upload attempt.
**Root cause:** App was in Testing mode — `/{page-id}/videos` is restricted even for app owner/admin. Error 351 masks the real error (100 = no permission).
**Fix:** Published app to Live mode, added Privacy Policy URL, removed non-existent `publish_video` scope. `pages_manage_posts` covers video posting.

**Working code pattern (PROTECT — do not change):**
```javascript
form.append('source', fs.createReadStream(path), { knownLength: fileSize }); // knownLength REQUIRED
// access_token in URL params, NOT form body
// timeout: 120_000 (2 minutes)
```

**Key facts:**
- `publish_video` does NOT exist as a use case for Business Apps
- Error 351 almost never means the file is bad — test in Graph API Explorer
- Error 390 = permission IS granted (timeout waiting for file data)

---

## Video Analysis Pipeline (SOLVED ✅)

All issues resolved. Key protected patterns:

| Pattern | Why |
|---------|-----|
| DELETE before INSERT in `videoAnalysisService.js` | Prevents duplicate segments on re-run |
| Only reset `analyzing` → `pending`, never `failed` → `pending` | Failed items loop forever and block queue |
| Remove old BullMQ job before `add()` | BullMQ deduplicates across all states including completed |
| Delete partial segments when resetting stale items | Prevents stacking on partial data |

---

## Setting Up a New Platform — Checklist

1. **Create app** in platform's developer portal
2. **Configure permissions** — only what you need, verify access level
3. **Set OAuth redirect URI** — must match `.env` EXACTLY (trailing slashes matter)
4. **Publish/Go Live** the app — BEFORE testing publishing features
5. **Test in API Explorer** with correct token type — confirm success, not permissions error
6. **Add OAuth flow** to `routes/publish.js` — follow existing Facebook pattern
7. **Implement** `publishTo{Platform}()` in `platformAPIs.js` — timeout: 30_000 on every axios call
8. **Disconnect and reconnect** after any app config change

---

## Platform-by-Platform Notes

### Facebook ✅ WORKING
- **Token:** Page Access Token | **Scopes:** `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`
- **Upload:** Multipart to `graph-video.facebook.com/v21.0/{page-id}/videos`
- **Gotcha:** Error 351 in Testing mode = app not published to Live

### Instagram ✅ PUBLISHING + DM CONFIRMED WORKING
- **Token:** Page Access Token (same as Facebook, different endpoint)
- **Publish:** 2-step: `POST /{ig-user-id}/media` → poll container status → `POST /{ig-user-id}/media_publish`
- **Video:** `media_type: 'REELS'`, must be public URL (no multipart). Re-upload to Supabase after FFmpeg trim.
- **Image:** Must be public URL. Poll container status before publishing (error 9007 if skipped).
- **Crop:** Auto-crop for aspect ratio (error 36003 if outside 4:5 to 1.91:1). Re-upload cropped image to Supabase.
- **DM endpoint:** `POST /me/messages` (NOT `POST /{ig_user_id}/messages` — that returns error #3)
- **Comment fields:** Instagram uses `text`, Facebook uses `message`. Requesting wrong field = error #100.
- **IG User ID:** `platform_connections.platform_user_id` = `instagram_business_account.id` (set during Facebook OAuth)

#### Connecting Instagram to Social Buster
1. Switch Instagram to Professional (Business or Creator)
2. Link to a Facebook Page
3. Grant Social Buster access to that Page during Meta OAuth
4. Select the Page in Social Buster — Instagram connects automatically

### Threads (BLOCKED — ISSUE-021)
- **OAuth:** Separate flow through `threads.net` — built but blocked by Meta bug (no `client_id` recognized)
- **Publish:** 2-step like Instagram. Text limit: 500 chars. No hashtags shown on Threads.
- **Status:** Moved to "Coming Soon"

### TikTok / LinkedIn / X / YouTube
- Stubs exist in `platformAPIs.js`. OAuth not yet configured. All marked "Coming Soon".
- Key gotchas per platform documented in stubs.

---

## DM Automation Pipeline (Facebook ✅ CONFIRMED, Instagram ✅ CONFIRMED 2026-03-28)

### Working Pipeline
```
Meta Webhook → webhooks.js (signature verify)
  → commentAgent.js (trigger keyword match)
    → dmAgent.js (create conversation, queue DM job)
      → dmWorker.js (decrypt token, call messagingService)
        → messagingService.js (Private Reply API)
```

### Correct API Calls

**Facebook:** `POST /{page_id}/messages` with `{ recipient: { comment_id }, message: { text } }`
**Instagram:** `POST /me/messages` with `{ recipient: { comment_id }, message: { text } }`

### Required OAuth Scopes
```
pages_show_list, pages_read_engagement, pages_read_user_content, pages_manage_posts,
pages_manage_metadata, pages_messaging,
instagram_basic, instagram_content_publish, instagram_manage_comments, instagram_manage_messages
```

### Key Rules (from 9 resolved debugging issues)
1. **Deprecated endpoint:** `/{comment_id}/private_replies` was removed after Graph API v3.2 — use Send API with `comment_id` in recipient
2. **Permissions:** `pages_read_user_content` needed to READ comments (separate from `pages_read_engagement`)
3. **Self-messaging:** Page admin cannot DM themselves — always test with separate account
4. **RLS policies:** Every table workers write to needs an RLS policy BEFORE testing
5. **Dedup guard:** Failed DMs must update `dm_conversations.status = 'failed'` or retries are permanently blocked
6. **One private reply per comment:** Can't reuse old comments for retesting — need new post + new comment
7. **Facebook User ID ≠ PSID:** Store `recipient_id` from Private Reply response for multi-step reply matching
8. **`.maybeSingle()` not `.single()`:** Supabase `.single()` throws on 0 rows — use `.maybeSingle()` for lookups that may return nothing
9. **Multi-step requires ≥2 steps:** `flow_type: 'multi_step'` with only 1 step completes immediately
10. **Platform-specific endpoints:** Instagram `POST /me/messages`, Facebook `POST /{page_id}/messages`
11. **Platform-specific fields:** Instagram comments use `text`, Facebook uses `message`
12. **Third-party tools:** Check for ManyChat/Chatfuel connected to same account — they intercept webhooks
13. **Token refresh required:** Adding scopes to code doesn't update existing tokens — user must disconnect + reconnect
14. **Clean between test cycles:** `DELETE FROM dm_conversations;` before each retest

### Testing DM Automation (Quick Checklist)
1. Clean: `DELETE FROM dm_conversations;`
2. Publish NEW post with automation attached
3. Have tester (separate account) comment with trigger keyword
4. Check logs for `[DMAgent] Started` → `[MessagingService] Sending private reply`
5. If no webhook: check Page-level webhook subscriptions in Meta Developer Portal

### Key Files
| File | Role |
|------|------|
| `backend/routes/webhooks.js` | Receives Meta webhooks, verifies signature, routes |
| `backend/agents/commentAgent.js` | Matches trigger keywords, calls startConversation() |
| `backend/agents/dmAgent.js` | Conversation state machine, queues DM jobs |
| `backend/workers/dmWorker.js` | Decrypts tokens, calls messagingService |
| `backend/services/messagingService.js` | Calls Meta Graph API |
| `backend/routes/publish.js` | OAuth scopes |

### ISSUE-024 Scope Note: `instagram_business_*` Scopes Break Facebook Login OAuth
The Meta Developer Portal shows permissions named `instagram_business_basic` etc., but these belong to a **separate** "Instagram Business Login" product. Using them in Facebook Login OAuth causes "Invalid Scopes" error that blocks ALL connections. The correct scope names for Facebook Login are: `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_messages`. **This is documented in CLAUDE.md "Do Not Attempt" #14.**

---

## Common Errors Quick Reference

| Error | Platform | Meaning |
|-------|----------|---------|
| 100 "No permission" | Facebook | App in Testing mode OR missing scope |
| 351 "video file problem" | Facebook | Almost never the file — check real error. Test in API Explorer. |
| 390 "Video Upload Time Out" | Facebook | Good sign — permission granted |
| 190 "Invalid OAuth token" | Meta | Token expired — reconnect |
| 9007 "media not ready" | Instagram | Container not polled — poll status until FINISHED |
| 36003 "invalid aspect ratio" | Instagram | Image outside 4:5 to 1.91:1 — auto-crop handles this |
| Error #3 "no capability" | Instagram | Wrong endpoint — use `POST /me/messages` not `/{id}/messages` |
| Error #100 "nonexisting field" | Instagram | Requesting `message` field on IG comment — use `text` |

---

## What's Still Pending

1. ~~Instagram DM end-to-end test~~ — ✅ CONFIRMED WORKING (2026-03-28, full 3-step multi-step flow)
2. **Meta App Review** — `pages_messaging` and `instagram_manage_messages` need approval for non-admin users
3. **Remove diagnostic logging** — after Instagram DM confirmed, clean verbose logs
4. **Comment polling fallback** — `pages_read_engagement` returns error 10 for polling (needs Standard Access). Webhooks work.
5. **Platform OAuth setup** — TikTok, LinkedIn, X, YouTube (deferred)
