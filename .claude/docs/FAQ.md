# Social Buster — FAQ & Troubleshooting

Common problems encountered during development and testing, with screenshots and solutions.

---

## Facebook / Instagram OAuth

### "Feature Unavailable — Facebook Login is currently unavailable for this app"

**Symptom:**
When clicking "Connect Facebook" in Settings, Facebook shows this screen instead of the login/permissions dialog:

> *Feature Unavailable*
> *Facebook Login is currently unavailable for this app, since we are updating additional details for this app. Please try again later.*

With a "Reload Page" button and a wrench/robot graphic.

**What it looks like:**
The error appears on Facebook's domain (not Social Buster). Our server logs show `POST /publish/oauth/meta/start HTTP/1.1 200` — meaning our code worked fine and handed off a valid OAuth URL. The error is on Facebook's side.

**Root cause:**
Another Facebook account was signed in on a different browser tab. When Facebook tries to handle the OAuth login, it gets confused by the conflicting session and shows this generic error instead of the login flow.

**Solution:**
1. Close all other browser tabs that have Facebook open
2. Make sure only **one** Facebook account is signed in in the entire browser session
3. Try connecting again — it will work immediately

**Also check if this doesn't fix it:**
- The app might have been switched from Development to Live mode without passing App Review
- "Require App Secret" may have been enabled in Meta App Settings → Advanced → Security (see [[ISSUES]] ISSUE-034)
- The user trying to connect may not be added as a Tester/Admin in the Meta App Dashboard (Development mode only allows registered testers)

---
