# Security Audit — Flyte + Stripe Registration PR (#17)

> **Status update — 2026-06-17 (preserved onto `ui-elaboration`).** This report
> originated on the now-deleted `claude/intelligent-archimedes-rflm8c` branch and
> is kept here as the security record of record. Disposition of its findings as
> of the I1 foundation:
>
> | # | Finding | Status |
> |---|---------|--------|
> | 1 | Default admin password, reset on every seed | **Resolved** — `scripts/seed.ts` now has the production guard and an insert-only (`ON CONFLICT DO NOTHING`) upsert. |
> | 2 | HTML injection into outbound email | **Open** — escape user fields in email HTML; folded into the I3/I6 email work (S4). |
> | 3 | Container runs as root | **Open** — tracked as issue #21 (add `USER node` to the Dockerfile). |
> | 4 | CSP blocks inline payment script | **Resolved** — payment JS externalized to `/public/js/registration-form.js`; CSP tightened to `script-src 'self' js.stripe.com` (I1). |
> | 5 | `/api/check-email` enumeration oracle | **Open** — tracked as issue #22. (I1 separately closed the *login* enumeration oracle by shape and timing.) |
> | obs | `adminGuard` needed before admin routes ship | **Resolved** — `adminGuard` lands in I1, 404-on-non-admin, before any admin route. |

**Date:** 2026-06-12
**Scope:** Full application tree as it would exist after merging PR #17
(`copilot/implement-stripe-registration-flow` @ `2bec657`), including the
pre-existing auth/session stack, deployment configuration (Dockerfile,
fly.toml, docker-compose, CI workflows, crontab, scripts), and the new
two-phase Stripe payment/registration subsystem.
**Method:** Manual code review of the PR diff and full source tree, data-flow
tracing from all user inputs to SQL/HTML/email/Stripe sinks, configuration and
git-history secrets sweep, with independent false-positive verification of
every candidate finding.

---

## Summary

The codebase is in materially better security shape than most apps at this
stage — webhook signature verification, CSRF, SQL parameterization, session
crypto, and payment amount handling are all implemented correctly. **No
remotely exploitable flaw was found in the Stripe payment flow itself.**

Five verified findings remain, one of them High:

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 1 | **High** | Default admin password `changeme123` with no production guard; seeder silently resets it on every run | `scripts/seed.ts:21-25`, `src/config.ts:25` |
| 2 | Medium | HTML injection into outbound email via unauthenticated waitlist endpoint → phishing from trusted sender | `src/registration/services/NotificationService.ts:25,45,61` |
| 3 | Medium | Container processes run as root (no `USER` directive) | `Dockerfile` |
| 4 | Medium | CSP will block the inline payment script — broken checkout in production, with pressure to weaken CSP as the "fix" | `src/web/views/registration-form.ejs:51` vs `src/web/app.ts:37` |
| 5 | Low | Account-enumeration oracle at `/api/check-email` (and register form), inconsistent with the hardened forgot-password flow | `src/web/controllers/auth.ts:155-168` |

---

## Findings

### 1. HIGH — Default admin credentials with no production enforcement, reset on every seed

`src/config.ts:25` and `scripts/seed.ts:9` default the seed admin password to
the publicly known literal `changeme123`. Unlike `SESSION_SECRET` — which is
correctly enforced at `src/config.ts:3-5` (startup throws in production if
unset) — there is **no production guard** for `SEED_ADMIN_PASSWORD`.

Worse, the seeder runs an unconditional `UPDATE` after its upsert
(`scripts/seed.ts:21-25`), so **every re-run of `npm run seed` overwrites the
admin password hash back to the default**, even if an operator changed it. The
seed step is part of the documented deploy procedure (`DEPLOYMENT.md`,
`LINUX_DEPLOYMENT.md`, README) and runs in CI
(`.github/workflows/copilot-setup-steps.yml`).

**Exploit:** an operator deploys per the docs without exporting
`SEED_ADMIN_PASSWORD`; the internet-reachable `/login` now accepts
`admin@flyte.local` / `changeme123` for a verified `is_admin = TRUE` account.
Once admin routes exist (see Observations), this is full compromise.

**Fix:**
- Refuse to seed when `NODE_ENV=production` and `SEED_ADMIN_PASSWORD` is
  unset (mirror the `SESSION_SECRET` guard), or generate a random password
  and print it once.
- Make the seeder idempotent without overwriting: drop the unconditional
  `UPDATE`, or only set the hash when the row is first created.

### 2. MEDIUM — HTML injection into outbound email (phishing from trusted sender)

`NotificationService` interpolates user-controlled `firstName`/`lastName`
directly into the HTML email body with no escaping:

- `sendWaitlistAcknowledgement` (`NotificationService.ts:45`)
- `sendRegistrationConfirmation` (`:25`)
- `sendRefundConfirmation` (`:61`)

The mailer is real (`nodemailer.createTransport(config.smtp)`), and the
cleanest entry point — `POST /events/:eventId/waitlist` (`src/web/app.ts:77`,
`registration.ts addToWaitlist`) — is **unauthenticated and free**.
`validateRegistrationFields` (`registration.ts:27-49`) checks only
presence/type/length (names ≤ 100 chars each), never content, so
`<a href="https://evil.example/">Your payment failed — re-enter your card</a>`
fits comfortably across the two name fields.

**Exploit:** an attacker POSTs to the waitlist endpoint with
`email=victim@target.com` and HTML markup in the name fields. The victim
receives attacker-controlled HTML in a message genuinely sent from the app's
configured sender (`noreply@flyte.fly.dev`) — SPF/DKIM-aligned, far more
convincing than spoofed mail, usable for targeted phishing at up to the rate
limit (60/min/IP).

Severity is Medium rather than High only because real-world impact depends on
production SMTP being configured for actual delivery (dev default is a
`localhost:1025` sink).

**Fix:** HTML-escape every user-supplied value interpolated into email HTML
(small `escapeHtml` helper, or render emails through EJS `<%= %>` like the web
views already correctly do). Optionally reject `<`/`>` in name fields at
validation time.

### 3. MEDIUM — Container runs as root

The runtime stage of the `Dockerfile` has no `USER` directive, so the web
process, the supercronic worker, and the reconciliation runner all run as
uid 0 inside the container (both `web` and `worker` processes in `fly.toml`).
Any future RCE (e.g., a dependency vulnerability) executes with root in the
container, maximizing blast radius and easing escape attempts.

**Fix:** the `node:20-alpine` base already ships a `node` user — `chown` the
app dir as needed and add `USER node` before `CMD`.

### 4. MEDIUM — CSP blocks the inline payment script (functional break with security knock-on)

`registration-form.ejs:51` ships the entire Stripe Elements confirm flow as an
**inline `<script>`**, but the CSP set globally in `src/web/app.ts:34-43` has
`scriptSrc: ["'self'", 'https://unpkg.com', 'https://js.stripe.com']` — no
`'unsafe-inline'` and no nonce. A CSP-enforcing browser will refuse to execute
the inline script, breaking the payment page entirely in production.

This is flagged in a security audit for two reasons: (a) it means the
end-to-end flow has only ever worked in environments where CSP wasn't
enforced as written, and (b) the path of least resistance at deploy time is to
add `'unsafe-inline'` to `scriptSrc`, which would gut XSS protection on the
exact page that handles card entry.

**Fix:** move the payment JS to a static file under `/public` (already
`'self'`-allowed), or use a per-request CSP nonce. Do **not** add
`'unsafe-inline'`.

### 5. LOW — Account-enumeration oracle

The forgot-password flow is carefully hardened against enumeration
(constant-time padding, uniform response — `auth.ts:199-203`), but two
endpoints undo that:

- `POST /api/check-email` (`auth.ts:155-168`, rate-limited 20/min) returns an
  explicit "Email already registered" / "Email available" answer.
- `POST /register` returns "Email is already registered" (`auth.ts:98-99`).

The register-form leak is largely inherent to public signup, but the
dedicated API oracle materially eases scripted enumeration of the user base
for credential stuffing / targeted phishing.

**Fix:** prefer the "verification email" pattern (always render "check your
email"); if the live-check UX is kept, return a generic response and/or bind
it to a per-session token.

---

## Verified non-issues (positive assurance on the payment flow)

These were specifically attacked during review and found correct:

- **Webhook spoofing/replay** — `webhook.ts:24-39`: signature verified via
  `stripe.webhooks.constructEvent`; route mounted *before* body/session/CSRF
  middleware so the raw body is intact; an unset `STRIPE_WEBHOOK_SECRET` is
  explicitly rejected (`webhook.ts:33`) rather than falling through to an
  empty (forgeable) HMAC key; Stripe's default timestamp tolerance bounds
  replay.
- **Amount/currency manipulation** — charge amounts are always read
  server-side from `events.registration_fee_cents`; currency is hardcoded;
  no client-supplied amount is trusted anywhere.
- **SQL injection** — every production query uses the `postgres`
  tagged-template (bound parameters); the JSONB `attributes` blob is
  `JSON.stringify`'d and bound; `sql.unsafe` appears only in test files;
  route UUIDs are format-validated.
- **XSS in views** — all new EJS templates use escaped `<%= %>`; the only
  raw `<%-` outputs are trusted layout includes.
- **CSRF** — per-session 32-byte token, `timingSafeEqual` comparison,
  enforced on all new state-changing routes (header for JSON, `_csrf` for
  forms); the only exemptions are the signature-verified webhook and a
  read-only endpoint.
- **Session/auth crypto (pre-existing)** — bcrypt cost 12; server-side
  sessions with HMAC-signed cookies compared timing-safely; HttpOnly +
  SameSite=Lax + Secure-in-prod; fresh session IDs on login/verify/reset
  (no fixation); reset revokes all user sessions; reset/verify tokens are
  32-byte random, stored hashed, TTL-bound, single-use; lockout after 10
  failures.
- **Refund abuse** — `RefundService` is not reachable over HTTP (cron-only).
- **Idempotency key** (`pi-create-${eventId}-${sha256(email)[:16]}`) — used
  only server-side with server-fixed amounts; not exploitable.
- **Concurrency/capacity** — slot accounting uses `FOR UPDATE` row locks in
  the stored procedures plus a DB-level partial unique index (migration 006);
  reconciliation sweeps are serialized via advisory lock with per-row
  `FOR UPDATE SKIP LOCKED` transactions.
- **Secrets hygiene** — `.env` is git- and docker-ignored; a sweep of the
  full git history found no real credentials (all `sk_*`/`whsec_*` hits are
  documentation placeholders); the committed `load_testing/.env.load-test`
  contains only dummy values; supercronic download is checksum-verified; the
  deploy workflow runs on `push` to main only with `contents: read` and a
  single `FLY_API_TOKEN` secret.

## Observations (not vulnerabilities today, but track them)

- **`is_admin` is set by the seeder but never checked anywhere** — there are
  currently no admin routes, so no privilege boundary exists to bypass; the
  moment admin functionality is added, Finding 1 becomes directly
  account-takeover-to-admin, and an `adminGuard` middleware will need to
  exist before any such route ships.
- **Guest confirmation page is a capability URL** —
  `GET /registration/:registrationId/confirmed` renders name/email/amount to
  anyone holding the 122-bit random UUID. This is the standard guest-checkout
  pattern (registrants have no account to bind to), and the global
  `secureHeaders()` sets `Referrer-Policy: no-referrer`, so leak vectors are
  limited to user self-disclosure. Assessed acceptable; documented here so
  the bearer-URL semantics are a known decision.
- **Dev fallback secrets** (`dev-secret-change-me`, `postgres://flyte:flyte@`)
  are gated for `SESSION_SECRET` in production but rely on `NODE_ENV` being
  set; the Dockerfile sets `NODE_ENV=production`, which is correct — keep it
  that way.

## Recommended pre-merge / pre-deploy actions

1. **Block on Finding 1** (seed guard + non-overwriting upsert) — small change,
   highest impact.
2. **Block on Finding 2** (escape user fields in email HTML) — small change,
   directly tied to the new PR surface.
3. **Fix Finding 4** before deploy (externalize the inline payment script);
   verify the payment page actually works with the CSP enforced.
4. Add `USER node` to the Dockerfile (Finding 3).
5. Decide on the `/api/check-email` oracle (Finding 5) — acceptable risk vs.
   UX, but make it a deliberate choice.
