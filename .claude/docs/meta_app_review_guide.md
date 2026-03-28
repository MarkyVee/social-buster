# Social Buster — Meta App Review Summary

This document contains everything needed to walk through the Meta App Review process. Give this to whoever is helping you with the submission.

---

## What Social Buster Is

Social Buster is a social media marketing platform for small businesses in the United States. Users sign up, connect their Facebook Pages and Instagram Business accounts, and the platform does three things:

1. **AI Post Generation** — Users fill out a brief describing what they want to promote. The AI generates platform-specific post options with captions, hashtags, and calls-to-action.

2. **Auto-Publishing** — Posts are published directly to the user's Facebook Page and Instagram Business account through the Meta Graph API. Users can publish immediately or schedule for later.

3. **Comment-to-DM Automation** — When someone comments a specific trigger keyword on a published post (e.g., "INFO"), the system automatically sends them a Direct Message with a link, resource, or lead-capture form. This works on both Facebook (via Messenger) and Instagram (via Instagram Messaging).

---

## Meta App Details

| Field | Value |
|-------|-------|
| **App Name** | Social Buster |
| **App ID** | 1240290211015400 |
| **App Type** | Business App ("Facebook Login for Business") |
| **App Status** | Published / Live |
| **Instagram App ID** | 158131581979937 |
| **Business Manager** | Managed by Mark Vidano |
| **Privacy Policy URL** | https://social-buster.com/privacy.html |
| **Website** | https://social-buster.com |
| **Webhook Callback URL** | https://social-buster.com/webhooks/meta |
| **OAuth Redirect URI** | https://social-buster.com/publish/oauth/meta/callback |
| **Target Market** | United States only |
| **Target Users** | ~5,000 small business owners |

---

## Use Cases Added to the App

These are the use cases already configured in the Meta Developer Portal:

1. **Manage everything on your Page** — Publishing posts (text, image, video) to Facebook Pages
2. **Engage with customers on Messenger from Meta** — Sending DMs to people who comment on Page posts
3. **Manage messaging & content on Instagram** — Publishing to Instagram + DM automation on Instagram
4. **Access the Threads API** — (Future — currently blocked by ISSUE-021, Meta OAuth bug)
5. **Measure ad performance data with Marketing API** — (Future)
6. **Capture & manage ad leads with Marketing API** — (Future)
7. **Connect with customers through WhatsApp** — (Future)

---

## Permissions (Scopes) We Request During OAuth

These are the exact permissions requested when a user connects their Facebook/Instagram account:

### Facebook Permissions

| Permission | What We Use It For | Status Needed |
|---|---|---|
| `pages_show_list` | Show the user which Pages they can connect | Standard Access |
| `pages_read_engagement` | Read Page metrics (likes, reach) for our analytics dashboard | Standard Access |
| `pages_read_user_content` | Read comments on Page posts — required to match trigger keywords and send DMs | Standard Access |
| `pages_manage_posts` | Publish text, image, and video posts to the user's Facebook Page | Standard Access |
| `pages_manage_metadata` | Subscribe the Page to webhooks so we receive real-time comment notifications | Standard Access |
| `pages_messaging` | Send DMs via Messenger to people who comment trigger keywords on Page posts | Standard Access |

### Instagram Permissions

| Permission | What We Use It For | Status Needed |
|---|---|---|
| `instagram_basic` | Read the user's Instagram Business account info (username, ID) | Standard Access |
| `instagram_content_publish` | Publish image and video posts to the user's Instagram Business account | Standard Access |
| `instagram_manage_comments` | Read comments on Instagram posts — required for trigger keyword matching | Standard Access |
| `instagram_manage_messages` | Send DMs to people who comment trigger keywords on Instagram posts | Standard Access |

---

## How the DM Automation Works (for App Review explanation)

This is the user flow that the reviewer needs to understand:

1. **User creates a DM automation** in Social Buster — they set a trigger keyword (e.g., "INFO") and write the message they want to send
2. **User publishes a post** to their Facebook Page or Instagram account through Social Buster
3. **Someone comments** on that post with the trigger keyword ("INFO")
4. **Meta sends us a webhook** (real-time notification) with the comment details
5. **Our server matches** the comment text against the trigger keyword
6. **We send a DM** to the commenter using `POST /{page_id}/messages` with `recipient.comment_id` (Facebook) or the equivalent Instagram endpoint
7. The commenter receives the DM in their Messenger or Instagram inbox

**Important details for the reviewer:**
- We only DM people who comment a specific keyword — we never send unsolicited messages
- Each person only gets ONE DM per automation (dedup guard prevents spam)
- We enforce a daily DM limit per account (50 for Instagram, 200 for Facebook) to comply with Meta's spam policies
- The DM is always a response to a user-initiated action (their comment)
- We use the modern `POST /{page_id}/messages` endpoint with `recipient.comment_id` (not the deprecated `/{comment_id}/private_replies`)

---

## API Endpoints We Use

| Endpoint | Method | Purpose |
|---|---|---|
| `/{page_id}/feed` | POST | Publish text posts to Facebook Page |
| `/{page_id}/photos` | POST | Publish image posts to Facebook Page |
| `/{page_id}/videos` | POST | Publish video posts to Facebook Page (multipart upload) |
| `/{ig_user_id}/media` | POST | Create Instagram media container (step 1 of 2) |
| `/{ig_user_id}/media_publish` | POST | Publish Instagram media (step 2 of 2) |
| `/{page_id}/messages` | POST | Send DM to commenter via Messenger (Private Reply) |
| `/{page_id}/subscribed_apps` | POST | Subscribe Page to webhooks for real-time comment/message events |
| `/me/accounts` | GET | List user's Facebook Pages during OAuth |
| `/{page_id}` | GET | Get Page details (name, ID, linked Instagram) |
| `/{ig_account_id}` | GET | Get Instagram Business account details |
| `/{comment_id}` | GET | Read comment details (diagnostic — verify permissions) |

---

## Webhook Subscriptions

**Facebook Page webhooks** (subscribed via `/{page_id}/subscribed_apps`):
- `feed` — Real-time comment notifications on Page posts
- `messages` — DM replies from users in multi-step conversations
- `messaging_postbacks` — Button click events in DMs
- `message_deliveries` — Delivery receipts
- `messaging_optins` — Opt-in events

**Instagram webhooks** (subscribed at app level in Meta Developer Portal):
- `comments` — Real-time comment notifications on Instagram posts
- `messages` — DM replies from users
- `message_reactions` — Reaction events on DMs

**Note:** Instagram does NOT have a per-account `subscribed_apps` endpoint. Instagram webhooks are enabled by (1) app-level subscription in the portal + (2) the Facebook Page `subscribed_apps` call for the linked Page.

---

## Current App Status

| Feature | Facebook | Instagram |
|---------|----------|-----------|
| OAuth / Connect | Working | Working |
| Publishing (text) | Working | N/A |
| Publishing (image) | Working | Working |
| Publishing (video) | Working | Not yet tested |
| Comment webhooks | Working | Untested (needs App Review?) |
| DM automation | Working | Untested (needs App Review?) |

---

## What We Need From App Review

**Standard Access** for all permissions listed above. Currently everything is at "Ready for testing" level, which only works for app admins and testers. We need Standard Access so that any user who signs up for Social Buster can connect their Facebook Page / Instagram account and use all features.

---

## Screencast / Demo Script (what to show the reviewer)

The reviewer will likely want a screencast showing how the app uses each permission. Here's the flow to demonstrate:

1. **Sign up / Log in** to Social Buster
2. **Connect Facebook** — show the OAuth flow, Page picker, Instagram auto-connecting
3. **Create a brief** — fill out the AI post generation form
4. **Publish a post** — show it appearing on the Facebook Page and/or Instagram
5. **Set up a DM automation** — create an automation with trigger keyword "INFO"
6. **Comment on the post** from a separate account with "INFO"
7. **Show the DM arriving** in the commenter's Messenger/Instagram inbox
8. **Show the leads dashboard** — where collected lead data appears

---

## Known Blockers Before App Review

1. **Instagram DM testing** — Need to verify Instagram comment webhooks arrive (ISSUE-024). May need to fix Sharon's tester role or complete "Instagram Business Login" setup in the portal first.
2. **Threads OAuth** — Broken due to Meta bug (ISSUE-021). Not needed for initial App Review.
3. **Screencast recording** — Need to record the demo showing all features working end-to-end.

---

## Key Files in the Codebase

| Item | Location |
|---|---|
| OAuth flow (all scopes) | `backend/routes/publish.js` |
| Facebook publishing | `backend/services/platformAPIs.js` |
| Instagram publishing | `backend/services/platformAPIs.js` |
| Webhook handler | `backend/routes/webhooks.js` |
| Comment processing | `backend/agents/commentAgent.js` |
| DM automation | `backend/agents/dmAgent.js` |
| DM sending | `backend/services/messagingService.js` |
| DM worker (BullMQ) | `backend/workers/dmWorker.js` |
| Privacy Policy | `frontend/public/privacy.html` |
| Token encryption | `backend/services/tokenEncryption.js` |
