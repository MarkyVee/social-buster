# Platform Publishing Guide
## Lessons from Building All 8 Platform Integrations

This document is the authoritative reference for platform publishing in Social Buster.
Written after completing Facebook video publishing end-to-end.
Read this BEFORE starting any new platform integration or touching existing publishing code.

---

## The #1 Rule: Test in the Platform's API Explorer First

Before writing or debugging ANY code, go to the platform's API test tool and
make the exact API call your code will make. If it fails there, the problem is
configuration — not code. This 2-minute test saved days on Facebook.

- **Facebook/Instagram/Threads:** [Graph API Explorer](https://developers.facebook.com/tools/explorer)
- **TikTok:** TikTok Developer Portal → API Explorer
- **LinkedIn:** LinkedIn Developer Portal → OAuth Token Inspector + direct API calls
- **X (Twitter):** [OAuth Playground](https://developer.x.com/en/docs/authentication/oauth-2-0)
- **YouTube:** [Google OAuth Playground](https://developers.google.com/oauthplayground)

---

## The Facebook Video Publishing Story — Full History

### What we were trying to do
Publish a video from Google Drive to a Facebook Page via the Graph API.

### Timeline of failures and discoveries

**Day 1–2: Error 351 on everything**

Error 351 "There was a problem with your video file" appeared on every single attempt.
It persisted through: re-encoding to H.264/AAC, downloading files locally, switching
API domains, refreshing OAuth tokens. It is a misleading surface error — it almost
never means the file itself is the problem.

**Everything tried that FAILED:**

| Approach | Result | Why it failed |
|---|---|---|
| URL-based upload (`file_url=drive.google.com/...`) | Error 351 | Drive URLs require auth — Facebook can't fetch them |
| URL-based upload with Supabase CDN URL | Error 351 | App was in testing mode — permission issue masked as file error |
| Multipart upload to `graph-video.facebook.com` (testing mode) | Error 351 | App was unpublished — same mask |
| Old 3-phase Resumable Upload API (`upload_phase=start/transfer/finish`) | Error 351 | Permission issue + deprecated approach |
| Re-encoding to H.264/AAC (forceReencode=true) | Still 351 | Correct encoding but wrong root cause |
| Disconnect + reconnect Facebook (fresh token, testing mode) | Still 351 | Token was fine — app config was wrong |
| Adding `pages_manage_videos` to OAuth scope | N/A | Permission doesn't exist in Business App list |
| Adding `publish_video` to OAuth scope | N/A | No video use case for Business App type (see below) |
| Updating API version v19.0 → v21.0 | Still 351 | Version wasn't the issue |
| Facebook Uploads API (`/{APP_ID}/uploads` Phase 1 → Phase 2 → finish) | Error 351 | Fails in ~5 seconds — Phase 1 rejected; app type likely doesn't support this endpoint |
| Multipart form without `knownLength` on the file part | Error 351 | Facebook rejects immediately without Content-Length on the source field |

**Root cause discovery: App was in Testing mode**

Facebook's Business Apps ("Facebook Login for Business") restrict the
`/{page-id}/videos` endpoint in testing mode — **even for the app owner/admin**.
The `/feed` endpoint (text posts) has looser restrictions, which is why text posts
worked fine all along.

Error 351 (type: OAuthException) was masking the real error:
```
Error 100: "No permission to publish the video" (type: OAuthException)
```
This was discovered by testing directly in the Graph API Explorer with a Page Token —
bypassing the code entirely. **If you see error 351, test in Graph API Explorer first.**

**Steps taken to fix:**

1. Added a Privacy Policy URL to the Facebook App (App Settings → Basic).
   Required before Facebook allows you to publish the app.
   `privacy.html` lives at `https://social-buster.com/privacy.html`.

2. Published the app to Live mode. Required to unlock `/{page-id}/videos`.

3. Removed `publish_video` from OAuth scope. This permission does not exist as a
   use case for Business Apps. `pages_manage_posts` covers video posting in Live mode.
   Current scope: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`

4. Reconnected Facebook to get a fresh Page Access Token under the Live app.

5. Confirmed permissions working via Graph API Explorer: a POST to
   `/{page-id}/videos` with just `description` returned error 390 (timeout waiting
   for video data) — not error 100. Error 390 = permission IS granted.

**What ultimately worked:**

Simple multipart form upload to `graph-video.facebook.com` with two critical details:

```javascript
const form = new FormData();
form.append('source', fs.createReadStream(post.media_local_path), {
  filename:     'video.mp4',
  contentType:  'video/mp4',
  knownLength:  fileSize    // ← REQUIRED. Without this, Facebook rejects with 351.
});
form.append('description', message);
form.append('title',       title);
form.append('published',   'true');
// access_token goes in URL params — NOT in form body. More reliable for large uploads.

await axios.post(
  `https://graph-video.facebook.com/v21.0/${pageId}/videos`,
  form,
  {
    params:           { access_token: accessToken },
    headers:          form.getHeaders(),
    maxBodyLength:    Infinity,
    maxContentLength: Infinity,
    timeout:          120_000   // 2 minutes — video uploads need this
  }
);
```

**Status as of 2026-03-17: Facebook video publishing CONFIRMED WORKING ✅**

### `publish_video` permission — does not exist for Business Apps

When checking "Add use cases" in the Facebook App portal, the available use cases are:
- Create & manage ads with Marketing API
- Create & manage app ads with Meta Ads Manager
- Advertise on your app with Meta Audience Network
- Manage products with Catalog API
- Share or create fundraisers on Facebook and Instagram
- **Access the Live Video API** (live streaming only — NOT for uploaded video posts)
- Embed Facebook, Instagram and Threads content in other websites

There is NO "Video Library", "Video Upload", or "publish_video" use case.
`pages_manage_posts` covers video posting via `/{page-id}/videos` in Live mode.

---

## Video Analysis Pipeline — Full History

### What we were trying to do
Analyze uploaded videos once in the background, store segments in the `video_segments`
table, and show the "Analyzed ✅" badge in the media library.

### Problems encountered and fixed

**Problem 1: 50+ duplicate segments appearing**

Root cause: `videoAnalysisService.js` inserted new segment rows without deleting old
ones first. Each re-run of analysis stacked 10 more rows on top.

Fix: Added DELETE before INSERT in `analyzeVideo()`:
```javascript
await supabaseAdmin.from('video_segments').delete().eq('media_item_id', mediaItemId);
const { error } = await supabaseAdmin.from('video_segments').insert(segmentRows);
```

**Problem 2: Infinite retry loop blocking new videos**

Root cause: `seedPendingVideoAnalysis()` in `workers/index.js` auto-reset ALL 'failed'
items to 'pending' on every server startup. A consistently-failing video looped forever:
analyzing → timeout/fail → restart → pending → analyzing → ...
This held the concurrency-1 analysis queue, starving newly uploaded videos.

Fix: Removed the 'failed' auto-reset. 'failed' stays 'failed' and shows a badge
in the UI. Only 'analyzing' items (crashed mid-run) are reset to 'pending'.

**Problem 3: Partial segments left after crash reset**

Root cause: When a server crash interrupted analysis, the code reset status to 'pending'
but left partial `video_segments` rows from the aborted run. The re-run would then
INSERT on top of those partial rows.

Fix: Added segment cleanup when resetting stale 'analyzing' items:
```javascript
if (staleItems.length > 0) {
  const staleIds = staleItems.map(i => i.id);
  await supabaseAdmin.from('video_segments').delete().in('media_item_id', staleIds);
}
```

**Problem 4: Re-analysis silently doing nothing**

Root cause: BullMQ deduplicates jobs by jobId across ALL states including completed
and failed. `queueVideoAnalysis()` in `mediaAgent.js` was not removing the old job
before calling `add()`. If a video was previously analyzed (job in completed set),
calling `add()` with the same jobId returned the stale job — no new run.

Fix: Added defensive removal before add (same pattern as `seedPendingVideoAnalysis`):
```javascript
const existing = await mediaAnalysisQueue.getJob(jobId);
if (existing) {
  const state = await existing.getState();
  if (state !== 'active') await existing.remove();
}
await mediaAnalysisQueue.add('analyze-video', { mediaItemId: item.id }, { jobId });
```

**Problem 5: ANALYZING badge never updated without page refresh**

Root cause: The media library card was rendered once from `_mediaItems` state.
No polling mechanism existed to detect when background analysis completed.

Fix: Added `startAnalysisPoller()` / `stopAnalysisPoller()` in `media.js`.
After `loadMedia()`, if any videos are in 'analyzing' or 'pending' state, a
`setInterval` polls `GET /media/:id` every 5 seconds for each in-progress video
and updates the badge in-place. Stops automatically when all videos reach a
terminal state. Cleaned up when navigating away from the media view.

**Problem 6: Analysis logs invisible during slow Drive downloads**

Root cause: Google Drive download for a 1:53 video can take 2+ minutes. No logs
fired during this period, making it look like the system was frozen.

Fix: Added two progress log lines in `analyzeVideo()`:
```javascript
console.log(`[VideoAnalysis] Downloading ${item.filename} for analysis...`);
// ... download ...
console.log(`[VideoAnalysis] Download complete — running FFmpeg scene detection...`);
```

### Analysis pipeline — current state (2026-03-17) ✅

Full flow works end-to-end:
```
Drive scan → media_items row (analysis_status='pending')
          → queueVideoAnalysis() queues BullMQ job
          → mediaAnalysisWorker picks it up
          → analyzeVideo():
              sets status='analyzing'
              resolves duration (from DB or Drive API)
              checks 5-min / 500MB caps → 'too_large' if exceeded
              downloads video to temp (logs progress)
              runs FFmpeg scene detection
              extracts thumbnails, uploads to Supabase Storage
              DELETEs old segments, INSERTs new ones
              sets status='ready'
          → media library badge flips to ✅ Analyzed within 5 seconds (poller)
```

---

## Setting Up a New Platform — The Right Order

Do these steps in order. Don't start writing code until steps 1-4 are done.

### Step 1: Create the App in the Platform's Developer Portal
- Register a new app (or use the existing Social Buster app for Meta platforms)
- Set the app type correctly:
  - Facebook/Instagram/Threads: Business App ("Facebook Login for Business")
  - TikTok: Web App
  - LinkedIn: Web Application
  - X: App with Read+Write+Direct Messages permissions
  - YouTube: OAuth 2.0 Client ID (Google Cloud Console)

### Step 2: Configure the Right Permissions (Use Cases)
- Add only the permissions you actually need
- For publishing: look for a "manage_posts" or "write" permission
- Make sure permissions are at "Standard Access" not just "Basic Access"
- **For Meta Business Apps:** video publishing via `/{page-id}/videos` uses
  `pages_manage_posts` — there is no separate video permission for this app type
- **Do not** request permissions that don't exist — they silently fail or get stripped

### Step 3: Set the OAuth Redirect URI
- Must match EXACTLY what's in your `.env` — even trailing slashes matter
- For production: `https://social-buster.com/publish/oauth/{platform}/callback`
- For local dev: `http://localhost:3001/publish/oauth/{platform}/callback`
- Register BOTH in the platform portal (they can't be swapped)

### Step 4: Publish/Go Live the App
- Do this BEFORE testing publishing features
- Most platforms require at minimum a Privacy Policy URL
- Some require App Review (submit early — it can take days/weeks)
- Without this step, publishing APIs often silently fail or return misleading errors
- **Verify with Graph API Explorer AFTER going Live** — don't assume it worked
- For Meta: a POST to `/{page-id}/videos` with just `description` should return
  error 390 (timeout) not error 100 (no permission). 390 = you're good.

### Step 5: Test in the API Explorer with the Correct Token Type
- Generate a token with the scopes your app will request
- Make a test POST to the publishing endpoint
- Confirm you get a success (or a useful error like 390) — NOT a permissions error
- If permissions error → go back to Step 2/4
- **For video:** you cannot test multipart upload in Graph API Explorer (no file UI)
  but you CAN confirm the permission by posting with just `description` field

### Step 6: Add OAuth Flow to `routes/publish.js`
Follow the existing Facebook pattern:
- `POST /oauth/{platform}/start` → build auth URL, redirect user
- `GET /oauth/{platform}/callback` → exchange code for token, store encrypted
- Use `encryptToken()` before storing, `decryptToken()` when using
- Always get a LONG-LIVED token (most platforms support 60-day tokens via refresh)

### Step 7: Implement `publishTo{Platform}()` in `services/platformAPIs.js`
- Uncomment the stub that's already there
- The stub shows the correct API structure
- Wrap every API call in the platform's equivalent of `fbCall()` (extract real errors)
- Add `timeout: 30_000` to every axios call — required in Docker environments
- Test with a text post first, then images, then video

### Step 8: Disconnect and Reconnect to Test
- Always reconnect after any app config change in the developer portal
- Tokens issued before a config change won't have new permissions

---

## Platform-by-Platform Notes

### Facebook ✅ WORKING
- **App type:** Business App ("Facebook Login for Business") — limits available permissions
- **Token type:** Page Access Token
- **Text posts:** ✅ Working
- **Image posts:** Not yet tested
- **Video posts:** ✅ Working (confirmed 2026-03-17)
- **Scopes:** `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`
- **Upload approach:** Simple multipart to `https://graph-video.facebook.com/v21.0/{page-id}/videos`
  - `source` field with `knownLength` set (REQUIRED — omitting causes immediate error 351)
  - `access_token` in URL params (not form body)
  - 120-second axios timeout
- **Gotcha:** `publish_video` does not exist as a use case for Business Apps
- **Gotcha:** Error 351 almost never means the file is bad — it masks permission errors
- **Gotcha:** Error 351 in Testing mode = your app isn't published to Live yet

### Instagram (next up)
- **App:** Same Meta app as Facebook — already configured
- **Token type:** Page Access Token (same token as Facebook, different endpoint)
- **Publish:** 2-step process — create container → publish container
  - Step 1: `POST /{ig-user-id}/media` with `image_url` or `video_url` + `caption`
  - Step 2: `POST /{ig-user-id}/media_publish` with `creation_id`
- **Permissions needed:** `instagram_basic`, `instagram_content_publish`
- **Video:** Use `media_type: 'REELS'` for video. Must be a public URL — no multipart upload
- **Image:** Must be a public JPEG/PNG URL — no multipart upload (Facebook is opposite)
- **Gotcha:** Instagram uses the IG Business Account ID, not the Facebook Page ID
  - `platform_user_id` for Instagram = the `instagram_business_account.id` (stored during Facebook OAuth)
- **Status:** Stub exists in `platformAPIs.js`, OAuth already saves the IG token
- **App Review:** `instagram_content_publish` requires App Review for public launch

### Threads
- **App:** Same Meta app — Threads API product already added
- **OAuth:** Separate flow through `threads.net` — already built in `routes/publish.js`
- **Publish:** 2-step (same as Instagram)
  - Step 1: `POST /me/threads` with `text` + `media_type`
  - Step 2: `POST /me/threads_publish` with `creation_id`
- **Permissions:** `threads_basic`, `threads_content_publish`
- **Gotcha:** Redirect URI is still `localhost` in the code — update to real domain before testing
- **Gotcha:** No hashtags shown on Threads — don't append hashtags to the post text
- **Text limit:** 500 characters

### TikTok
- **App:** New app at developers.tiktok.com
- **Token type:** User Access Token (TikTok doesn't have "Pages" — it's user-based)
- **Publish:** `POST /video/publish/video/init/` (Content Posting API)
  - Option A: Pull from URL — TikTok fetches the video from your URL
  - Option B: File upload — direct upload to TikTok's servers
- **Permissions:** `video.publish`
- **Gotcha:** TikTok requires privacy review for content posting — apply early
- **Gotcha:** Video must be 3–60 seconds for standard posts, 3–10 min for longer
- **Gotcha:** No URL-based image posts — TikTok is video-only
- **Status:** Stub exists in `platformAPIs.js`

### LinkedIn
- **App:** linkedin.com/developers
- **Token type:** Member Access Token (OAuth 2.0)
- **Publish:** UGC Posts API — `POST /ugcPosts`
  - Uses URN format: `urn:li:person:{id}` for the author
- **Permissions:** `w_member_social`
- **Video:** Multi-step upload (initialize → upload chunks → register)
- **Gotcha:** LinkedIn API uses `X-Restli-Protocol-Version: 2.0.0` header — required
- **Gotcha:** Token expires after 60 days — must implement refresh
- **Status:** Stub exists in `platformAPIs.js`

### X (Twitter)
- **App:** developer.x.com
- **Token type:** OAuth 2.0 with PKCE
- **Publish:** `POST /2/tweets` with `{text: "..."}`
- **Permissions:** `tweet.write`, `users.read`
- **Gotcha:** 280 character limit TOTAL including hashtags — enforce before posting
- **Gotcha:** Free tier: 1,500 tweets/month (per app, not per user)
- **Video:** Chunked media upload first, then attach `media_id` to tweet
- **Status:** Stub exists in `platformAPIs.js`

### YouTube
- **App:** Google Cloud Console — same project as Google Drive OAuth
- **Token type:** Google OAuth 2.0 (googleapis SDK already in the project)
- **Publish:** `youtube.videos.insert()` via googleapis SDK
- **Permissions:** `https://www.googleapis.com/auth/youtube.upload`
- **Gotcha:** YouTube doesn't accept image posts — video only
- **Gotcha:** Quota limit: 10,000 units/day free. Video upload = 1,600 units. ~6 uploads/day free
- **Gotcha:** New apps are in "Testing" mode — must submit for production access to post publicly
- **Status:** Stub exists in `platformAPIs.js`

### WhatsApp
- **App:** Same Meta app — WhatsApp Business product
- **Token type:** System User Access Token (via WhatsApp Business API)
- **Publish:** Different from other platforms — WhatsApp is for direct messages, not public posts
- **Note:** Not yet planned in the current roadmap

---

## Common Errors and What They Actually Mean

| Error | Platform | What it actually means |
|---|---|---|
| "No permission to publish" (100) | Facebook | App is in Testing mode OR token missing scope |
| Error 351 "video file problem" | Facebook | **Almost never the file.** Check `FB raw error response` log for real error. OAuthException type = permission/app issue. Test in Graph API Explorer to confirm. |
| Error 390 "Video Upload Time Out" (is_transient=true) | Facebook | **Good sign.** Permission IS granted — Facebook accepted the request and timed out waiting for the file. Proceed with upload. |
| "Invalid OAuth access token" (190) | Facebook/Instagram | Token expired or revoked — user needs to reconnect |
| "Duplicate content" (506) | Facebook | Same text posted twice in a short window — normal during testing |
| Error 400 with no message | Any | You're not extracting the real error from `err.response.data` — wrap calls in `fbCall()` or equivalent |
| "Request failed with status code 400" | Any | Raw axios error. Always extract `err.response?.data?.error` |
| Timeout / no response | Any | Missing `timeout: 30_000` on axios call in Docker environments |
| Analysis badge stuck on "Analyzing" forever | Internal | Check `analysis_status` in DB. If 'analyzing' but no worker logs: server probably crashed mid-run. Run `UPDATE media_items SET analysis_status='pending' WHERE analysis_status='analyzing'` in Supabase SQL editor, then restart server. |

---

## Token Storage Pattern (Already Built — Don't Change)

```
OAuth flow → short-lived token
         → exchange for long-lived token (60 days)
         → store encrypted in platform_connections table

Publishing → load from DB
           → decryptToken()
           → make API call
```

- `encryptToken()` / `decryptToken()` are in `services/tokenEncryption.js`
- Never store plain-text tokens
- Never log tokens (not even partial)
- `token_expires_at` column tracks expiry — `publishToFacebook()` checks this

---

## Things That Must Never Be Changed (Protect These)

### Facebook video upload — `platformAPIs.js`
```javascript
// PROTECT: knownLength is mandatory. Facebook rejects multipart without Content-Length.
form.append('source', fs.createReadStream(path), { knownLength: fileSize });

// PROTECT: access_token in URL params, not form body. More reliable for large uploads.
params: { access_token: accessToken }

// PROTECT: 120-second timeout. Video uploads take time — shorter will timeout.
timeout: 120_000
```

### Video segments — `videoAnalysisService.js`
```javascript
// PROTECT: DELETE before INSERT. Without this, each re-run stacks duplicates.
await supabaseAdmin.from('video_segments').delete().eq('media_item_id', mediaItemId);
await supabaseAdmin.from('video_segments').insert(segmentRows);
```

### Analysis recovery — `workers/index.js` `seedPendingVideoAnalysis()`
```javascript
// PROTECT: Only reset 'analyzing' → 'pending' (crashed mid-run).
// Do NOT auto-reset 'failed' → 'pending'. Failed items loop forever and
// block the concurrency-1 queue, starving new videos.

// PROTECT: Delete partial segments when resetting stale 'analyzing' items.
// Without this, the re-run inserts on top of partial data.
await supabaseAdmin.from('video_segments').delete().in('media_item_id', staleIds);
```

### Job deduplication — `mediaAgent.js` `queueVideoAnalysis()`
```javascript
// PROTECT: Remove old job before add(). BullMQ deduplicates across ALL states
// including completed/failed. Without removal, add() with the same jobId returns
// the stale job and analysis never re-runs.
const existing = await mediaAnalysisQueue.getJob(jobId);
if (existing) {
  const state = await existing.getState();
  if (state !== 'active') await existing.remove();
}
```

---

## Files to Know

| File | What it does |
|---|---|
| `backend/routes/publish.js` | OAuth flows for all platforms. Add `start` + `callback` routes here. |
| `backend/services/platformAPIs.js` | All publishing calls. Uncomment + fill in the stub for each platform. |
| `backend/agents/publishingAgent.js` | Orchestrates publish: downloads media, calls platformAPIs, retries. |
| `backend/agents/mediaAgent.js` | Drive scan + video analysis job queuing. |
| `backend/workers/index.js` | Startup recovery for analysis pipeline. Handles stale 'analyzing' items. |
| `backend/services/videoAnalysisService.js` | FFmpeg scene detection, segment storage. |
| `backend/workers/mediaAnalysisWorker.js` | BullMQ worker for analyze-video jobs. 8-min hard timeout. |
| `backend/services/ffmpegService.js` | Video re-encoding. Handles H.264/AAC conversion for all platforms. |
| `frontend/public/js/media.js` | Media library UI. Includes analysis status poller. |
| `frontend/public/privacy.html` | Privacy Policy page at `https://social-buster.com/privacy.html` |

---

## DM Automation — Complete Debugging History & Solution (2026-03-24)

### What We Built
Comment-to-DM automation on Facebook. Someone comments a trigger keyword on a Page post → system automatically sends them a Direct Message. This took 5 debugging rounds across multiple sessions to get working. Every issue and solution is documented below so future platform integrations (Instagram, Threads, etc.) can avoid the same traps.

### The Working Pipeline (CONFIRMED WORKING)

```
Meta Webhook → webhooks.js (signature verify)
  → commentAgent.js (trigger keyword match)
    → dmAgent.js (create conversation row, queue DM job)
      → dmWorker.js (decrypt token, call messagingService)
        → messagingService.js (POST /{page_id}/messages with recipient.comment_id)
          → DM arrives in commenter's Messenger inbox ✅
```

### The Correct API Call (THIS IS WHAT WORKS)

```
POST https://graph.facebook.com/v21.0/{PAGE_ID}/messages
Body (JSON):
{
  "recipient": {
    "comment_id": "{comment_id}"
  },
  "message": {
    "text": "Your message here"
  }
}
Params: access_token={PAGE_ACCESS_TOKEN}
```

**Key details:**
- `PAGE_ID` = the Facebook Page's numeric ID (stored in `platform_connections.platform_user_id`)
- `comment_id` = the full comment ID from the webhook (format: `{post_id}_{comment_id}`)
- Uses the **Page Access Token**, not a User Token
- Does NOT require `messaging_type` field (unlike regular Send API with PSID)

### What Does NOT Work (The Deprecated Endpoint)

```
POST https://graph.facebook.com/v21.0/{comment_id}/private_replies
Body: { message: "text" }
```

This is the **old Private Replies endpoint** that was deprecated after Graph API v3.2. It returns error 100 subcode 33: "Object with ID does not exist, cannot be loaded due to missing permissions, or does not support this operation." If you ever see this exact error on a DM call, the first thing to check is whether you're using the old endpoint.

### Required OAuth Scopes (in routes/publish.js)

```
pages_show_list
pages_read_engagement          ← reads Page-published content (posts, follower data)
pages_read_user_content        ← reads user-generated content (comments, reviews) — REQUIRED for comment-to-DM
pages_manage_posts             ← create/edit/delete posts
pages_manage_metadata          ← subscribe Page to webhooks
pages_messaging                ← send DMs via Messenger + Private Replies
instagram_basic
instagram_content_publish
instagram_manage_comments      ← Instagram comment monitoring
instagram_manage_messages      ← Instagram DM automation
```

### Chronological Issue Log (5 Issues, All Resolved)

#### Issue 1: Error 100 subcode 33 — "Missing Permissions" on comment read
- **Symptom:** `Facebook Private Reply error 100 subcode=33: Object with ID does not exist, cannot be loaded due to missing permissions`
- **Root cause:** Page token had `pages_read_engagement` but NOT `pages_read_user_content`. These are different permissions: `pages_read_engagement` reads content posted BY the Page, while `pages_read_user_content` reads content posted BY USERS (comments, reviews) on the Page.
- **How we diagnosed:** Graph API Explorer — `GET /{comment_id}` returned "Missing Permissions" without `pages_read_user_content`, returned full comment data with it.
- **Fix:** Added `pages_read_user_content` to OAuth scopes in `routes/publish.js` (commit `90847b2`)
- **Lesson for future platforms:** Always test reading the content object BEFORE trying to act on it. If you can't read it, you definitely can't reply to it.

#### Issue 2: Page admin cannot receive DMs from own Page
- **Symptom:** Everything looked correct in logs but DM never arrived for Page admin (Mark Vidano)
- **Root cause:** Facebook cannot send a DM from a Page to that Page's own admin. It's "messaging yourself" — a Meta platform limitation.
- **Fix:** Test with a completely separate Facebook account that has no admin/developer role on the Page.
- **Lesson for future platforms:** ALWAYS test DM features with a separate, unrelated account. Admin/owner accounts often have special restrictions or behaviors that don't reflect real user experience.

#### Issue 3: RLS policy violation on dm_conversations table
- **Symptom:** `new row violates row-level security policy for table 'dm_conversations'`
- **Root cause:** Table had RLS enabled but NO policy existed. Even `supabaseAdmin` (service role key) was blocked. Supabase sometimes enforces RLS even for service role if `relforcerowsecurity` interacts unexpectedly or no policy exists.
- **Fix:** Created RLS policy: `CREATE POLICY "Users can manage own dm_conversations" ON dm_conversations FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());`
- **Lesson for future platforms:** Every new table that workers/agents write to needs an RLS policy BEFORE you test. Add the policy in the same migration SQL that creates the table. Even if using `supabaseAdmin`, create the policy as a safety net.

#### Issue 4: Dedup guard permanently blocks retries after failed DM
- **Symptom:** `[DMAgent] Skipping — already DM'd Sharon Vidano for automation {id}` — even though the DM was never actually delivered
- **Root cause:** `dm_conversations` row was created BEFORE the DM was sent. When the DM failed (due to RLS error), the row stayed with status `'active'`. The dedup guard only checked if a row EXISTS, not whether the DM was delivered. Future comments from the same person were permanently blocked.
- **Fix (commit `111f87f`):**
  1. `dmWorker.js` — `worker.on('failed')` now marks conversation `status: 'failed'`
  2. `dmAgent.js` — dedup guard checks status. If `'failed'`, deletes stale row and retries. All other statuses (`active`, `completed`, `expired`, `opted_out`) still block duplicates correctly.
- **Lesson for future platforms:** Any dedup/idempotency guard must distinguish between "attempted and succeeded" vs "attempted and failed." If you create a tracking row before the action, you MUST update it on failure, or the guard becomes a permanent blocker. This applies to any system where you create state before confirming the action completed.

#### Issue 5: Deprecated API endpoint — THE ROOT CAUSE OF DM DELIVERY FAILURE
- **Symptom:** Error 100 subcode 33 on every Private Reply attempt, even after all permission fixes. Comment was readable (diagnostic GET succeeded), but the POST to `/{comment_id}/private_replies` always failed.
- **Root cause:** The `POST /{comment_id}/private_replies` endpoint was **deprecated after Graph API v3.2** (circa 2019). Meta moved Private Replies into the Messenger Send API. The old endpoint returns the same generic error 100/subcode 33 as permission errors, which made it extremely confusing to diagnose.
- **How we diagnosed:** Got a second opinion from another LLM (Groq) which identified the deprecated endpoint. Tested the modern endpoint in Graph API Explorer — immediate success.
- **Fix (commit `e4d59da`):** Changed `sendPrivateReply()` in `messagingService.js` from:
  ```
  POST /{comment_id}/private_replies
  Body: { message: "text" }
  ```
  To:
  ```
  POST /{page_id}/messages
  Body: { recipient: { comment_id: "{comment_id}" }, message: { text: "text" } }
  ```
  Also updated `dmWorker.js` to fetch `platform_user_id` (Page ID) from `platform_connections` and pass it to `sendPrivateReply()`.
- **Confirmed working:** Tested in Graph API Explorer with Page Access Token → `recipient_id` and `message_id` returned → DM arrived in Sharon's Messenger inbox.
- **Lesson for future platforms:** Error 100 subcode 33 is a GENERIC error that Meta uses for at least 3 different problems: (a) missing permissions, (b) object doesn't exist, (c) deprecated/unsupported endpoint. When you see this error, check ALL three possibilities. Always verify the endpoint is current by checking Meta's latest documentation — don't trust code examples from Stack Overflow or older tutorials. The Graph API Explorer is the fastest way to test: if the call works there with the same token/params, the code is wrong. If it fails there too, the endpoint or permissions are wrong.

### Answers to Common Questions (Resolved During Debugging)

**Q: Does the DM recipient need an app role (Tester/Developer)?**
A: NO. Sharon received the DM with no Facebook-side app role. She was only an "Instagram Tester (Pending)" which has nothing to do with Facebook messaging. Regular Facebook users can receive Private Replies as long as the Page has `pages_messaging` permission (even at "Ready for testing" level).

**Q: Does the token need to be refreshed after adding new OAuth scopes?**
A: YES. After adding `pages_read_user_content` to the scopes list in code, the user must disconnect and reconnect Facebook in the app to get a fresh token that includes the new permission. The old token doesn't retroactively gain new scopes.

**Q: Does the Page need to be re-subscribed to webhooks after reconnecting?**
A: No. Webhook subscriptions are tied to the app + Page, not to the specific token. Reconnecting OAuth doesn't affect webhook delivery.

**Q: Can you test Private Replies in Graph API Explorer?**
A: YES — this is the single best debugging tool. Steps:
1. Go to developers.facebook.com/tools/explorer
2. Select your app, then select the Page token (not User Token)
3. Set method to POST
4. URL: `{page_id}/messages`
5. Use Params tab: `recipient` = `{"comment_id":"..."}`, `message` = `{"text":"..."}`
6. Submit — if you get `recipient_id` + `message_id`, it works

### How to Debug DM Failures on ANY Platform (Diagnostic Checklist)

Use this checklist whenever DM automation fails on any platform:

1. **Can you READ the trigger object (comment/mention)?**
   - Test: `GET /{object_id}` with the platform token
   - If NO → missing read permission (e.g., `pages_read_user_content` for Facebook)

2. **Are you using the CURRENT API endpoint?**
   - Check the platform's latest API docs, not cached knowledge or old tutorials
   - Meta specifically has deprecated multiple DM endpoints over the years

3. **Are you testing with the right account?**
   - Page admins often can't DM themselves
   - Use a completely separate account with no special roles

4. **Does the database table have proper RLS policies?**
   - Check BEFORE testing, not after it fails
   - Every table workers write to needs a policy

5. **Does your dedup/idempotency guard handle failures?**
   - If you create tracking rows before the action, they MUST be updated on failure
   - Otherwise failed attempts permanently block retries

6. **Is the token fresh with all required scopes?**
   - Adding scopes to code doesn't update existing tokens
   - User must disconnect + reconnect to get a new token

7. **Test the API call manually in the platform's Explorer/Playground FIRST**
   - If it works there → your code is wrong
   - If it fails there → the endpoint, permissions, or parameters are wrong

### Key Files in the DM Pipeline
| File | Role |
|------|------|
| `backend/routes/webhooks.js` | Receives Meta webhooks, verifies signature, routes to commentAgent or dmAgent |
| `backend/agents/commentAgent.js` | Processes comments, matches trigger keywords, calls startConversation() |
| `backend/agents/dmAgent.js` | Conversation state machine — creates rows, queues DM jobs, handles retries on failure |
| `backend/workers/dmWorker.js` | Picks up DM jobs, decrypts tokens, calls messagingService, marks failures |
| `backend/services/messagingService.js` | Calls Meta Graph API — sendPrivateReply() + sendDM() + rate limiting |
| `backend/routes/publish.js` | Facebook OAuth scopes (where permissions are requested) |

### Key Commits (in order)
- `ff7d431` — Initial: Use Facebook Private Replies API (old deprecated endpoint)
- `90847b2` — Fix: Add `pages_read_user_content` OAuth scope + diagnostic logging
- `111f87f` — Fix: Dedup guard allows retries when previous attempt failed
- `e4d59da` — **THE FIX:** Switch from deprecated `/{comment_id}/private_replies` to modern `/{page_id}/messages` with `recipient.comment_id`
