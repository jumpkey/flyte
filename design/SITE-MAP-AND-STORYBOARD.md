# Flyte — Site Map & Storyboard

**Suite:** UI Elaboration v1 · Document 1 of 5
**Companions:** [`WIREFRAMES.md`](WIREFRAMES.md) · [`WEBKIT-STANDARDS.md`](WEBKIT-STANDARDS.md) · [`UI-IMPLEMENTATION-PLAN.md`](UI-IMPLEMENTATION-PLAN.md) · [`VIEWS-AND-ANALYTICS-ADDENDUM.md`](VIEWS-AND-ANALYTICS-ADDENDUM.md)
**Status:** DRAFT for owner review — every section is intended to be revised jointly before implementation.

---

## 1. Purpose & scope

The payment engine (PR #17) shipped without a site around it: there is no way to
browse events, no admin surface to create them, no transaction visibility, no
refund workflow, and no user-facing purchase history. This document defines the
**complete page hierarchy, routes, controllers, and user journeys** that turn
the engine into a usable site, precisely enough to be implemented in one
increment with testable acceptance criteria (see `UI-IMPLEMENTATION-PLAN.md`).

**Governing product decisions** (made by the owner, 2026-06-12):

| # | Decision |
|---|----------|
| D1 | **Shadow accounts.** Guest checkout stays. Email is entered twice (must match) and creates/locates a `shadow` user row (no password, unverified). Registrations bind to that `user_id`. The confirmation email links to the purchase and notes that a password reset is only needed to *activate* a full account. |
| D2 | **Event images** are an admin-supplied URL with a styled CSS fallback card. No upload infrastructure. |
| D3 | **Visual direction:** trust-base neutrals + single vivid accent (see `WEBKIT-STANDARDS.md`). |
| D4 | **Wireframes** are SVGs embedded in `WIREFRAMES.md`. |
| D5 | **Bootstrap 5** is the framework foundation (2026-06-13): pinned npm release, themed via our SCSS override layer, self-hosted, coexisting with EJS + HTMX. Consumption spec in `WEBKIT-STANDARDS.md` §11. |
| D6 | **Sold-out states** (2026-06-13): an event is *open*, *sold out — waitlist available*, or *sold out — waitlist closed*. A per-event `waitlist_enabled` flag (admin-togglable any time) controls whether FULL shows the waitlist CTA. |

---

## 2. Roles & permission model

| Role | Definition | Can |
|---|---|---|
| **Anonymous** | No session | Browse splash/list/detail, register+pay (guest), join waitlist, view own confirmation via capability URL, request refund from confirmation page, log in / create account |
| **Shadow user** | `users.account_status = 'shadow'` — created by guest checkout; has no password, cannot log in | Everything Anonymous can. Becomes **Active** via the password-reset (activation) flow |
| **Active user** | `account_status = 'active'`, verified, has password | All of the above + dashboard, **My Registrations**, profile, refund requests bound to their account |
| **Admin** | Active user with `is_admin = TRUE` | All of the above + entire `/admin` back office |

**Rules**

- R1. Every `/admin/*` route sits behind a new `adminGuard` middleware (authGuard + `is_admin` re-checked from DB per request). Non-admins receive **404** (not 403) so the admin surface is not advertised. *This closes the forward-looking risk in audit issue #22.*
- R2. A shadow user attempting `/login` gets a distinct, non-enumerating message on the login page: "If this email has guest purchases, use *Forgot password* to activate your account." (Same message shape regardless of whether the email exists — preserves the anti-enumeration stance.)
- R3. Account-page resources (`/account/registrations/:id`) require ownership (`registration.user_id = session.userId`) — admins use the admin views instead.
- R4. Capability URLs (`/registration/:uuid/confirmed`) remain valid for guests — this is the documented bearer-URL pattern from the security audit.

---

## 3. Site hierarchy

```
flyte.fly.dev
│
├── PUBLIC (no session required)
│   ├── /                                   Splash: hero + featured event grid
│   ├── /events                             Event catalog (upcoming, filterable)
│   ├── /events/:eventId                    Event detail (image, description, price, availability)
│   ├── /events/:eventId/register           Checkout step 1+2 (exists — enhanced)
│   ├── /events/:eventId/waitlist           Waitlist form (exists — enhanced)
│   ├── /registration/:id/confirmed         Confirmation (exists — + refund request CTA)
│   ├── /registration/:id/refund-request    Refund request form + ack
│   ├── /registration/:id/calendar.ics      Add-to-calendar download (V2)
│   ├── /find-registration                  Guest "resend my links" recovery (V1)
│   ├── /waitlist/:entryId                  Live waitlist position, capability URL (V7)
│   ├── /about /contact /terms /privacy     Static pages (V6 — footer already links them)
│   ├── /login /register /verify-email      (exist)
│   └── /forgot-password /reset-password    (exist — reset doubles as shadow activation)
│
├── ACCOUNT (authGuard)
│   ├── /dashboard                          (exists — gains "Your upcoming events" panel)
│   ├── /account/registrations              My Registrations / purchase history
│   ├── /account/registrations/:id          Registration detail + receipt + refund request
│   └── /profile                            (exists)
│
└── ADMIN (adminGuard — 404 to everyone else)
    ├── /admin                              Dashboard: KPIs, needs-attention panel (A5), recent activity
    ├── /admin/analytics                    Sales & business analytics (A1/A4, WF-17)
    ├── /admin/events                       Event management list (+ pace column, A3)
    │   ├── /admin/events/new               Create event form
    │   ├── /admin/events/:id               Event detail: roster, waitlist, revenue, actions
    │   ├── /admin/events/:id/performance   Booking curve, velocity, projections (A2, WF-18)
    │   ├── /admin/events/:id/live          Drop console — PENCILLED, Document 6 (WF-19)
    │   ├── /admin/events/:id/checkin       Day-of check-in (A6 — Q8/I11)
    │   ├── /admin/events/:id/roster.csv    + waitlist.csv exports (A7)
    │   └── /admin/events/:id/edit          Edit event form
    ├── /admin/registrations                Transaction log (all registrations, filterable)
    │   ├── /admin/registrations.csv        Filtered export (A7)
    │   └── /admin/registrations/:id        Payment detail: timeline, Stripe IDs, refund action
    ├── /admin/refund-requests              Refund request queue (approve / deny)
    ├── /admin/users                        User list (search, status, lock state)
    │   └── /admin/users/:id                User detail: profile, purchases, login & action history, lock/unlock
    └── /admin/activity                     Global audit log (login_events + user_action_events)
```

---

## 4. Route → controller → view contract

New controllers live in `src/web/controllers/`, admin controllers in
`src/web/controllers/admin/`. Views in `src/web/views/` (admin views in
`views/admin/`). Verbs not listed are 404. All POSTs are CSRF-protected.
`RL(n)` = rate limit n requests / 60s / IP.

### 4.1 Public storefront

| Route | Controller.action | View | Notes |
|---|---|---|---|
| `GET /` | `homeController.index` (rework) | `home.ejs` (rework) | Hero + up to 6 `OPEN` upcoming events as cards (thumbnail → detail). Zero-events empty state. |
| `GET /events` | `catalogController.list` *(new)* | `events-list.ejs` *(new)* | All upcoming `OPEN`/`FULL`/`CLOSED` events, soonest first; availability meter; sold-out shows waitlist CTA when `waitlist_enabled`, plain "Sold out" otherwise (D6). Filter: text search, month. HTMX-paginated, 12/page. |
| `GET /events/:eventId` | `catalogController.detail` *(new)* | `event-detail.ejs` *(new)* | Public. Image (D2 fallback card), full description, date/location/price, live availability, primary CTA → `/register` (or waitlist CTA when full **and** `waitlist_enabled`; plain "Sold out" when the waitlist is closed — D6; "Registration closed" state otherwise). Logged-in users who already hold an active registration see a **"You're registered ✓"** state linking to My Registrations instead of the CTA. |
| `GET /events/:eventId/register` | `registrationController.showRegistrationForm` *(enhance)* | `registration-form.ejs` *(enhance)* | Adds **Confirm email** field (D1). If session user: email prefilled + read-only, confirm field hidden. |
| `POST /events/:eventId/register` | `registrationController.initiateRegistration` *(enhance)* | — (JSON) | Server validates `email === emailConfirm` (case-insensitive, trimmed) → 400 `email_mismatch` otherwise (matching the existing lowercase error-code convention). Find-or-create shadow user; stamp `registrations.user_id`. Logged-in: session email wins; no confirm required. The engine's existing `already_registered` outcome (one active registration per email per event — migration 006) renders a friendly "You're already registered" state, not a raw error. RL(60). |
| `POST /registration/confirm/:piId` | *(exists, unchanged)* | — | |
| `GET /registration/:id/confirmed` | `registrationController.showConfirmed` *(enhance)* | `registration-confirmed.ejs` *(enhance)* | Adds: receipt block, **Request a refund** CTA → refund-request form, and (for shadow owners) an "Activate your account" callout linking to `/forgot-password` with email query-prefill. |
| `GET /registration/:id/refund-request` | `refundRequestController.form` *(new)* | `refund-request.ejs` *(new)* | Reachable from confirmation page (capability) or My Registrations. Shows masked summary (event, date, amount). Optional reason textarea (≤500 chars). |
| `POST /registration/:id/refund-request` | `refundRequestController.create` *(new)* | redirect → `?sent=1` | Guards: registration exists & status `CONFIRMED`; no open request for it (idempotent → friendly "already requested" state). Creates `refund_requests` row (`REQUESTED`), emails admin + ack to customer. RL(5). |
| `GET/POST /events/:eventId/waitlist` | *(exist — enhance)* | `waitlist-form.ejs` | Adds confirm-email field + shadow user binding, same as registration (D1). Duplicate join (`UNIQUE (event_id, email)`) renders a friendly "You're already on the waitlist" state with the existing position. GET and POST both refuse (friendly state / 404-style) when `waitlist_enabled = FALSE` (D6) — existing entries remain admin-visible. |

### 4.2 Account

| Route | Controller.action | View | Notes |
|---|---|---|---|
| `GET /dashboard` | `dashboardController.index` *(enhance)* | `dashboard.ejs` *(enhance)* | Adds "Your upcoming events" panel (next 3 confirmed registrations) + link to My Registrations. |
| `GET /account/registrations` | `accountController.registrations` *(new)* | `account-registrations.ejs` *(new)* | All registrations where `user_id = session user` (incl. those made as shadow before activation — same row). Status pill, event, date, amount, receipt link. Empty state → browse CTA. |
| `GET /account/registrations/:id` | `accountController.registrationDetail` *(new)* | `account-registration-detail.ejs` *(new)* | Ownership-checked (R3). Receipt detail, refund state if any, refund-request CTA when eligible. |

### 4.3 Admin back office

| Route | Controller.action | View | Notes |
|---|---|---|---|
| `GET /admin` | `adminDashboardController.index` | `admin/dashboard.ejs` | KPIs: gross revenue (30d), confirmed registrations (30d), upcoming events, **pending refund requests** (alert-styled when > 0); recent transactions (10); recent signins. |
| `GET /admin/events` | `adminEventsController.list` | `admin/events-list.ejs` | All events, all statuses; columns: name, date, status pill, confirmed/capacity, available, revenue; row → detail. |
| `GET /admin/events/new` | `adminEventsController.newForm` | `admin/event-form.ejs` | Shared create/edit form: name*, date & time* (entered and displayed in the configured venue timezone — Q5), location, description (plain text/markdown-lite), capacity*, fee* (dollars input, stored as `registration_fee_cents`), image URL (https only), **waitlist toggle** (D6), status. |
| `POST /admin/events` | `adminEventsController.create` | redirect → detail | Server validation mirrors form; create defaults to status `DRAFT` (new status value — not publicly listed) unless "Open immediately". |
| `GET /admin/events/:id` | `adminEventsController.detail` | `admin/event-detail.ejs` | Header stats (capacity, confirmed, available, waitlist count, gross/net revenue); **roster table** (registrations w/ status); waitlist table; actions: Edit, Open, Close, **Cancel event** (modal: "refund all N confirmed registrations" → existing bulk-refund path). |
| `GET /admin/events/:id/edit` | `adminEventsController.editForm` | `admin/event-form.ejs` | Capacity may not be set below `confirmed_count`. |
| `POST /admin/events/:id` | `adminEventsController.update` | redirect → detail | Status transitions validated server-side: `DRAFT→OPEN→CLOSED↔OPEN`, `*→CANCELLED` only via cancel action. |
| `POST /admin/events/:id/cancel` | `adminEventsController.cancel` | redirect → detail | Confirm-modal-gated. Invokes existing `RefundService` bulk refund; event becomes `CANCELLED` only if all refunds succeed (existing A6 semantics surfaced in UI). |
| `GET /admin/registrations` | `adminRegistrationsController.list` | `admin/registrations-list.ejs` | **The transaction log.** Filters: event, status, email substring, date range. Columns: created, event, name, email, status pill, gross/net, refunded. HTMX pagination, 25/page. |
| `GET /admin/registrations/:id` | `adminRegistrationsController.detail` | `admin/registration-detail.ejs` | Full record: participant, event, **payment timeline** (initiated → authorized → captured → confirmed → refunds, from row timestamps + `refund_log`), Stripe PI id (deep-link to Stripe dashboard), refund history, linked user. Action: **Refund** (modal: full or partial $ amount ≤ remaining net). |
| `POST /admin/registrations/:id/refund` | `adminRegistrationsController.refund` | redirect → detail | First HTTP exposure of `RefundService` — adminGuard + CSRF + server-validated amount. Modal captures an optional reason (passed as `RefundService` `reason`, default `admin_initiated`). Writes `refund_log`, emails customer (existing template). **Auto-resolves any open refund request** for the registration (`APPROVED`, note "resolved by direct refund") so the queue never goes stale. |
| `GET /admin/refund-requests` | `adminRefundsController.queue` | `admin/refund-requests.ejs` | Tabs: Requested / Resolved. Row: requested at, event, customer, amount, reason. Actions inline: **Approve & refund** (modal) / **Deny** (modal w/ required note → email to customer). |
| `POST /admin/refund-requests/:id/approve` | `adminRefundsController.approve` | redirect → queue | Executes full refund via `RefundService`; request → `APPROVED`, stamped `resolved_by`. Stripe failure leaves request `REQUESTED` + error flash. If the registration was already refunded directly (`ALREADY_REFUNDED` — RefundService is idempotent), the request resolves to `APPROVED` with a note and **no money moves**. |
| `POST /admin/refund-requests/:id/deny` | `adminRefundsController.deny` | redirect → queue | Request → `DENIED` + `resolution_note`; customer notified by email (escaped). |
| `GET /admin/users` | `adminUsersController.list` | `admin/users-list.ejs` | Search email/name; filter account_status (shadow/active) & locked. Columns: email, name, status pill, locked?, registrations count, created. |
| `GET /admin/users/:id` | `adminUsersController.detail` | `admin/user-detail.ejs` | Profile card (status, verified, admin flag — read-only); **purchases table** (their registrations); waitlist entries; **login history** (`login_events`); **action history** (`user_action_events`); actions: Lock / Unlock (modal-confirmed; cannot lock self; logged to `user_action_events`). |
| `POST /admin/users/:id/lock` `…/unlock` | `adminUsersController.lock/unlock` | redirect → detail | Lock also revokes the user's sessions (reuses `destroyUserSessions`). |
| `GET /admin/activity` | `adminActivityController.list` | `admin/activity.ejs` | Unified, filterable feed over `login_events` + `user_action_events` (type, user email, date range). 50/page. |

### 4.4 Addendum routes

The views above marked `A-n`/`V-n` (analytics, exports, check-in, guest
recovery, ICS, waitlist position, static pages, social-card meta, map links)
are specified — with driving questions, content specs, projection math, and
data requirements — in
[`VIEWS-AND-ANALYTICS-ADDENDUM.md`](VIEWS-AND-ANALYTICS-ADDENDUM.md)
§3 (admin) and §4 (visitor/user). Same guards apply: every `/admin` addendum
route sits behind `adminGuard` (S1); `/find-registration` follows the
forgot-password anti-enumeration pattern.

### 4.5 New middleware & shared pieces

| Piece | Spec |
|---|---|
| `adminGuard` (`src/web/middleware/admin-guard.ts`) | Wraps authGuard logic; re-reads user; requires `is_admin AND NOT is_locked`; renders the site 404 page otherwise. Unit-tested (active user → 404, admin → pass, locked admin → 404). |
| Admin layout (`views/layouts/admin.ejs`) | Sidebar navigation (Dashboard, Events, Transactions, Refund requests, Users, Activity), page header slot, flash messages. Public layout keeps top nav, gains auth-aware right side (Login / account menu). |
| Status pill partial | Single EJS partial mapping every registration/event/user status to the WebKit token colors — one source of truth. |
| Money helper | All currency rendered via one helper (cents → `$1,234.50`, `tabular-nums`). |

---

## 5. Data model delta (Migration `007_ui_elaboration.sql` — spec)

Implemented exactly once, additive, in the implementation increment:

```sql
-- D1: shadow accounts
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN account_status TEXT NOT NULL DEFAULT 'active'
  CHECK (account_status IN ('shadow', 'active'));
-- Shadow rows: password_hash IS NULL AND account_status = 'shadow'

-- Bind purchases to users (nullable for pre-existing rows)
ALTER TABLE registrations    ADD COLUMN user_id UUID REFERENCES users(id);
ALTER TABLE waitlist_entries ADD COLUMN user_id UUID REFERENCES users(id);
CREATE INDEX idx_registrations_user ON registrations(user_id);

-- Backfill: bind historical purchases to accounts that already exist
-- (whether to ALSO create shadow rows for unmatched historical guest
--  emails is open question Q6)
UPDATE registrations r SET user_id = u.id
  FROM users u WHERE r.user_id IS NULL AND LOWER(r.email) = LOWER(u.email);
UPDATE waitlist_entries w SET user_id = u.id
  FROM users u WHERE w.user_id IS NULL AND LOWER(w.email) = LOWER(u.email);

-- D2 + storefront content
ALTER TABLE events ADD COLUMN image_url TEXT;          -- https URL or NULL
ALTER TABLE events ADD COLUMN waitlist_enabled BOOLEAN NOT NULL DEFAULT TRUE;  -- D6

-- Event lifecycle gains DRAFT (publicly invisible). The status CHECK is an
-- inline constraint in 005, so it must be dropped and recreated:
ALTER TABLE events DROP CONSTRAINT events_status_check;
ALTER TABLE events ADD CONSTRAINT events_status_check
  CHECK (status IN ('DRAFT', 'OPEN', 'FULL', 'CLOSED', 'CANCELLED'));
-- Engine-managed 'FULL' (auto when available_slots = 0) is untouched;
-- the storefront renders it as "Sold out" + waitlist CTA.

-- Refund request workflow
CREATE TABLE refund_requests (
  request_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id UUID NOT NULL REFERENCES registrations(registration_id),
  user_id         UUID REFERENCES users(id),
  reason          TEXT,
  status          TEXT NOT NULL DEFAULT 'REQUESTED'
                  CHECK (status IN ('REQUESTED','APPROVED','DENIED')),
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID REFERENCES users(id),
  resolution_note TEXT
);
CREATE UNIQUE INDEX idx_refund_requests_open
  ON refund_requests(registration_id) WHERE status = 'REQUESTED';

-- Analytics & operations structural columns (Document 5 §5):
ALTER TABLE events ADD COLUMN opened_at TIMESTAMPTZ;        -- set on first DRAFT→OPEN
UPDATE events SET opened_at = created_at WHERE status <> 'DRAFT';
ALTER TABLE registrations ADD COLUMN checked_in_at TIMESTAMPTZ;  -- A6 check-in (Q8)
-- plus the optional page_views counter table if Q7 is accepted (Document 5 §5)
```

**Shadow lifecycle invariants**

1. Guest checkout normalizes the email to lowercase at write time, then:
   `INSERT INTO users (email, display_name, account_status, is_verified, password_hash)
   VALUES ($lower_email, $first_last_from_checkout, 'shadow', FALSE, NULL)
   ON CONFLICT ((LOWER(email))) DO NOTHING`, then select. `display_name` is
   NOT NULL in the schema, so it MUST be supplied — built from the checkout
   first/last name, **set on create only**. The flow never modifies an
   existing row: active users keep their state; repeat guests reuse their
   shadow row even if they typed a different name. (Note the double parens —
   the unique index `users_email_lower_idx` is an expression index, and
   Postgres conflict targets on expressions require their own parentheses.)
2. `/login` with a shadow email behaves exactly like a wrong password (no
   oracle), and the login page persistently shows the R2 hint copy.
   Implementation note: shadow rows have `password_hash = NULL`, and today's
   login path has no timing padding and would short-circuit (or throw) on a
   NULL hash — the NULL branch MUST run a dummy bcrypt compare so shadow
   emails stay indistinguishable from wrong passwords. Covered by the I1
   fail-closed audit.
3. Password reset against a shadow user sets `password_hash`,
   `account_status='active'`, `is_verified=TRUE` (the emailed link proves
   mailbox control). This is the activation flow, **but it requires two
   amendments to existing auth code** (verified against `auth.ts`):
   `forgotPassword` currently issues tokens only when `user.isVerified` — it
   must also issue them to shadow accounts (still never to locked ones); and
   `resetPassword` completion must perform the shadow→active+verified flip.
   `resetPassword` itself is token-gated only, so nothing else changes. The
   forgot-password flow's existing min-time padding keeps issuance
   enumeration-safe.
4. `npm run seed` admin is always `active`. Shadow users are never admins.

---

## 6. Storyboards (user journeys)

Wireframe references `[WF-nn]` point into `WIREFRAMES.md`.

### J1 — Guest discovers and buys (the core commerce loop)
1. Lands on `/` **[WF-01]** → scans hero + event cards (image, date badge, price, availability).
2. Clicks a card → `/events/:id` **[WF-03]**: full pitch, availability meter, vivid **Register — $25.00** CTA. *(No login wall — D1.)*
3. CTA → `/events/:id/register` **[WF-04]** step 1: first/last name, **email, confirm email**, phone. Mismatched emails error inline before any network call; server re-checks.
4. Continue → step 2: Stripe Payment Element. Pays.
5. → `/registration/:id/confirmed` **[WF-05]**: receipt, status pill, **Request a refund** link, and the *"Want an account?"* activation callout.
6. Email arrives: receipt + capability link + activation note (D1 copy: "You don't need an account. If you'd like one, set a password and your purchases come with you.").
7. **System effects:** shadow user created/reused; registration carries `user_id`; admin sees the transaction in `/admin/registrations` immediately.

### J2 — Logged-in user buys
Same as J1 from any entry point, except: checkout email is prefilled & read-only, no confirm field; confirmation page CTA is **View in My Registrations**; purchase appears in `/account/registrations` **[WF-06]**.

### J3 — Shadow → Active (account activation)
1. Guest opens confirmation email → clicks "Activate your account" → `/forgot-password` (email prefilled).
2. Standard reset email (issuance amended for shadow accounts — §5 invariant 3) → `/reset-password?token=…` → sets password.
3. Row flips to `active`+verified; redirected to `/dashboard`; **My Registrations already contains the guest purchase** (same `user_id`). *This is the wow-moment the shadow model buys us.*

### J4 — Refund, end to end
1. Customer (guest via confirmation page, or user via My Registrations) → **Request a refund** → `/registration/:id/refund-request` **[WF-05]**: summary + optional reason → submit → ack state + ack email. Duplicate submission shows "already requested".
2. Admin: `/admin` dashboard shows **Pending refund requests: 1** alert → `/admin/refund-requests` **[WF-15]**.
3. **Approve & refund** modal (event, customer, amount) → confirm → `RefundService` executes → request `APPROVED`, registration shows refund in `refund_log`, customer gets the existing refund-confirmation email. Failure path: Stripe error keeps the request open with an error flash — *never* marks refunded without a successful Stripe refund (A6 discipline).
4. Deny path: required note → `DENIED` → courteous email with the note (escaped).
5. **Evidence trail:** request row (who/when/why), `resolved_by`, `refund_log`, Stripe dashboard cross-link.

### J5 — Admin creates and runs an event
1. `/admin/events` **[WF-08]** → **New event** → form **[WF-09]**: details, capacity, fee in dollars, image URL (preview with fallback card), save as `DRAFT`.
2. Verifies the detail page **[WF-10]**, then **Open** — event now appears on `/` and `/events`.
3. During sales: roster fills live; availability meter on the storefront tracks `available_slots`.
4. Closes registrations (`CLOSED`: visible, not purchasable) or **Cancels** (modal: "N confirmed registrations will be refunded ($X total)") → bulk refund → status flips only on full success.

### J6 — Admin investigates a customer
1. `/admin/users` **[WF-13]** search by email → user detail **[WF-14]**.
2. Reviews purchases, login history, action history in one place.
3. Suspicious activity → **Lock account** (modal) → sessions revoked, login blocked; unlock reverses. Both actions audit-logged.

### J7 — Sold out → waitlist
1. Event detail shows **Sold out** + waitlist CTA — only while the admin has the waitlist enabled (D6); with the waitlist closed it's a plain "Sold out". `/events/:id/waitlist` mirrors checkout step 1 (email×2, shadow binding).
2. Acknowledgement page + email with position. Admin sees the waitlist on the event detail page. *(v1 stops here: no automated promotion — admin contacts waitlisted users manually; automation is a listed v2 item.)*

### J8 — Payment failure / expiry (existing engine, now visible)
Failed capture → customer sees the existing failure page; admin sees `PAYMENT_FAILED` in the transaction log with the timeline explaining what happened; reconciliation sweeps remain the recovery mechanism.

---

## 7. State machines (UI-relevant)

```
EVENT:        DRAFT ──open──▶ OPEN ◀──auto──▶ FULL        (FULL is engine-managed:
                │              │    (slots=0)   │           slots hit 0 / free up)
                │              ├──close──▶ CLOSED ──reopen──▶ OPEN
                └──────cancel──┴──────────▶ CANCELLED      (cancel = modal + bulk refund)

ACCOUNT:      (guest checkout) ─▶ shadow ──password reset──▶ active ◀── /register signup
                                            (is_locked is orthogonal: admin lock/unlock)

REFUND REQ:   REQUESTED ──approve+Stripe OK──▶ APPROVED
                  │  └──deny+note──▶ DENIED
                  └── (Stripe failure: stays REQUESTED, error surfaced)
```

Registration payment states are unchanged from the engine
(`PENDING_PAYMENT → PENDING_CAPTURE → CONFIRMED / PAYMENT_FAILED / EXPIRED / CANCELLED`).
There is **no** `REFUNDED` status in the schema: a full refund sets `CANCELLED` and
records `refunded_amount_cents`; a partial refund leaves `CONFIRMED`. The UI therefore
renders a **derived display status** — `CANCELLED` + `refunded_amount_cents > 0` shows
as a `REFUNDED` pill — via the single status-pill partial (§4.4), so the distinction
lives in exactly one place. Token mapping in `WEBKIT-STANDARDS.md` §5.

---

## 8. Security requirements carried into this work

| ID | Requirement |
|---|---|
| S1 | `adminGuard` on every `/admin` route; 404 to non-admins; covered by tests. (Closes the `is_admin`-unenforced gap — audit issue #22.) |
| S2 | All new POSTs: CSRF + rate limits as tabled in §4 (`RL(n)` = n per 60s per IP, the existing middleware's semantics). Refund-request endpoint: RL(5) — the real duplicate guard is the partial unique index (one open request per registration), not the rate limit. |
| S3 | Refund execution: server validates amount ≤ remaining net; full audit trail; only ever via adminGuard routes or existing internal paths. |
| S4 | All user-originated strings in emails go through the existing `escapeHtml`; all views stay on `<%= %>`. |
| S5 | `image_url`: server-side validation `https://` only, ≤ 2048 chars; rendered exclusively as `<img src>` (escaped); **CSP change**: `img-src` gains `https:` (documented tradeoff: remote images may leak viewer IPs to the image host — acceptable for admin-curated URLs). |
| S6 | Shadow flow must not create a login oracle (R2 copy identical for all inputs) and must never downgrade or modify an existing `active` user. |
| S7 | Admin lock action cannot target self; lock revokes sessions. |

---

## 9. Explicitly out of scope (v1) — parked for v2

- Automated waitlist promotion (offer emails with hold windows)
- Email change on profile (auth-sensitive; needs a re-verification flow)
- Event-update notification emails ("time/location changed")
- Day-of check-in view (A6 — Q8 moved it over-horizon; `checked_in_at` column ships in 007 regardless)
- QR codes on confirmations + scan-based check-in (builds on A6)
- Forensic traffic-capture consideration (Document 6 §8 T-7 — no purpose-built UI)
- Curve-shape priors for booking projections, fitted from our own completed
  events (v1 is the deliberately linear model in Document 5 §3.1)
- Generated Open Graph fallback images (v1 uses a static brand card)
- Email preference center / newsletter & blog mailing management (noted in D1 as the future driver for account activation)
- Event image uploads (D2 keeps URLs), event categories/tags, recurring events
- Customer-visible partial refunds (admin can issue them; customers just see the result)
- Dark mode (token architecture reserves space — see WebKit doc)
- Multi-admin roles/permissions tiers; admin MFA *(recommended before more admins are added)*
- Public REST/JSON API

---

## 10. Open questions — **resolved by the owner, 2026-06-13**

| # | Question | Resolution |
|---|---|---|
| Q1 | `CLOSED` events visible on the storefront? | ✅ Default — remain visible (greyed, "registration closed") |
| Q2 | Refund-request reason required? | ✅ Default — optional, ≤500 chars |
| Q3 | Dashboard KPI window | ✅ Default — 30 days with all-time secondary |
| Q4 | Activation callout on waitlist ack? | ✅ Default — yes |
| Q5 | Event timezone policy | ✅ Default — venue timezone via `EVENT_TIMEZONE`, labelled |
| Q6 | Historical shadow backfill | **Moot** — the site has never been live, so there are no historical guest registrations. The backfill `UPDATE`s in §5 stay as no-op safety (they only matter for test data). |
| Q7 | First-party page-view counters | ✅ Yes — anonymous aggregate counts only. A *forensic-grade* capture question (richer traffic data, retention, query tooling — no purpose-built UI) is parked as Document 6 §8 T-7. |
| Q8 | Day-of check-in in v1? | **Over-horizon TBD** — A6/I11 move out of v1 alongside Document 6. The `checked_in_at` column stays in migration 007 (one line now; unbackfillable after real events have run). |

Owner also confirmed at the same time: framework = **Bootstrap 5** (D5,
consumption spec in `WEBKIT-STANDARDS.md` §11) and the D6 sold-out/waitlist
states. Remaining before implementation: the owner's deep read of the suite.
