# Age Gating & US Geo Gating Plan

**Status:** Planned — not yet built
**Date created:** 2026-04-07
**Related:** [[FEATURES]] FEAT-037, [[terms.html]], [[SYSTEM_OVERVIEW]]

---

## Overview

Social Buster is a U.S.-only platform intended for users 18 and older. This plan covers three layers of enforcement:

1. **Layer 1 — Signup Gate** (checkboxes on registration form)
2. **Layer 2 — Terms of Service** (legal language — ✅ already done)
3. **Layer 3 — Cloudflare WAF** (technical geo enforcement — you control this)

---

## What We Are NOT Doing

- No date of birth field — checkbox only. The platform is designed for small business owners and under-18 usage is not a real concern.
- No backend DOB validation — nothing to validate without a DOB field.
- No blocking existing users — applies to new signups only.

---

## Layer 2 — Terms of Service ✅ DONE

Age restriction language added to Section 1 (Eligibility) alongside the existing U.S.-only geographic restriction. Both are in `frontend/public/terms.html`.

---

## Layer 1 — Signup Gate

### What We're Building

Two checkboxes added to the signup form in `renderAuthView()` inside `frontend/public/js/app.js`:

- ☐ I confirm I am 18 years of age or older
- ☐ I confirm I am located in the United States

**Rules:**
- Both must be checked before the signup button submits
- If either is unchecked → show an inline error message on the form (do NOT redirect — just block submission)
- The redirect to `sorry.html` is only for users who actively indicate they are under 18 or outside the US (e.g., if we add explicit "I am under 18" path in the future). For now, unchecked = inline error.
- The Supabase `signUp()` call must not fire until both checkboxes pass validation
- Client-side only — no database changes, no migration, no audit storage

### Rate Limiting

- Wire `strictLimiter` (already exists in `backend/middleware/rateLimit.js`) to the signup endpoint in `backend/routes/auth.js`
- Currently signup uses `standardLimiter` — one-line swap
- Prevents checkbox spam / bot account creation

### Files to Touch

| File | Change |
|------|--------|
| `frontend/public/js/app.js` | Add two checkboxes inside the signup block only |
| `backend/routes/auth.js` | Swap `standardLimiter` → `strictLimiter` on signup route |

### Files to NOT Touch

| File | Why |
|------|-----|
| Login block in `renderAuthView()` | Login and signup share the same view — touching the wrong block breaks login for all users |
| Toggle logic between login/signup | Do not touch the show/hide toggle function |
| `backend/middleware/auth.js` | JWT validation chain — never modify |
| `backend/middleware/tenancy.js` | Multi-tenancy isolation — never modify |

---

## Apology Page — `sorry.html`

### What It Is

A simple static HTML page — same styling as `privacy.html` and `terms.html` — shown when a user is blocked due to age or location.

One page covers both cases. No JS required. No auth required.

### Content

- Friendly apology message
- State that Social Buster is only available to users 18+ located in the United States
- Link back to homepage
- No form, no signup option

### File

`frontend/public/sorry.html`

---

## Layer 3 — Cloudflare WAF (You Do This — No Code)

### Phase 1 — Log Mode (Do First)

1. Go to **dash.cloudflare.com** → click **socialbuster.com**
2. Left sidebar → **Security** → **WAF**
3. Click **Create Rule**
4. Name: `Block non-US traffic`
5. Field: `Country` | Operator: `does not equal` | Value: `United States`
6. Action: **Log** ← start here, not Block
7. Click **Deploy**

Watch the traffic dashboard for a few days. See how much non-US traffic you're getting before going nuclear.

### Phase 2 — Block Mode (When Ready)

- Edit the rule, change Action from **Log** → **Block**
- Non-US users see Cloudflare's block page instantly
- Reversible in 10 seconds — just change back to Log or disable the rule

---

## Red Team — What Could Break

### 🔴 High Risk

**1. Breaking the login/signup toggle**
The signup form lives inside `renderAuthView()` in `app.js` — the same function that handles login. Login and signup share the same view and toggle between each other. Touching the wrong block breaks login for every user.
- **Mitigation:** Only add HTML inside the signup-specific block. Do not touch the login block or the toggle function at all. Be surgical.

**2. Supabase Auth race condition**
The signup button calls Supabase Auth directly from the frontend. If the checkbox check doesn't gate the Supabase call properly, an account could be created without confirmation passing.
- **Mitigation:** Checkbox validation must run first. `supabase.auth.signUp()` is only called if both checkboxes pass. Gate it explicitly in the submit handler.

### 🟡 Medium Risk

**3. Signup rate limiter not wired in**
`strictLimiter` exists but isn't currently on the signup route. Without it, checkbox spam and bot account creation are trivially easy.
- **Mitigation:** One-line change in `backend/routes/auth.js`. Low risk, must not be forgotten.

**4. Google Drive OAuth redirect confusion**
If a user is mid-Google-Drive OAuth flow and something redirects to `sorry.html`, the OAuth state cookie becomes orphaned.
- **Mitigation:** The `sorry.html` redirect (if used in future) only happens at signup form submission, never during an OAuth callback. These are completely separate code paths. Low actual risk.

**5. Mobile layout**
Adding two checkboxes with legal text could push the submit button below the fold on small screens, making users think the form is broken.
- **Mitigation:** Keep checkbox label text short. Test on mobile viewport before deploying.

### 🟢 Low Risk / Acceptable

**6. No audit trail for existing users**
Users who signed up before this was added have no confirmation record. Not a legal problem — Terms of Service covers it retroactively.
- **Mitigation:** Acceptable. ToS covers it.

**7. Checkbox bypass**
A determined under-18 or non-US user will just check both boxes. This is expected and acceptable — the platform is designed for small business owners and under-18 usage is not a real concern. Cloudflare geo-block is the real technical enforcement for US restriction.
- **Mitigation:** Acceptable for this use case.

**8. No stored confirmation**
No audit trail if Meta ever asks for proof that a user confirmed age.
- **Mitigation:** Checkbox is standard industry practice for B2B age gates. Acceptable for now. Can add DB storage later if needed.

---

## Build Order

| Step | What | Risk | Notes |
|------|------|------|-------|
| 1 | ✅ Layer 2 — age language in ToS | None | Done |
| 2 | Create `sorry.html` apology page | None | Static HTML, no risk |
| 3 | Add two checkboxes to signup form in `app.js` | Low | Surgical — signup block only |
| 4 | Wire `strictLimiter` to signup route in `auth.js` | Very low | One line |
| 5 | Cloudflare WAF rule — Log mode | None | You do in Cloudflare dashboard |
| 6 | Cloudflare WAF rule — flip to Block | None | When you're comfortable with the traffic data |

---

## Definition of Done

- [ ] `sorry.html` exists and matches site styling
- [ ] Signup form has both checkboxes, both required before submission
- [ ] Unchecked checkbox shows inline error, does not submit
- [ ] `supabase.auth.signUp()` only fires after both checkboxes pass
- [ ] `strictLimiter` wired to signup route
- [ ] Cloudflare WAF rule active in Log mode
- [ ] Tested on desktop and mobile — login flow unaffected
