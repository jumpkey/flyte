# Flyte — User Workflow Guide

A storyboard of the main click-paths through the app, intended as a manual testing checklist for a live deployment on fly.io.

---

## Path 1 · New User Registration

```
/ (Home)
  └─ Click "Create Account"
       └─ /register
            ├─ [validation] Leave fields blank → inline errors appear
            ├─ [validation] Type email → real-time availability check (green ✓ / red ✗)
            ├─ [validation] Enter mismatched passwords → "Passwords do not match"
            └─ Fill valid email, display name, matching passwords → Submit
                 └─ /verify-email-sent
                      └─ Check email inbox → click verification link
                           └─ /verify-email?token=…
                                └─ /dashboard  ← auto-logged-in after verification
```

---

## Path 2 · Returning User Sign-In

```
/ (Home)
  └─ Click "Sign In"
       └─ /login
            ├─ [validation] Wrong password → "Invalid email or password"
            ├─ [validation] Unverified account → "Invalid email or password"
            └─ Correct credentials → Submit
                 └─ /dashboard
```

---

## Path 3 · Authenticated User Session

```
/dashboard
  ├─ Shows: display name, email, member-since date, last-login timestamp
  └─ Click "Edit Profile"
       └─ /profile
            ├─ Change display name → Click "Save Changes"
            │    └─ Inline success message (no page reload)
            ├─ Change password → fill Current Password + New Password + Confirm
            │    └─ Inline success or error message
            └─ Click "← Back to Dashboard"
                 └─ /dashboard
```

---

## Path 4 · Logout

```
/dashboard  (or any authenticated page)
  └─ Click "Sign Out" (nav/button)
       └─ POST /logout
            └─ / (Home)  ← session cleared

Verify: navigate to /dashboard → redirects to /login
```

---

## Path 5 · Forgot Password

```
/login
  └─ Click "Forgot your password?"
       └─ /forgot-password
            └─ Enter registered email → Submit
                 └─ /forgot-password-sent  ("Check your email")
                      └─ Check email inbox → click reset link
                           └─ /reset-password?token=…
                                ├─ Enter new password + confirm → Submit
                                │    └─ /login  ← flash "Password reset successfully"
                                │         └─ Sign in with new password
                                │              └─ /dashboard
                                └─ [edge] Token expired/invalid → /reset-password-error
```

---

## Path 6 · Direct URL Access Guards

| URL | Unauthenticated | Authenticated |
|-----|-----------------|---------------|
| `/dashboard` | → `/login` | ✓ renders |
| `/profile` | → `/login` | ✓ renders |
| `/login` | ✓ renders | → `/dashboard` |
| `/register` | ✓ renders | → `/dashboard` |
| `/verify-email?token=bad` | renders error page | — |
| `/reset-password?token=bad` | renders error page | — |

---

## Path 7 · Edge Cases to Spot-Check

- **Duplicate registration** — register with an email already in the system → "Email is already registered"
- **Expired verify link** — token older than 24 h → "Invalid or expired verification link"
- **Expired reset link** — token older than 1 h → "Invalid or expired reset link"
- **Rate limiting** — submit login form 10+ times quickly → request is rejected (429 or silent block)
- **Locked account** — after repeated failed logins the account is locked; subsequent login attempts return the generic error; forgot-password does nothing for a locked account

---

## Quick Reference — All Routes

| Method | Path | What it does |
|--------|------|--------------|
| GET | `/` | Home / landing page |
| GET | `/register` | Registration form |
| POST | `/register` | Create account |
| GET | `/verify-email?token=…` | Verify email address |
| GET | `/login` | Login form |
| POST | `/login` | Authenticate user |
| GET | `/forgot-password` | Forgot-password form |
| POST | `/forgot-password` | Send reset email |
| GET | `/reset-password?token=…` | Reset-password form |
| POST | `/reset-password` | Apply new password |
| GET | `/dashboard` | User dashboard (auth required) |
| GET | `/profile` | Edit profile form (auth required) |
| POST | `/profile` | Save profile / password changes (auth required) |
| POST | `/logout` | End session (auth required) |
| POST | `/api/check-email` | HTMX email-availability check |
