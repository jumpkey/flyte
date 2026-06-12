# Flyte — UI Implementation Plan

**Suite:** UI Elaboration v1 · Document 4 of 4
**Companions:** [`SITE-MAP-AND-STORYBOARD.md`](SITE-MAP-AND-STORYBOARD.md) · [`WIREFRAMES.md`](WIREFRAMES.md) · [`WEBKIT-STANDARDS.md`](WEBKIT-STANDARDS.md)
**Status:** DRAFT — no implementation work begins until the suite is jointly reviewed and revised.

---

## 1. Approach

Same discipline that shipped the payment engine: **small increments, each
fully implemented, fully tested, and evidenced before the next begins.** Every
increment lands as its own PR against `main` with the full local gate green
(`npm test` — created in I1, since today the repo has no test script and no CI
test workflow; see §4). No increment starts until its predecessor is merged.

Cross-references used below: `D1–D4` (product decisions), `J1–J8` (journeys),
`R1–R4` (role rules), `S1–S7` (security requirements) from the site map;
`WF-01…16` (wireframes); `WK-*` (WebKit requirement IDs).

### Gate 0 — joint review (you + me, before any code)

1. Walk the four documents; resolve open questions Q1–Q6 (site map §10 —
   Q5 timezone policy and Q6 historical shadow backfill affect migration 007).
2. Confirm the framework decision in WebKit §11 (recommendation: Bootstrap 5
   themed via SCSS variables; alternatives assessed there).
3. Approve or amend the migration 007 spec — it's the hardest thing to change
   later, especially making `users.password_hash` nullable.
4. Re-scope increments if priorities differ (e.g. admin-first vs storefront-first).

**Deliverable:** this file updated with decisions; suite status flips
DRAFT → APPROVED. Nothing else.

---

## 2. Increment map

| # | Increment | Delivers | Depends on | Size |
|---|-----------|----------|------------|------|
| I1 | Foundation | Migration 007, `adminGuard`, theme build, layouts, shared partials | Gate 0 | M |
| I2 | Storefront | `/`, `/events`, `/events/:id` (WF-01..03) | I1 | M |
| I3 | Checkout & shadow accounts | Email double-entry, shadow users, confirmation upgrades, activation (WF-04, WF-05) | I1 | M |
| I4 | Admin events | CRUD, roster, lifecycle incl. cancel+bulk refund (WF-08..10) | I1 | L |
| I5 | Transactions & refunds | Transaction log, payment detail, refund execution over HTTP, **admin dashboard** (WF-07, WF-11, WF-12) | I4 | M |
| I6 | Refund requests | Customer request flow + admin queue, end to end (WF-05 §, WF-15) | I3, I5 | M |
| I7 | Account & dashboard | My Registrations, account detail, user-dashboard panel (WF-06) | I3 | S |
| I8 | Admin users & activity | User list/detail, lock/unlock, activity log (WF-13, WF-14) | I1 | M |
| I9 | Polish & compliance | WebKit audit, responsive pass, a11y pass, email restyle, WF-16 | all | M |

Storefront-revenue path is I1→I2→I3; admin-operations path is I1→I4→I5→I6.
After I1, the two paths can interleave if priorities shift.

---

## 3. Increment specifications

Format per increment: **Scope → Key files → Acceptance criteria (AC) →
Tests → Evidence.** Acceptance criteria are written to be checked off in the
PR description with evidence links, exactly like the payment-engine ledger.

### I1 — Foundation

**Scope.** Everything later increments stand on; no user-visible features.

- Migration `007_ui_elaboration.sql` exactly per site map §5 (shadow accounts,
  `user_id` on registrations/waitlist + historical email backfill,
  `events.image_url`, the `events_status_check` recreate that admits `DRAFT`,
  `refund_requests` table).
- **Test & CI plumbing** — today the repo has no `npm test` script and no CI
  test workflow (only fly-deploy). I1 adds: an `npm test` script wrapping the
  existing runner (`src/registration/testing/run-all-tests.ts`) plus the new
  web suites, and a GitHub Actions workflow running it on every PR. Without
  this, every later "gate green" claim is unenforceable.
- `adminGuard` middleware (R1/S1); wire to an empty `/admin` placeholder route.
- Theme build per WebKit §11 decision; design tokens as CSS custom properties
  (WK §2); replace Pico wiring in `layout.ejs`; **self-host HTMX and the
  framework CSS, removing `unpkg.com` and `cdn.jsdelivr.net` from the CSP**
  (WK-CODE-3).
- New `views/layouts/admin.ejs` (sidebar shell, WF-07 left rail) and updated
  public layout (auth-aware nav).
- Shared partials: status pill (WK §5 mapping — single source of truth),
  money formatter (cents → `$1,234.50`, tabular-nums), form-field macro,
  empty-state block.
- Auth-code audit for nullable `password_hash`: every `bcrypt.compare` call
  path must handle `NULL` by failing closed with the standard invalid-creds
  response (S6) — *this is the one place a foundation bug becomes a security
  bug, so it gets dedicated tests.*

**AC-I1.** ① Migration applies cleanly to a database with existing data
(testcontainers proof), backfills `user_id` for historical rows matching
existing accounts, and `npm run seed` still produces a working admin.
② `adminGuard`: anonymous → 404, active non-admin → 404, locked admin → 404,
admin → 200 (unit-tested). ③ Login with a shadow user's email + any password
returns the standard invalid-credentials response via a **dummy bcrypt
compare on the NULL `password_hash` branch** — never a thrown error or early
return (today's login has no timing padding, so the dummy compare is what
keeps shadow accounts indistinguishable from wrong passwords — S6). ④ All existing pages render under the new theme
with no functional regressions — full existing suite green. ⑤ Status-pill
partial renders every registration, event and account status with WK §5 colors,
including the derived `REFUNDED` display status (`CANCELLED` +
`refunded_amount_cents > 0` — see site map §7) — snapshot test.

**Tests.** New `admin-guard.test.ts`, `shadow-login.test.ts`, migration
applied in the CI flow; `npm test` gains the new suites.
**Evidence.** Test output, before/after screenshots of restyled existing pages.

### I2 — Storefront

**Scope.** `catalogController` + reworked home (WF-01), catalog with HTMX
filter/pagination (WF-02), public event detail with all status variants
(WF-03). Event-card partial (one component, used everywhere incl. the I4 form
preview). Image handling per D2/S5: https-only validation lives in I4's form,
but rendering + fallback card ship here; **CSP `img-src` widens to `https:`
in this increment** (documented tradeoff, S5).

**AC-I2.** ① `/` shows up to 6 soonest OPEN upcoming events; DRAFT/past
events never appear. ② Card states: available / low (<25%, amber) / sold out
(waitlist CTA) / closed (dimmed, no CTA) — all verified with seeded fixtures.
③ Broken or absent `image_url` renders the fallback card (WK §6), never a
broken-image icon. ④ Event detail reflects live `available_slots` and routes
to register/waitlist correctly in each status. ⑤ Filters and pagination work
with JS disabled (HTMX progressive enhancement — plain GET fallback).

**Tests.** HTTP tests for `/`, `/events`, `/events/:id` across event fixtures;
card-state unit tests on the view helper.
**Evidence.** Screenshots of each card state and detail variant vs WF-01..03.

### I3 — Checkout & shadow accounts

**Scope.** The D1 increment, end to end (J1, J2, J3).

- Registration + waitlist forms gain **Confirm email** (client + server
  validation, 400 `EMAIL_MISMATCH`); logged-in flow prefills/locks email and
  drops the confirm field (WF-04).
- `findOrCreateShadowUser(email)` in the user service (site-map §5 invariant 1
  — never mutates existing rows); registration/waitlist writes stamp `user_id`.
- Confirmation page upgrades (WF-05): receipt block, activation callout
  (hidden for active-account viewers), refund-request entry point (link only —
  the flow itself is I6).
- **Auth amendments for activation (J3)** — verified necessary against
  `auth.ts`: `forgotPassword` currently issues reset tokens only to verified
  users, so shadow accounts would silently get nothing. Amend issuance to
  include shadow accounts (never locked ones); `resetPassword` completion
  performs the shadow → active + verified flip. Login-page R2 hint copy;
  confirmation/receipt email gains the activation paragraph (D1 copy).
- **Duplicate-state UI** for the engine's existing constraints:
  `already_registered` (migration 006) renders a friendly "You're already
  registered" state; duplicate waitlist joins render "You're already on the
  waitlist"; event detail shows **"You're registered ✓"** to logged-in
  holders instead of the CTA.

**AC-I3.** ① Guest checkout with mismatched emails fails client-side and
server-side; with matching emails creates exactly one shadow user (repeat
purchases reuse it — proven by a double-purchase test). ② Existing active
users are never modified by guest checkout with their email, and the
registration still binds to their `user_id`. ③ Logged-in checkout never shows
the confirm field and ignores any submitted email mismatch with the session
email (session wins). ④ Forgot-password issues a reset token to a shadow account (and still
refuses locked ones); completing the reset sets password,
`account_status='active'`, `is_verified=TRUE`; the user's guest purchases are
immediately visible in I7's pages (until I7: asserted at the DB layer).
⑤ No login oracle: shadow-email login returns the identical
invalid-credentials response via the I1 dummy-compare path; forgot-password's
existing min-time padding holds for shadow issuance (S6).
⑥ Duplicate active registration, duplicate waitlist join, and the
logged-in "You're registered" event-detail state all render their friendly
states, never raw errors. ⑦ Full Stripe-CLI manual run of J1 + J3 recorded.

**Tests.** Unit (mismatch validator, find-or-create idempotency, no-mutation
invariant), HTTP (guest + logged-in checkout), manual Stripe journey.
**Evidence.** Test output + J1/J3 manual transcript, like the engine's E2E logs.

### I4 — Admin events

**Scope.** `adminEventsController` + views (WF-08..10): list, create/edit form
with live card preview and validation (capacity floor, dollars→cents, https
image URL ≤2048 — S5), event detail with stats/roster/waitlist, lifecycle
actions with server-validated transitions, **Cancel event** modal wiring the
existing bulk-refund path.

**AC-I4.** ① Full CRUD lifecycle DRAFT→OPEN→CLOSED→reopen works and is
storefront-visible appropriately at each step (DRAFT invisible — R1-adjacent
check on catalog queries); `FULL` is engine-managed (slots = 0), never an
admin action, and admin transitions respect it. ② Edit cannot reduce capacity below confirmed
count (server-enforced, inline error). ③ Cancel modal states count + total;
on Stripe-mocked partial failure the event does **not** flip to CANCELLED and
the error is surfaced (engine A6 semantics). ④ Every POST: adminGuard + CSRF
(verified by tests that assert 404 without admin and 403 without token).
⑤ Roster reflects all registration states; email links route to I8 pages
(until I8: plain text).

**Tests.** HTTP CRUD suite with admin/non-admin fixtures; transition-matrix
unit test; cancel-with-mock-failure test.
**Evidence.** Screenshots vs WF-08..10; test output.

### I5 — Transactions & refund execution

**Scope.** `adminRegistrationsController` (WF-11, WF-12): filterable
transaction log, payment-detail page with reconstructed timeline
(registration timestamps + `refund_log`), Stripe deep-link, and the **refund
modal → `POST /admin/registrations/:id/refund`** — the first HTTP exposure of
`RefundService` (S3): amount validated server-side against remaining net,
full/partial, optional reason captured (passed as the service's `reason`,
default `admin_initiated`), audit-logged, customer emailed via the existing
template. A direct refund **auto-resolves any open refund request** for the
registration (site map §4.3) so I6's queue can never go stale. Also ships the
**admin dashboard** (WF-07): KPI cards, recent transactions, recent sign-ins —
its queries are this increment's data, so it lands here (the
pending-refund-requests banner slot ships empty until I6 wires it).

**AC-I5.** ① Log shows every fixture state incl. `PAYMENT_FAILED`/`EXPIRED`;
filters compose and survive pagination (query-string state). ② Refund happy
path (Stripe CLI): money moves, `refund_log` row, timeline entry, customer
email. ③ Over-amount, zero, negative, non-CONFIRMED-status refunds rejected
server-side. ④ Stripe failure → error flash, **no** `refund_log` row, status
unchanged. ⑤ Guard tests as I4-④. ⑥ Admin dashboard renders the WF-07 KPIs
and feeds from fixtures; money figures match the transaction log's totals.

**Tests.** HTTP filter/pagination suite; refund validation unit tests; mocked
Stripe failure; one manual Stripe-CLI partial + full refund.
**Evidence.** Manual refund transcript + Stripe dashboard screenshot, per
engine precedent.

### I6 — Refund requests

**Scope.** Journey J4 end to end: `refundRequestController` (form + ack,
idempotent open-request constraint, RL(5), S2) and `adminRefundsController`
(queue WF-15, approve = `RefundService` full refund + `APPROVED` +
`resolved_by`, deny = required note + email). Wires the pending-requests
banner into the I5 admin dashboard.

**AC-I6.** ① Guest (capability URL) and logged-in user can both file exactly
one open request per registration; duplicates get the friendly "already
requested" state, not an error. ② Non-CONFIRMED registrations can't file.
③ Approve executes the refund and stamps the resolver; Stripe failure leaves
the request `REQUESTED` with an error flash (never silently resolved); approve
against an already-refunded registration resolves the request gracefully with
**no second refund** (RefundService idempotency, site map §4.3).
④ Deny requires a note; customer receives it HTML-escaped (S4 — test with a
hostile note string). ⑤ Admin notification + customer ack emails on filing.
⑥ Full J4 manual run (file → approve → money back → emails) recorded.

**Tests.** Idempotency + rate-limit HTTP tests, escaping test, mocked-failure
test, manual journey.
**Evidence.** J4 transcript; queue screenshots vs WF-15.

### I7 — Account & dashboard

**Scope.** `accountController` (WF-06): My Registrations, registration detail
(ownership-checked, R3), refund-request entry for eligible rows; dashboard
"Your upcoming events" panel.

**AC-I7.** ① Rows = registrations with the session `user_id`, including
pre-activation guest purchases (the J3 payoff — tested via the I3 fixture).
② Ownership: other users' registration IDs → 404. ③ Refund-request action
appears only for CONFIRMED rows without an open/approved request. ④ Empty
state per WF-06.

**Tests.** HTTP ownership tests, eligibility matrix unit test.
**Evidence.** Screenshot of a J3-activated account showing its guest purchase.

### I8 — Admin users & activity

**Scope.** `adminUsersController` (WF-13, WF-14): search/filter list, detail
with purchases + login history + action history, lock/unlock (modal, self-lock
forbidden, session revocation via existing `destroyUserSessions`, audit rows —
S7); `adminActivityController` global feed.

**AC-I8.** ① Search and filters compose. ② Lock: blocks login, revokes live
sessions (tested with an active session fixture), writes audit row; unlock
reverses. ③ Self-lock rejected server-side. ④ Shadow users render with the
explanatory label (WF-13 note 1). ⑤ Activity feed paginates and filters by
type/user/date.

**Tests.** HTTP suite incl. live-session revocation; self-lock unit test.
**Evidence.** Screenshots vs WF-13/14; test output.

### I9 — Polish & compliance

**Scope.** The sweep that makes it feel finished: WebKit §12 compliance
checklist executed page by page; responsive pass to WF-16 (sticky purchase
bar, 44px targets); accessibility pass (WK §8: focus rings, labels,
keyboard-only walkthrough of J1 and J5); transactional emails restyled to
WK §9; empty/error/loading states everywhere; favicon + page titles.

**AC-I9.** ① WK §12 checklist fully ticked with per-item evidence or an
agreed waiver. ② J1 completable keyboard-only and at 375px width. ③ Lighthouse
accessibility ≥ 95 on `/`, event detail, checkout step 1, admin dashboard.
④ All emails render correctly in an HTML-email test harness (table layout,
inline styles) with plain-text parts.

**Evidence.** Completed checklist, Lighthouse reports, email renders.

---

## 4. Test strategy (cumulative)

- **Gate:** `npm test` (created in I1 — it wraps the existing
  `src/registration/testing/run-all-tests.ts` runner plus the new web suites)
  is the single local gate, and I1 adds the GitHub Actions workflow that runs
  it on every PR. **Today neither exists** — the repo has no test script and
  the only workflows are fly-deploy and copilot-setup, so this plumbing is a
  hard prerequisite for every later "gate green" claim. Target: suite stays
  under ~3 min by keeping testcontainers DBs shared per-suite as today.
- **Layers:** unit (validators, guards, state transitions, eligibility
  matrices) → HTTP integration (`app.request()` against the real Hono app + test DB,
  fixture users: anon/shadow/active/admin/locked-admin) → manual Stripe-CLI
  journeys (J1, J3, J4, J5-cancel) recorded as transcripts, per the payment
  engine's evidence convention.
- **Security regression set** (runs from I1 onward): admin-route enumeration
  test that walks the Hono app's registered routes and asserts every `/admin`
  route 404s without admin (S1 — catches forgotten guards structurally, not by
  listing routes manually); CSRF assertions on every new POST; shadow-login oracle
  test; hostile-string escaping tests for any new email/view interpolation.
- **Visual:** per-increment screenshots compared against wireframes at review
  time (human judgment, not pixel-diffing).

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Nullable `password_hash` weakens auth assumptions | I1 fails-closed audit + dedicated tests before any feature code; invariant: NULL hash can never authenticate |
| Framework adoption churns every existing view | I1 lands the theme alone (no features) so regressions are isolated and the whole existing suite re-validates the rewiring |
| `RefundService` over HTTP is a new money-moving surface | Triple gate (adminGuard+CSRF+amount validation), mocked-failure tests, manual Stripe evidence — same bar as the engine |
| CSP `img-src https:` opens viewer-IP leakage to image hosts | Admin-curated URLs only (S5); documented; v2 option: image proxy |
| Scope creep across 9 increments | Site-map §9 is the parking lot; anything not in an increment spec goes there, not into the PR |

## 6. Definition of done (per increment, and overall)

An increment is done when: AC all checked with linked evidence in the PR ·
full gate green locally and in CI (gate created in I1) · security regression
set green · no raw `<%- %>` data interpolation introduced (layout plumbing
only — WK-CODE-5 / S4) · new routes present in the site-map route table
(doc updated in the same PR if reality diverged) · screenshots reviewed
against wireframes. The project is done when I9's compliance checklist is
ticked and journeys J1–J8 each have a recorded happy-path run.

## 7. Suggested order & first session

Recommended sequence: **I1 → I2 → I3 → I4 → I5 → I6 → I7 → I8 → I9** (revenue
path first; swap I4/I5 ahead of I2/I3 if admin tooling is more urgent).
First working session after Gate 0: migration 007 + the nullable-hash auth
audit, since everything else stacks on it.
