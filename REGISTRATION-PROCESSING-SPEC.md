# REGISTRATION-PROCESSING-SPEC.md

**Project:** Mahjong Tournament Registration System
**Document Role:** Authoritative specification for an AI coding agent to implement the
registration service layer, backing store schema, and test harness.
**Status:** Complete — ready for agent implementation
**Last Updated:** 2025-05 (rev 2 — manual capture flow, PENDING_CAPTURE state, Fly.io scheduler)

---

## Table of Contents

1. [Project Context](#1-project-context)
2. [Architectural Decisions & Rationale](#2-architectural-decisions--rationale)
3. [Foundational Design Decisions](#3-foundational-design-decisions)
4. [Database Schema](#4-database-schema)
5. [Stored Procedures](#5-stored-procedures)
6. [Shared TypeScript Types](#6-shared-typescript-types)
7. [Service Interfaces](#7-service-interfaces)
8. [Invariants the Implementation Must Enforce](#8-invariants-the-implementation-must-enforce)
9. [Notification Interface](#9-notification-interface)
10. [Scheduled Reconciliation — Fly.io Deployment](#10-scheduled-reconciliation--flyio-deployment)
11. [Registration Form Page Requirements](#11-registration-form-page-requirements)
12. [Implementation Sequence & Testable Increments](#12-implementation-sequence--testable-increments)
13. [Test Harness & Stripe Mocking](#13-test-harness--stripe-mocking)
14. [Out of Scope](#14-out-of-scope)
15. [Glossary](#15-glossary)

---

## 1. Project Context

### 1.1 What This System Does

This system manages registrations for capacity-limited events (mahjong tournaments). It:

- Accepts a registration form submission with participant attributes
- Collects payment via Stripe's embedded Payment Element (white-label, hosted in the
  site's UI) using **authorization-only (manual capture)** — funds are reserved but not
  moved until a registration slot is confirmed
- Enforces a hard capacity limit — the event cannot be oversold under any circumstance
- If no slot is available at authorization time, the authorization hold is released
  immediately — **no charge ever occurs for a failed registration**
- Degrades gracefully to waitlist enrollment when capacity is exhausted
- Sends a confirmation email for every successfully paid and confirmed registration
- Supports individual and bulk cancellations with Stripe refunds

### 1.2 Existing Platform

The agent is extending an existing TypeScript web application with the following
characteristics:

- **Framework:** Hono (TypeScript, server-side MVC)
- **Service Layer:** TypeScript interfaces backed by classes that execute SQL directly
  against PostgreSQL using short-lived connections (no ORM, no connection pool held open
  across requests)
- **Session:** Used for logging/behavior tracking only. No application state is stored
  in the session.
- **Existing features:** Account creation (optional), user profile, password change,
  email validation. These are tested and stable.
- **Database:** PostgreSQL (version compatible with `FOR UPDATE SKIP LOCKED` and
  `FOR UPDATE` row-level locking)
- **Coding style:** Interface-first. All services are defined as TypeScript interfaces;
  the agent implements the backing classes. Controllers call service interfaces only —
  never SQL directly.
- **Deployment platform:** Fly.io (see §10 for scheduled job implementation)

### 1.3 Stripe Integration Model — Manual Capture

This system uses Stripe's **manual capture** flow. This is a deliberate design choice
that eliminates charge-then-refund scenarios entirely.

**How manual capture works:**
- A PaymentIntent created with `capture_method: 'manual'` separates authorization
  from capture into two distinct Stripe operations.
- **Authorization:** Stripe contacts the card network, verifies the card, and places
  a hold on the customer's funds. No money moves. The card shows a pending charge.
  The PaymentIntent enters `requires_capture` status.
- **Capture:** The server calls `stripe.paymentIntents.capture(piId)`. Funds move.
  The charge is complete. The PaymentIntent enters `succeeded` status.
- **Cancel (release):** The server calls `stripe.paymentIntents.cancel(piId)`.
  The authorization hold is released. No funds ever move. The hold disappears from
  the customer's statement (timing depends on their bank; typically hours to a few
  business days).
- **Authorization hold window:** 7 days maximum. This is a card network limit, not
  Stripe's. If the PaymentIntent is not captured or cancelled within 7 days, the
  authorization expires automatically. The reconciliation job (§10) ensures this
  never happens in practice.

**Why manual capture:**
- A failed registration (event full) releases the hold — **the customer is never charged**
- No refund latency (5–10 business days) for failed registrations
- No Stripe processing fee for uncaptured authorizations
- Cleaner user experience: hold appears → slot acquired → charge finalizes, or
  hold appears → slot unavailable → hold disappears

**3DS compatibility:**
3DS challenges work identically with manual capture. The challenge occurs during
the browser-side Stripe.js confirmation step. The `requires_capture` status is
reached after 3DS completes successfully. No server-side changes are needed for 3DS.

**Relevant Stripe webhook events:**
- `payment_intent.amount_capturable_updated` — authorization succeeded; PaymentIntent
  is now in `requires_capture` status; slot acquisition and capture should proceed
- `payment_intent.payment_failed` — card was declined at authorization; no hold placed
- `payment_intent.succeeded` — capture completed (informational; primary logic driven
  by `amount_capturable_updated`)
- `payment_intent.canceled` — PaymentIntent was cancelled (hold released)

### 1.4 Relationship to User Accounts

- User accounts are **optional**. A registrant does not need an account to register.
- The registration record links to a user by **email address only** — there is no
  foreign key to the users/accounts table.
- Waitlist entries likewise link by email only.
- User profile data (collected outside the registration event) is out of scope.

---

## 2. Architectural Decisions & Rationale

These decisions were made explicitly and must not be reversed by the agent without
flagging a conflict.

| Decision | Rationale |
|---|---|
| Stripe manual capture (`capture_method: 'manual'`) | Eliminates charge-then-refund for failed registrations; no money moves for unsuccessful outcomes; no Stripe fee on the failed path |
| Slot acquisition happens between authorization and capture | The slot is decremented only after a valid card authorization is confirmed; capture finalizes the charge only after the slot is secured |
| `PENDING_CAPTURE` intermediate status | Bridges the gap between slot decrement and successful Stripe capture; allows the reconciliation job to retry captures and recover from transient Stripe failures without losing the slot |
| Row-level lock (`SELECT ... FOR UPDATE`) on the event row during slot acquisition | Serializes concurrent slot acquisitions; prevents overselling without application-level queuing |
| `paymentIntentId` as idempotency key for all state transitions | Stripe can deliver webhooks more than once; client can POST confirm more than once; both must be no-ops after first processing |
| Client-side Stripe.js confirmation fires a server POST in parallel with the webhook | Reduces confirmation latency for the user; the race is safe because both paths go through the same idempotent locked service method |
| Server verifies PaymentIntent status via Stripe API on the client POST path | Client assertion of authorization success is not trusted; prevents a malicious client POST from acquiring a slot without a real card authorization |
| Asynchronous email confirmation (post-commit, not in-transaction) | Email delivery failure must not roll back a confirmed registration |
| `confirmationEmailSentAt` on the registration record | Allows the reconciliation job to detect and re-trigger missed emails |
| Stored procedures for multi-step transactional operations | Keeps complex locking and multi-table mutation sequences inside the database, reducing round-trips and ensuring atomicity |
| Reconciliation job as a separate Fly.io Machine process group (supercronic) | Clean separation of concerns; does not consume web server resources; runs independently of web server lifecycle |
| Partial bulk refunds not supported | An event cancellation justifies only full refunds |
| `grossAmountCents` is server-authoritative | The charge amount comes from the event configuration record, never from the client form submission |

---

## 3. Foundational Design Decisions

### 3.1 Availability Locking Strategy

The `events` table carries an `available_slots` counter and a `confirmed_count` counter.
All mutations to these columns go through stored procedures that acquire a
`SELECT ... FOR UPDATE` row-level lock on the event row. This lock is held only for
the duration of the stored procedure execution — it is **not** held across any Stripe
API call or the browser payment session.

The lock serializes concurrent slot acquisitions for the same event at the database
level. Under normal load for a mahjong tournament (tens to low hundreds of registrants),
this is entirely acceptable.

### 3.2 Three-Phase Payment & Registration Flow

```
PHASE 1 — Form Submission (appserver)
══════════════════════════════════════════════════════════════════
[Client POSTs registration form]
        ↓
[Service: validate event; validate grossAmountCents matches event record]
[Service: call Stripe API → create PaymentIntent
          with capture_method: 'manual'  (timeout: STRIPE_API_TIMEOUT_MS)]
        ↓
[Service: call sp_initiate_registration()]
[Service: store paymentIntentId on registration record → status: PENDING_PAYMENT]
        ↓
[Return stripeClientSecret to browser]

No availability decrement occurs in Phase 1.
No lock held. No Stripe charge or authorization hold placed yet.

PHASE 2 — Card Authorization (browser ↔ Stripe, server not involved)
══════════════════════════════════════════════════════════════════
[Browser mounts Stripe Payment Element using clientSecret]
[User enters card details, clicks Pay]
[Stripe.js calls stripe.confirmPayment()]
[Stripe performs 3DS challenge if required — entirely in browser]
        ↓
  On success: PaymentIntent status → 'requires_capture'
              Stripe fires: payment_intent.amount_capturable_updated (webhook)
              Stripe.js resolves on client
  On failure: PaymentIntent status → terminal failure state
              Stripe fires: payment_intent.payment_failed (webhook)
              Stripe.js displays inline decline message; user can retry

PHASE 3 — Slot Acquisition & Capture (two parallel paths)
══════════════════════════════════════════════════════════════════

Path A — Stripe Webhook (server-to-server, Stripe-signed)
  [Stripe fires payment_intent.amount_capturable_updated]
          ↓
  [Webhook controller verifies HMAC signature]
          ↓
  [Service: handleAuthorizationWebhook(paymentIntentId, payload)]
          ↓
  [Delegates to: handlePaymentAuthorized(paymentIntentId, grossAmountCents)]

Path B — Client POST (browser → appserver, after Stripe.js confirms)
  [Stripe.js resolves: authorization confirmed (requires_capture)]
          ↓
  [Browser POSTs to /registration/confirm/:paymentIntentId]
          ↓
  [Service: confirmRegistrationFromClient(paymentIntentId)]
  [Service: calls stripe.paymentIntents.retrieve() — verifies status = 'requires_capture']
          ↓
  [Delegates to: handlePaymentAuthorized(paymentIntentId, grossAmountCents)]

BOTH PATHS execute the same logic inside handlePaymentAuthorized():
  ┌─────────────────────────────────────────────────────────────┐
  │  Call sp_acquire_slot_and_stage_capture(paymentIntentId)    │
  │  (acquires row lock on event; checks & decrements           │
  │   available_slots; sets registration → PENDING_CAPTURE)     │
  │                                                             │
  │  On SLOT_ACQUIRED:                                          │
  │    Call stripe.paymentIntents.capture(piId)                 │
  │    On capture SUCCESS:                                      │
  │      Call sp_finalize_registration(piId, netAmountCents)    │
  │      → status: CONFIRMED                                    │
  │      Post-commit: send confirmation email                   │
  │    On capture TRANSIENT FAILURE:                            │
  │      Call sp_increment_capture_attempt()                    │
  │      Leave status as PENDING_CAPTURE                        │
  │      Reconciliation job will retry capture                  │
  │    On capture PERMANENT FAILURE:                            │
  │      Call sp_restore_slot_on_capture_failure(piId)          │
  │      → status: PAYMENT_FAILED; slot restored                │
  │                                                             │
  │  On AVAILABILITY_EXHAUSTED:                                 │
  │    Call stripe.paymentIntents.cancel(piId)                  │
  │    → authorization hold released; no charge; no refund      │
  │    → status: PAYMENT_FAILED                                 │
  │                                                             │
  │  On IDEMPOTENT_REPLAY (already PENDING_CAPTURE/CONFIRMED):  │
  │    Return immediately; no side effects                      │
  └─────────────────────────────────────────────────────────────┘

Whichever path arrives first acquires the DB lock and proceeds.
The second arrival finds status = PENDING_CAPTURE or CONFIRMED
and returns IDEMPOTENT_REPLAY.

POST-COMMIT (on the non-idempotent CONFIRMED path only)
  [Service: INotificationService.sendRegistrationConfirmation()]
  [Service: sp_mark_confirmation_email_sent()]
```

### 3.3 The `PENDING_CAPTURE` State

`PENDING_CAPTURE` is a transitional status that bridges the slot decrement (inside a
database transaction) and the Stripe capture call (an external API call). These two
operations cannot be made fully atomic with each other, so a detectable intermediate
state is required.

**Why this state is necessary:**
If the appserver crashes, loses network connectivity to Stripe, or Stripe returns a
transient error after the slot has been decremented but before capture succeeds, the
system must be able to detect and recover this condition. Without `PENDING_CAPTURE`,
this window would be invisible. With it, the reconciliation job finds these records
and retries the capture.

**Full lifecycle of `PENDING_CAPTURE`:**
```
sp_acquire_slot_and_stage_capture() succeeds
  → slot decremented; status = PENDING_CAPTURE

stripe.paymentIntents.capture() succeeds immediately (normal path)
  → sp_finalize_registration() → status = CONFIRMED

stripe.paymentIntents.capture() fails transiently (network error, 5xx, rate limit)
  → sp_increment_capture_attempt() called
  → status remains PENDING_CAPTURE
  → reconciliation job retries capture with exponential backoff

stripe.paymentIntents.capture() fails permanently (card_declined, expired_card, etc.)
  → sp_restore_slot_on_capture_failure() → slot restored; status = PAYMENT_FAILED

PENDING_CAPTURE registration approaches 7-day authorization window (> 6 days old)
  → reconciliation job escalates: calls sp_restore_slot_on_capture_failure()
    regardless of retry count (authorization is about to expire anyway)
  → status = PAYMENT_FAILED (or EXPIRED if treated as abandoned)
```

**Capture retry strategy (reconciliation job):**
Retries are attempted up to `CAPTURE_MAX_RETRIES` times (default: 5, configurable via
env var). Exponential backoff is applied: only retry if
`last_capture_attempt_at < now() - interval '(2^attempt_count) minutes'`.
After max retries, or on any permanent Stripe error, `sp_restore_slot_on_capture_failure()`
is called.

**Distinguishing transient vs permanent Stripe errors:**
Inspect the Stripe error object's `type` and `code` fields:
- **Transient (retry):** `type: 'api_error'`, `code: 'api_connection_error'`, HTTP 5xx,
  `code: 'rate_limit'`
- **Permanent (give up):** `type: 'card_error'` with any decline code (`card_declined`,
  `expired_card`, `insufficient_funds`, `do_not_honor`, `fraudulent`, etc.), HTTP 4xx
  with a Stripe decline code

Reference: https://stripe.com/docs/declines/codes

### 3.4 Timeout & Hung Payment Recovery

**PaymentIntent creation timeout (Phase 1):**
The Stripe API call to create the PaymentIntent has a configurable timeout (default: 10s,
`STRIPE_API_TIMEOUT_MS`). If this times out:
- No DB record is created (PI creation precedes DB insert; see §7.2 note on ordering)
- Returns `STRIPE_TIMEOUT` to the controller
- User sees: "Something went wrong setting up your payment. You have not been charged.
  Please try again."

**Orphaned PENDING_PAYMENT registrations:**
Registrations stuck in `PENDING_PAYMENT` longer than `REGISTRATION_TTL_MINUTES`
(default: 30) indicate abandoned payment flows. The reconciliation job cancels the
PaymentIntent via Stripe and marks the registration `EXPIRED`. No slot was ever
decremented for these records.

**Orphaned PENDING_CAPTURE registrations:**
Handled by the capture retry logic described in §3.3.

**Authorization expiry safety net:**
The reconciliation job checks for `PENDING_CAPTURE` or `PENDING_PAYMENT` registrations
older than 6 days and escalates handling to prevent silent 7-day authorization expiry.

**Missed confirmation emails:**
The reconciliation job scans for `CONFIRMED` registrations with
`confirmation_email_sent_at IS NULL` and re-triggers notification.

### 3.5 Cancellation & Refund Model

Once a registration is `CONFIRMED` (capture has succeeded and funds have moved),
cancellation requires a Stripe **refund**. This is the only scenario where a Stripe
refund is issued. Authorization releases (AVAILABILITY_EXHAUSTED path, §3.2) are
**not refunds** — no funds moved.

| Case | Trigger | Stripe Operation | Availability |
|---|---|---|---|
| Full individual cancellation | Registrant or admin cancels | Full refund via Refund API | +1 restored |
| Partial individual refund | Admin issues partial refund | Partial refund via Refund API | No change — slot retained |
| Full bulk (event cancelled) | Admin cancels entire event | Full refund on all CONFIRMED | N/A — event marked CANCELLED |
| Partial bulk | **Not in scope** | — | — |

**Stripe fee shortfall on refunds:**
Stripe does not return its processing fee on refunded charges. A $100.00 charge nets
approximately $97.00 after fees; a $100.00 refund costs the full $100.00. The
registration record stores both `gross_amount_cents` and `net_amount_cents` so the
back-office can calculate fee shortfall. This service does not provision Stripe balance.

---

## 4. Database Schema

File: `migrations/001_registration_schema.sql`
Migration must be idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).

### 4.1 `events` table

```sql
CREATE TABLE IF NOT EXISTS events (
    event_id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name                    TEXT        NOT NULL,
    description             TEXT,
    event_date              TIMESTAMPTZ NOT NULL,
    location                TEXT,
    total_capacity          INTEGER     NOT NULL CHECK (total_capacity > 0),
    confirmed_count         INTEGER     NOT NULL DEFAULT 0 CHECK (confirmed_count >= 0),
    available_slots         INTEGER     NOT NULL CHECK (available_slots >= 0),
    -- Price in cents (e.g. 10000 = $100.00). Server-authoritative — never set by client.
    registration_fee_cents  INTEGER     NOT NULL CHECK (registration_fee_cents >= 0),
    status                  TEXT        NOT NULL DEFAULT 'OPEN'
                                CHECK (status IN ('OPEN', 'FULL', 'CANCELLED', 'CLOSED')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Hard invariant: available_slots + confirmed_count must always equal total_capacity.
    -- Any stored procedure that violates this will fail with a constraint error.
    -- This constraint is the safety net, not the primary mechanism.
    CONSTRAINT capacity_invariant
        CHECK (available_slots + confirmed_count = total_capacity)
);

CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
```

> **Agent note:** `available_slots` must be initialized to `total_capacity` when an
> event record is created. Enforce this in the event-creation code path.

### 4.2 `registrations` table

```sql
CREATE TABLE IF NOT EXISTS registrations (
    registration_id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id                    UUID        NOT NULL REFERENCES events(event_id),
    email                       TEXT        NOT NULL,
    first_name                  TEXT        NOT NULL,
    last_name                   TEXT        NOT NULL,
    phone                       TEXT,
    -- Arbitrary JSON bag for event-specific form fields (skill level, dietary, etc.)
    -- Schema defined in REGISTRATION-FORM-FIELDS.md
    attributes                  JSONB       NOT NULL DEFAULT '{}',

    -- ── Status ───────────────────────────────────────────────────────────────
    -- Valid transitions (see §3.2 and type definitions in §6):
    --   PENDING_PAYMENT  → PENDING_CAPTURE  (authorization succeeded; slot acquired)
    --   PENDING_PAYMENT  → PAYMENT_FAILED   (card declined at authorization)
    --   PENDING_PAYMENT  → EXPIRED          (TTL exceeded; PI cancelled by reconciliation)
    --   PENDING_CAPTURE  → CONFIRMED        (capture succeeded)
    --   PENDING_CAPTURE  → PAYMENT_FAILED   (capture permanently failed; slot restored)
    --   PENDING_CAPTURE  → EXPIRED          (approaching 7-day auth window)
    --   CONFIRMED        → CANCELLED        (full cancellation with refund)
    --   PAYMENT_FAILED   → (terminal)
    --   EXPIRED          → (terminal)
    status                      TEXT        NOT NULL DEFAULT 'PENDING_PAYMENT'
                                    CHECK (status IN (
                                        'PENDING_PAYMENT',
                                        'PENDING_CAPTURE',
                                        'CONFIRMED',
                                        'PAYMENT_FAILED',
                                        'EXPIRED',
                                        'CANCELLED'
                                    )),

    -- ── Stripe fields ────────────────────────────────────────────────────────
    payment_intent_id           TEXT        UNIQUE,   -- Stripe pi_xxx; idempotency key
    -- Gross amount authorized in cents; sourced from events.registration_fee_cents
    gross_amount_cents          INTEGER     NOT NULL CHECK (gross_amount_cents >= 0),
    -- Net settled amount after Stripe fees; populated when status → CONFIRMED
    net_amount_cents            INTEGER,
    -- Running total of amounts refunded in cents
    refunded_amount_cents       INTEGER     NOT NULL DEFAULT 0
                                    CHECK (refunded_amount_cents >= 0),
    stripe_refund_id            TEXT,                 -- Most recent Stripe re_xxx

    -- ── Capture retry tracking (used by reconciliation job) ──────────────────
    capture_attempt_count       INTEGER     NOT NULL DEFAULT 0,
    last_capture_attempt_at     TIMESTAMPTZ,

    -- ── Notification tracking ─────────────────────────────────────────────────
    confirmation_email_sent_at  TIMESTAMPTZ,

    -- ── Timestamps ───────────────────────────────────────────────────────────
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at                TIMESTAMPTZ,
    cancelled_at                TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_registrations_payment_intent
    ON registrations(payment_intent_id)
    WHERE payment_intent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_registrations_event_email
    ON registrations(event_id, email);

CREATE INDEX IF NOT EXISTS idx_registrations_status
    ON registrations(status);

-- Reconciliation scan 1: expired PENDING_PAYMENT
CREATE INDEX IF NOT EXISTS idx_registrations_pending_payment_created
    ON registrations(created_at)
    WHERE status = 'PENDING_PAYMENT';

-- Reconciliation scan 2: PENDING_CAPTURE needing retry or escalation
CREATE INDEX IF NOT EXISTS idx_registrations_pending_capture
    ON registrations(last_capture_attempt_at NULLS FIRST)
    WHERE status = 'PENDING_CAPTURE';

-- Reconciliation scan 3: CONFIRMED with unsent emails
CREATE INDEX IF NOT EXISTS idx_registrations_email_unsent
    ON registrations(confirmed_at)
    WHERE status = 'CONFIRMED' AND confirmation_email_sent_at IS NULL;
```

### 4.3 `waitlist_entries` table

```sql
CREATE TABLE IF NOT EXISTS waitlist_entries (
    waitlist_entry_id   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id            UUID        NOT NULL REFERENCES events(event_id),
    email               TEXT        NOT NULL,
    first_name          TEXT        NOT NULL,
    last_name           TEXT        NOT NULL,
    phone               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT waitlist_unique_email_event UNIQUE (event_id, email)
);

CREATE INDEX IF NOT EXISTS idx_waitlist_event_created
    ON waitlist_entries(event_id, created_at ASC);
```

### 4.4 `refund_log` table

Append-only audit log. `registrations.refunded_amount_cents` holds the running total;
this table holds per-refund history for back-office reconciliation.

```sql
CREATE TABLE IF NOT EXISTS refund_log (
    refund_log_id       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    registration_id     UUID        NOT NULL REFERENCES registrations(registration_id),
    event_id            UUID        NOT NULL,
    stripe_refund_id    TEXT        NOT NULL,
    refund_type         TEXT        NOT NULL CHECK (refund_type IN ('FULL', 'PARTIAL')),
    amount_cents        INTEGER     NOT NULL CHECK (amount_cents > 0),
    reason              TEXT        NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refund_log_registration ON refund_log(registration_id);
CREATE INDEX IF NOT EXISTS idx_refund_log_event        ON refund_log(event_id);
```

---

## 5. Stored Procedures

All multi-step transactional operations live in stored procedures. The appserver calls
each via a single `SELECT * FROM sp_xxx(...)` and acts on the returned `result_code`.
No service method executes multi-step transactions via sequential SQL statements.

### 5.1 `sp_initiate_registration`

Called during Phase 1 after the Stripe PaymentIntent is successfully created.
Checks for duplicates and inserts the registration record. Does not touch availability.

```sql
CREATE OR REPLACE FUNCTION sp_initiate_registration(
    p_event_id              UUID,
    p_email                 TEXT,
    p_first_name            TEXT,
    p_last_name             TEXT,
    p_phone                 TEXT,
    p_attributes            JSONB,
    p_gross_amount_cents    INTEGER,
    p_payment_intent_id     TEXT
)
RETURNS TABLE (
    result_code         TEXT,   -- 'SUCCESS' | 'ALREADY_REGISTERED' | 'EVENT_NOT_FOUND'
    registration_id     UUID
)
LANGUAGE plpgsql AS $$
DECLARE
    v_registration_id   UUID;
    v_existing_count    INTEGER;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM events WHERE event_id = p_event_id) THEN
        RETURN QUERY SELECT 'EVENT_NOT_FOUND'::TEXT, NULL::UUID;
        RETURN;
    END IF;

    -- Non-terminal duplicate: PENDING_PAYMENT, PENDING_CAPTURE, CONFIRMED block re-registration
    SELECT COUNT(*) INTO v_existing_count
    FROM registrations
    WHERE event_id = p_event_id
      AND email    = p_email
      AND status NOT IN ('PAYMENT_FAILED', 'EXPIRED', 'CANCELLED');

    IF v_existing_count > 0 THEN
        RETURN QUERY SELECT 'ALREADY_REGISTERED'::TEXT, NULL::UUID;
        RETURN;
    END IF;

    INSERT INTO registrations (
        event_id, email, first_name, last_name, phone,
        attributes, gross_amount_cents, payment_intent_id, status
    ) VALUES (
        p_event_id, p_email, p_first_name, p_last_name, p_phone,
        p_attributes, p_gross_amount_cents, p_payment_intent_id, 'PENDING_PAYMENT'
    )
    RETURNING registration_id INTO v_registration_id;

    RETURN QUERY SELECT 'SUCCESS'::TEXT, v_registration_id;
END;
$$;
```

### 5.2 `sp_acquire_slot_and_stage_capture`

**The critical-path procedure.** Called from `handlePaymentAuthorized()` on both the
webhook and client POST paths. Acquires a row-level lock on the event, checks
availability, decrements the slot, and transitions the registration to `PENDING_CAPTURE`.
All in a single atomic transaction.

```sql
CREATE OR REPLACE FUNCTION sp_acquire_slot_and_stage_capture(
    p_payment_intent_id TEXT
)
RETURNS TABLE (
    result_code         TEXT,   -- 'SLOT_ACQUIRED' | 'AVAILABILITY_EXHAUSTED'
                                -- | 'IDEMPOTENT_REPLAY' | 'NOT_FOUND' | 'INVALID_STATE'
    registration_id     UUID,
    event_id            UUID,
    email               TEXT,
    first_name          TEXT,
    last_name           TEXT,
    gross_amount_cents  INTEGER
)
LANGUAGE plpgsql AS $$
DECLARE
    v_reg               registrations%ROWTYPE;
    v_available         INTEGER;
BEGIN
    SELECT * INTO v_reg
    FROM registrations
    WHERE payment_intent_id = p_payment_intent_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'NOT_FOUND'::TEXT,
            NULL::UUID, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::INTEGER;
        RETURN;
    END IF;

    -- Idempotency: slot already acquired or finalized
    IF v_reg.status IN ('PENDING_CAPTURE', 'CONFIRMED') THEN
        RETURN QUERY SELECT 'IDEMPOTENT_REPLAY'::TEXT,
            v_reg.registration_id, v_reg.event_id, v_reg.email,
            v_reg.first_name, v_reg.last_name, v_reg.gross_amount_cents;
        RETURN;
    END IF;

    -- Terminal states: caller must cancel the PI to release any hold
    IF v_reg.status IN ('EXPIRED', 'CANCELLED', 'PAYMENT_FAILED') THEN
        RETURN QUERY SELECT 'INVALID_STATE'::TEXT,
            v_reg.registration_id, v_reg.event_id, v_reg.email,
            v_reg.first_name, v_reg.last_name, v_reg.gross_amount_cents;
        RETURN;
    END IF;

    -- Acquire row-level lock on the event row
    SELECT available_slots INTO v_available
    FROM events
    WHERE event_id = v_reg.event_id
    FOR UPDATE;

    IF v_available <= 0 THEN
        -- No slot available; mark failed. Caller must cancel the PaymentIntent.
        UPDATE registrations
        SET status     = 'PAYMENT_FAILED',
            updated_at = now()
        WHERE registration_id = v_reg.registration_id;

        RETURN QUERY SELECT 'AVAILABILITY_EXHAUSTED'::TEXT,
            v_reg.registration_id, v_reg.event_id, v_reg.email,
            v_reg.first_name, v_reg.last_name, v_reg.gross_amount_cents;
        RETURN;
    END IF;

    -- Decrement slot, increment confirmed count
    UPDATE events
    SET available_slots = available_slots - 1,
        confirmed_count = confirmed_count + 1,
        status          = CASE WHEN available_slots - 1 = 0 THEN 'FULL' ELSE status END,
        updated_at      = now()
    WHERE event_id = v_reg.event_id;

    -- Transition to PENDING_CAPTURE: slot held; capture not yet attempted
    UPDATE registrations
    SET status     = 'PENDING_CAPTURE',
        updated_at = now()
    WHERE registration_id = v_reg.registration_id;

    RETURN QUERY SELECT 'SLOT_ACQUIRED'::TEXT,
        v_reg.registration_id, v_reg.event_id, v_reg.email,
        v_reg.first_name, v_reg.last_name, v_reg.gross_amount_cents;
END;
$$;
```

### 5.3 `sp_finalize_registration`

Called after a successful Stripe capture. Transitions `PENDING_CAPTURE` → `CONFIRMED`
and records the net settled amount.

```sql
CREATE OR REPLACE FUNCTION sp_finalize_registration(
    p_payment_intent_id TEXT,
    p_net_amount_cents  INTEGER
)
RETURNS TABLE (
    result_code     TEXT,   -- 'SUCCESS' | 'IDEMPOTENT_REPLAY' | 'NOT_FOUND' | 'INVALID_STATE'
    registration_id UUID,
    event_id        UUID,
    email           TEXT,
    first_name      TEXT,
    last_name       TEXT
)
LANGUAGE plpgsql AS $$
DECLARE
    v_reg registrations%ROWTYPE;
BEGIN
    SELECT * INTO v_reg
    FROM registrations
    WHERE payment_intent_id = p_payment_intent_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'NOT_FOUND'::TEXT,
            NULL::UUID, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::TEXT;
        RETURN;
    END IF;

    IF v_reg.status = 'CONFIRMED' THEN
        RETURN QUERY SELECT 'IDEMPOTENT_REPLAY'::TEXT,
            v_reg.registration_id, v_reg.event_id, v_reg.email,
            v_reg.first_name, v_reg.last_name;
        RETURN;
    END IF;

    IF v_reg.status != 'PENDING_CAPTURE' THEN
        RETURN QUERY SELECT 'INVALID_STATE'::TEXT,
            v_reg.registration_id, v_reg.event_id, v_reg.email,
            v_reg.first_name, v_reg.last_name;
        RETURN;
    END IF;

    UPDATE registrations
    SET status           = 'CONFIRMED',
        net_amount_cents = p_net_amount_cents,
        confirmed_at     = now(),
        updated_at       = now()
    WHERE registration_id = v_reg.registration_id;

    RETURN QUERY SELECT 'SUCCESS'::TEXT,
        v_reg.registration_id, v_reg.event_id, v_reg.email,
        v_reg.first_name, v_reg.last_name;
END;
$$;
```

### 5.4 `sp_restore_slot_on_capture_failure`

Called when Stripe capture has permanently failed after all retries, or when
approaching the 7-day authorization expiry. Restores the slot and marks the
registration `PAYMENT_FAILED`.

```sql
CREATE OR REPLACE FUNCTION sp_restore_slot_on_capture_failure(
    p_payment_intent_id TEXT
)
RETURNS TABLE (
    result_code TEXT    -- 'SUCCESS' | 'NOT_FOUND' | 'INVALID_STATE'
)
LANGUAGE plpgsql AS $$
DECLARE
    v_reg registrations%ROWTYPE;
BEGIN
    SELECT * INTO v_reg
    FROM registrations
    WHERE payment_intent_id = p_payment_intent_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'NOT_FOUND'::TEXT;
        RETURN;
    END IF;

    IF v_reg.status != 'PENDING_CAPTURE' THEN
        RETURN QUERY SELECT 'INVALID_STATE'::TEXT;
        RETURN;
    END IF;

    -- Restore the slot that was decremented during sp_acquire_slot_and_stage_capture
    UPDATE events
    SET available_slots = available_slots + 1,
        confirmed_count = confirmed_count - 1,
        status          = CASE WHEN status = 'FULL' THEN 'OPEN' ELSE status END,
        updated_at      = now()
    WHERE event_id = v_reg.event_id;

    UPDATE registrations
    SET status     = 'PAYMENT_FAILED',
        updated_at = now()
    WHERE registration_id = v_reg.registration_id;

    RETURN QUERY SELECT 'SUCCESS'::TEXT;
END;
$$;
```

### 5.5 `sp_increment_capture_attempt`

Called by the reconciliation job and by `handlePaymentAuthorized()` before each
transient-failure retry, to track attempt count and timing for backoff.

```sql
CREATE OR REPLACE FUNCTION sp_increment_capture_attempt(
    p_registration_id UUID
)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE registrations
    SET capture_attempt_count   = capture_attempt_count + 1,
        last_capture_attempt_at = now(),
        updated_at              = now()
    WHERE registration_id = p_registration_id
      AND status           = 'PENDING_CAPTURE';
END;
$$;
```

### 5.6 `sp_fail_registration`

Marks a registration `PAYMENT_FAILED` on card decline at authorization (Phase 2
failure). No slot was ever acquired; no slot restoration needed.

```sql
CREATE OR REPLACE FUNCTION sp_fail_registration(
    p_payment_intent_id TEXT
)
RETURNS TABLE (
    result_code     TEXT,   -- 'SUCCESS' | 'NOT_FOUND' | 'IDEMPOTENT_REPLAY'
    registration_id UUID
)
LANGUAGE plpgsql AS $$
DECLARE
    v_reg registrations%ROWTYPE;
BEGIN
    SELECT * INTO v_reg
    FROM registrations
    WHERE payment_intent_id = p_payment_intent_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'NOT_FOUND'::TEXT, NULL::UUID;
        RETURN;
    END IF;

    IF v_reg.status IN ('PAYMENT_FAILED', 'EXPIRED') THEN
        RETURN QUERY SELECT 'IDEMPOTENT_REPLAY'::TEXT, v_reg.registration_id;
        RETURN;
    END IF;

    UPDATE registrations
    SET status = 'PAYMENT_FAILED', updated_at = now()
    WHERE registration_id = v_reg.registration_id;

    RETURN QUERY SELECT 'SUCCESS'::TEXT, v_reg.registration_id;
END;
$$;
```

### 5.7 `sp_expire_registration`

Called by the reconciliation job for TTL-exceeded PENDING_PAYMENT registrations.
No slot restoration needed (slot was never decremented for PENDING_PAYMENT records).

```sql
CREATE OR REPLACE FUNCTION sp_expire_registration(
    p_registration_id UUID
)
RETURNS TABLE (
    result_code       TEXT,   -- 'SUCCESS' | 'NOT_FOUND' | 'INVALID_STATE'
    payment_intent_id TEXT
)
LANGUAGE plpgsql AS $$
DECLARE
    v_reg registrations%ROWTYPE;
BEGIN
    SELECT * INTO v_reg
    FROM registrations
    WHERE registration_id = p_registration_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'NOT_FOUND'::TEXT, NULL::TEXT;
        RETURN;
    END IF;

    IF v_reg.status != 'PENDING_PAYMENT' THEN
        RETURN QUERY SELECT 'INVALID_STATE'::TEXT, v_reg.payment_intent_id;
        RETURN;
    END IF;

    UPDATE registrations
    SET status = 'EXPIRED', updated_at = now()
    WHERE registration_id = p_registration_id;

    RETURN QUERY SELECT 'SUCCESS'::TEXT, v_reg.payment_intent_id;
END;
$$;
```

### 5.8 `sp_cancel_registration`

Called during individual full cancellation. Restores availability. The appserver
must call Stripe's Refund API **before** calling this procedure; if the Stripe call
fails, this procedure is not called.

```sql
CREATE OR REPLACE FUNCTION sp_cancel_registration(
    p_registration_id       UUID,
    p_stripe_refund_id      TEXT,
    p_refunded_amount_cents INTEGER,
    p_reason                TEXT,
    p_restore_availability  BOOLEAN DEFAULT TRUE  -- pass FALSE for bulk event cancellation
)
RETURNS TABLE (
    result_code TEXT   -- 'SUCCESS' | 'NOT_FOUND' | 'INVALID_STATE' | 'ALREADY_CANCELLED'
)
LANGUAGE plpgsql AS $$
DECLARE
    v_reg registrations%ROWTYPE;
BEGIN
    SELECT * INTO v_reg
    FROM registrations
    WHERE registration_id = p_registration_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'NOT_FOUND'::TEXT; RETURN;
    END IF;

    IF v_reg.status = 'CANCELLED' THEN
        RETURN QUERY SELECT 'ALREADY_CANCELLED'::TEXT; RETURN;
    END IF;

    IF v_reg.status != 'CONFIRMED' THEN
        RETURN QUERY SELECT 'INVALID_STATE'::TEXT; RETURN;
    END IF;

    -- Restore availability only for individual cancellations
    IF p_restore_availability THEN
        UPDATE events
        SET available_slots = available_slots + 1,
            confirmed_count = confirmed_count - 1,
            status          = CASE WHEN status = 'FULL' THEN 'OPEN' ELSE status END,
            updated_at      = now()
        WHERE event_id = v_reg.event_id;
    END IF;

    UPDATE registrations
    SET status                = 'CANCELLED',
        stripe_refund_id      = p_stripe_refund_id,
        refunded_amount_cents = refunded_amount_cents + p_refunded_amount_cents,
        cancelled_at          = now(),
        updated_at            = now()
    WHERE registration_id = p_registration_id;

    INSERT INTO refund_log (
        registration_id, event_id, stripe_refund_id,
        refund_type, amount_cents, reason
    ) VALUES (
        p_registration_id, v_reg.event_id, p_stripe_refund_id,
        'FULL', p_refunded_amount_cents, p_reason
    );

    RETURN QUERY SELECT 'SUCCESS'::TEXT;
END;
$$;
```

### 5.9 `sp_partial_refund_registration`

Records a partial refund without cancelling the registration or restoring availability.

```sql
CREATE OR REPLACE FUNCTION sp_partial_refund_registration(
    p_registration_id       UUID,
    p_stripe_refund_id      TEXT,
    p_refunded_amount_cents INTEGER,
    p_reason                TEXT
)
RETURNS TABLE (
    result_code TEXT   -- 'SUCCESS' | 'NOT_FOUND' | 'INVALID_STATE' | 'AMOUNT_EXCEEDS_BALANCE'
)
LANGUAGE plpgsql AS $$
DECLARE
    v_reg       registrations%ROWTYPE;
    v_remaining INTEGER;
BEGIN
    SELECT * INTO v_reg
    FROM registrations
    WHERE registration_id = p_registration_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'NOT_FOUND'::TEXT; RETURN;
    END IF;

    IF v_reg.status != 'CONFIRMED' THEN
        RETURN QUERY SELECT 'INVALID_STATE'::TEXT; RETURN;
    END IF;

    v_remaining := v_reg.gross_amount_cents - v_reg.refunded_amount_cents;

    IF p_refunded_amount_cents > v_remaining THEN
        RETURN QUERY SELECT 'AMOUNT_EXCEEDS_BALANCE'::TEXT; RETURN;
    END IF;

    UPDATE registrations
    SET refunded_amount_cents = refunded_amount_cents + p_refunded_amount_cents,
        stripe_refund_id      = p_stripe_refund_id,
        updated_at            = now()
    WHERE registration_id = p_registration_id;

    INSERT INTO refund_log (
        registration_id, event_id, stripe_refund_id,
        refund_type, amount_cents, reason
    ) VALUES (
        p_registration_id, v_reg.event_id, p_stripe_refund_id,
        'PARTIAL', p_refunded_amount_cents, p_reason
    );

    RETURN QUERY SELECT 'SUCCESS'::TEXT;
END;
$$;
```

### 5.10 `sp_mark_confirmation_email_sent`

```sql
CREATE OR REPLACE FUNCTION sp_mark_confirmation_email_sent(
    p_registration_id UUID
)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE registrations
    SET confirmation_email_sent_at = now(),
        updated_at                 = now()
    WHERE registration_id          = p_registration_id
      AND confirmation_email_sent_at IS NULL;
END;
$$;
```

---

## 6. Shared TypeScript Types

File: `src/registration/types.ts` — single source of truth for all registration types.

```typescript
// ─── Identifiers ─────────────────────────────────────────────────────────────

export type EventId          = string;  // UUID
export type RegistrationId   = string;  // UUID
export type WaitlistEntryId  = string;  // UUID
export type PaymentIntentId  = string;  // Stripe pi_xxx
export type RefundId         = string;  // Stripe re_xxx

// ─── Enumerations ─────────────────────────────────────────────────────────────

/**
 * Lifecycle state of a registration record.
 *
 * Valid transitions:
 *   PENDING_PAYMENT  → PENDING_CAPTURE  (authorization succeeded; slot acquired)
 *   PENDING_PAYMENT  → PAYMENT_FAILED   (card declined at authorization)
 *   PENDING_PAYMENT  → EXPIRED          (TTL exceeded; PI cancelled by reconciliation)
 *   PENDING_CAPTURE  → CONFIRMED        (Stripe capture succeeded)
 *   PENDING_CAPTURE  → PAYMENT_FAILED   (Stripe capture permanently failed; slot restored)
 *   PENDING_CAPTURE  → EXPIRED          (approaching 7-day auth window)
 *   CONFIRMED        → CANCELLED        (full cancellation with Stripe refund)
 *   PAYMENT_FAILED   → (terminal)
 *   EXPIRED          → (terminal)
 */
export type RegistrationStatus =
  | 'PENDING_PAYMENT'
  | 'PENDING_CAPTURE'
  | 'CONFIRMED'
  | 'PAYMENT_FAILED'
  | 'EXPIRED'
  | 'CANCELLED';

/**
 * Outcome codes returned by service operations to controllers.
 * Controllers map these to HTTP responses or UI redirects.
 * Never expose these raw codes directly in user-facing messages.
 */
export type RegistrationOutcome =
  | 'SUCCESS'
  | 'AVAILABILITY_EXHAUSTED'    // event full; authorization released; no charge
  | 'ALREADY_REGISTERED'        // duplicate non-terminal registration for this email+event
  | 'PAYMENT_FAILED'            // card declined at authorization
  | 'CAPTURE_FAILED'            // Stripe capture failed (transient or permanent)
  | 'PAYMENT_INTENT_EXPIRED'    // reconciliation cancelled this PI
  | 'STRIPE_TIMEOUT'            // Stripe API call timed out during PI creation
  | 'STRIPE_ERROR'              // unrecoverable Stripe API error
  | 'NOT_FOUND'                 // registration or event not found
  | 'INVALID_STATE'             // operation not valid for current status
  | 'IDEMPOTENT_REPLAY'         // already processed; clean no-op
  | 'INTERNAL_ERROR';

export type RefundOutcome =
  | 'REFUND_ISSUED'
  | 'PARTIAL_REFUND_ISSUED'
  | 'ALREADY_REFUNDED'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'AMOUNT_EXCEEDS_BALANCE'
  | 'STRIPE_ERROR'
  | 'INTERNAL_ERROR';

export type RefundType = 'FULL' | 'PARTIAL';

// ─── Core Domain Objects ──────────────────────────────────────────────────────

export interface EventAvailability {
  eventId:           EventId;
  totalCapacity:     number;
  confirmedCount:    number;
  availableSlots:    number;    // totalCapacity - confirmedCount; never < 0
  waitlistCount:     number;
  status:            string;    // 'OPEN' | 'FULL' | 'CANCELLED' | 'CLOSED'
  updatedAt:         Date;
}

export interface RegistrationRecord {
  registrationId:           RegistrationId;
  eventId:                  EventId;
  email:                    string;
  firstName:                string;
  lastName:                 string;
  phone:                    string | null;
  attributes:               Record<string, string>;
  status:                   RegistrationStatus;
  paymentIntentId:          PaymentIntentId | null;
  grossAmountCents:         number;
  netAmountCents:           number | null;
  refundedAmountCents:      number;
  stripeRefundId:           RefundId | null;
  captureAttemptCount:      number;
  lastCaptureAttemptAt:     Date | null;
  confirmationEmailSentAt:  Date | null;
  createdAt:                Date;
  updatedAt:                Date;
  confirmedAt:              Date | null;
  cancelledAt:              Date | null;
}

export interface WaitlistEntry {
  waitlistEntryId: WaitlistEntryId;
  eventId:         EventId;
  email:           string;
  firstName:       string;
  lastName:        string;
  phone:           string | null;
  createdAt:       Date;
}

// ─── Input Shapes ─────────────────────────────────────────────────────────────

export interface RegistrationFormData {
  eventId:          EventId;
  email:            string;
  firstName:        string;
  lastName:         string;
  phone?:           string;
  attributes?:      Record<string, string>;
  /**
   * Gross charge amount in cents. The controller MUST derive this from
   * events.registration_fee_cents server-side before calling initiateRegistration().
   * The client form never determines or transmits this value.
   * The service validates it matches the event record.
   */
  grossAmountCents: number;
}

export interface WaitlistFormData {
  eventId:   EventId;
  email:     string;
  firstName: string;
  lastName:  string;
  phone?:    string;
}

export interface IndividualRefundRequest {
  registrationId:      RegistrationId;
  refundType:          RefundType;
  /** Required when refundType === 'PARTIAL'; in cents; must be > 0 */
  partialAmountCents?: number;
  /** Admin-supplied reason; stored in refund_log for audit */
  reason:              string;
}

export interface BulkRefundRequest {
  eventId:    EventId;
  refundType: 'FULL';   // partial bulk not in scope
  reason:     string;
}

// ─── Result Shapes ────────────────────────────────────────────────────────────

export interface RegistrationInitResult {
  outcome:             RegistrationOutcome;
  registrationId?:     RegistrationId;
  /** Stripe client_secret; browser passes to Stripe.js to authorize payment */
  stripeClientSecret?: string;
  paymentIntentId?:    PaymentIntentId;
  message?:            string;
}

export interface AuthorizationProcessResult {
  outcome:         RegistrationOutcome;
  registrationId?: RegistrationId;
  message?:        string;
}

export interface RefundResult {
  outcome:              RefundOutcome;
  registrationId?:      RegistrationId;
  stripeRefundId?:      RefundId;
  refundedAmountCents?: number;
  message?:             string;
}

export interface BulkRefundResult {
  eventId:        EventId;
  totalProcessed: number;
  totalSucceeded: number;
  totalFailed:    number;
  results:        Array<{ registrationId: RegistrationId; result: RefundResult }>;
}

export interface ReconciliationResult {
  expiredCount:            number;
  captureRetriedCount:     number;
  captureRestoredCount:    number;
  webhookRecoveredCount:   number;
  emailResentCount:        number;
  errorCount:              number;
  expiredRegistrationIds:  RegistrationId[];
  restoredRegistrationIds: RegistrationId[];
}
```

---

## 7. Service Interfaces

File: `src/registration/interfaces.ts`
Implementations: `src/registration/services/`

### 7.1 `IEventAvailabilityService`

```typescript
export interface IEventAvailabilityService {

  /**
   * Returns current availability snapshot for an event.
   * Non-locking read — point-in-time snapshot for page display.
   * Returns null if the event is not found.
   */
  getAvailability(eventId: EventId): Promise<EventAvailability | null>;
}
```

### 7.2 `IRegistrationService`

```typescript
export interface IRegistrationService {

  /**
   * PHASE 1 — Form submission handler.
   *
   * Called by the registration form POST controller after the controller has:
   *   (a) validated all form fields server-side
   *   (b) resolved grossAmountCents from events.registration_fee_cents
   *
   * Sequence (Stripe call precedes DB insert — see rationale below):
   *   1. Validates grossAmountCents matches the event record. Returns INTERNAL_ERROR
   *      if mismatch (indicates a controller bug).
   *   2. Calls Stripe API to create a PaymentIntent:
   *        - capture_method: 'manual'          ← REQUIRED
   *        - amount:         grossAmountCents
   *        - currency:       'usd'
   *        - idempotency_key: freshly generated UUID (Stripe-Idempotency-Key header)
   *        - metadata: { eventId, email }
   *        - automatic_payment_methods: { enabled: true }
   *      Timeout: STRIPE_API_TIMEOUT_MS (default 10000ms).
   *      On timeout: returns STRIPE_TIMEOUT (no DB record created).
   *      On Stripe error: returns STRIPE_ERROR (no DB record created).
   *   3. Calls sp_initiate_registration() to insert the registration record.
   *      On ALREADY_REGISTERED: cancels the just-created PaymentIntent via Stripe,
   *        returns ALREADY_REGISTERED.
   *      On EVENT_NOT_FOUND: cancels the just-created PaymentIntent, returns NOT_FOUND.
   *   4. Returns SUCCESS with stripeClientSecret and paymentIntentId.
   *
   * Ordering rationale: Stripe is called before the DB insert so that if the DB
   * insert fails, we have a PI to cancel. If Stripe fails, there is no DB record
   * to clean up. This avoids orphaned DB records with no corresponding PI.
   *
   * Controller actions by outcome:
   *   SUCCESS               → pass stripeClientSecret to UI; render payment element
   *   ALREADY_REGISTERED    → render duplicate-registration error
   *   STRIPE_TIMEOUT        → render "please try again; you were not charged"
   *   STRIPE_ERROR          → render generic payment setup error
   *   NOT_FOUND             → render event-not-found error
   *   INTERNAL_ERROR        → render generic error
   */
  initiateRegistration(
    formData: RegistrationFormData
  ): Promise<RegistrationInitResult>;

  /**
   * PHASE 3, Path A — Stripe webhook handler for
   * payment_intent.amount_capturable_updated.
   *
   * Called by the webhook controller AFTER it has verified the Stripe-Signature
   * header via stripe.webhooks.constructEvent(). This event signals that the card
   * has been authorized and the PaymentIntent is in 'requires_capture' status.
   *
   * Delegates entirely to handlePaymentAuthorized(). Idempotent.
   *
   * Webhook controller returns HTTP 200 for all outcomes except INTERNAL_ERROR.
   * INTERNAL_ERROR → HTTP 500, which causes Stripe to retry webhook delivery.
   */
  handleAuthorizationWebhook(
    paymentIntentId: PaymentIntentId,
    stripeEventPayload: Record<string, unknown>
  ): Promise<AuthorizationProcessResult>;

  /**
   * PHASE 3, Path B — Client-confirmation handler.
   *
   * Called by the controller when the browser POSTs after Stripe.js reports
   * authorization success. This is the fast path that allows the UI to display
   * a result without waiting for the webhook.
   *
   * Sequence:
   *   1. Calls stripe.paymentIntents.retrieve(paymentIntentId).
   *      The client's claim of success is NOT trusted. The server verifies
   *      independently via the Stripe API. This closes the attack vector where
   *      a malicious client POSTs a fake confirmation for an unpaid PI.
   *   2. If retrieved status is not 'requires_capture': returns PAYMENT_FAILED.
   *   3. Extracts grossAmountCents from the retrieved PI.
   *   4. Delegates to handlePaymentAuthorized().
   *
   * Controller actions by outcome:
   *   SUCCESS               → redirect to /registration/:id/confirmed
   *   IDEMPOTENT_REPLAY     → redirect to /registration/:id/confirmed (webhook won)
   *   AVAILABILITY_EXHAUSTED → redirect to /events/:eventId/waitlist?reason=full
   *   PAYMENT_FAILED        → render payment-failed page
   *   CAPTURE_FAILED        → render "your registration is being finalized" page
   *   INTERNAL_ERROR        → render generic error
   */
  confirmRegistrationFromClient(
    paymentIntentId: PaymentIntentId
  ): Promise<AuthorizationProcessResult>;

  /**
   * Core shared logic called by both handleAuthorizationWebhook() and
   * confirmRegistrationFromClient(). Not called directly by controllers.
   *
   * Sequence:
   *   1. Calls sp_acquire_slot_and_stage_capture(paymentIntentId).
   *
   *   On SLOT_ACQUIRED:
   *     2. Calls stripe.paymentIntents.capture(paymentIntentId).
   *        On capture SUCCESS:
   *          3. Calls sp_finalize_registration(paymentIntentId, netAmountCents).
   *             netAmountCents derived from capture response (latest_charge.amount_captured).
   *          4. Post-commit: calls INotificationService.sendRegistrationConfirmation().
   *          5. Calls sp_mark_confirmation_email_sent().
   *          6. Returns SUCCESS.
   *        On capture TRANSIENT FAILURE (api_error, 5xx, rate_limit):
   *          3. Calls sp_increment_capture_attempt().
   *          4. Returns CAPTURE_FAILED.
   *             (Reconciliation job will retry; slot is held in PENDING_CAPTURE.)
   *        On capture PERMANENT FAILURE (card_error with decline code):
   *          3. Calls sp_restore_slot_on_capture_failure(paymentIntentId).
   *          4. Returns CAPTURE_FAILED.
   *
   *   On AVAILABILITY_EXHAUSTED:
   *     2. Calls stripe.paymentIntents.cancel(paymentIntentId).
   *        This releases the authorization hold. No money moves. No refund issued.
   *     3. Returns AVAILABILITY_EXHAUSTED.
   *
   *   On IDEMPOTENT_REPLAY:
   *     Returns IDEMPOTENT_REPLAY immediately. No Stripe calls.
   *
   *   On INVALID_STATE (registration in terminal state, PI in requires_capture):
   *     Calls stripe.paymentIntents.cancel(paymentIntentId) as safety net.
   *     Returns INVALID_STATE.
   *
   * Distinguishing transient vs permanent Stripe errors (inspect error object):
   *   Transient: error.type === 'api_error', error.code === 'rate_limit', HTTP 5xx
   *   Permanent: error.type === 'card_error' (any decline code)
   *   Reference: https://stripe.com/docs/declines/codes
   */
  handlePaymentAuthorized(
    paymentIntentId: PaymentIntentId,
    grossAmountCents: number
  ): Promise<AuthorizationProcessResult>;

  /**
   * Webhook handler for payment_intent.payment_failed.
   *
   * Card was declined at the authorization step. No slot was ever acquired;
   * no slot restoration is needed.
   * Calls sp_fail_registration(). Idempotent.
   * Webhook controller always returns HTTP 200 for this event type.
   */
  handlePaymentFailed(
    paymentIntentId: PaymentIntentId,
    stripeEventPayload: Record<string, unknown>
  ): Promise<AuthorizationProcessResult>;

  /** Returns a registration by primary key. Null if not found. */
  getRegistration(registrationId: RegistrationId): Promise<RegistrationRecord | null>;

  /** Returns a registration by paymentIntentId. Null if not found. */
  getRegistrationByPaymentIntent(
    paymentIntentId: PaymentIntentId
  ): Promise<RegistrationRecord | null>;

  /** Returns all CONFIRMED registrations for an event. For admin use. */
  getConfirmedRegistrations(eventId: EventId): Promise<RegistrationRecord[]>;
}
```

### 7.3 `IRefundService`

```typescript
export interface IRefundService {

  /**
   * Issues a full or partial refund for a single CONFIRMED registration.
   *
   * IMPORTANT: Refunds apply only to CONFIRMED registrations (captured charges).
   * Releasing an authorization on a PENDING_CAPTURE or PENDING_PAYMENT registration
   * is handled internally via stripe.paymentIntents.cancel(), not through this service.
   *
   * FULL refund sequence:
   *   1. Validates registration exists and status === 'CONFIRMED'.
   *   2. Checks for prior full refund; returns ALREADY_REFUNDED if found.
   *   3. Calls stripe.refunds.create({ payment_intent: piId }) for gross_amount_cents.
   *   4. On Stripe success: calls sp_cancel_registration(p_restore_availability: true).
   *        - Status → CANCELLED; slot restored; refund_log entry created.
   *   5. Post-commit: calls INotificationService.sendRefundConfirmation().
   *   6. Returns REFUND_ISSUED.
   *
   * PARTIAL refund sequence:
   *   1. Validates registration exists and status === 'CONFIRMED'.
   *   2. Validates partialAmountCents > 0 and <= gross - already_refunded.
   *   3. Calls stripe.refunds.create({ payment_intent: piId, amount: partialAmountCents }).
   *   4. On Stripe success: calls sp_partial_refund_registration().
   *        - Status remains CONFIRMED; slot retained; refund_log entry created.
   *   5. Returns PARTIAL_REFUND_ISSUED.
   */
  refundRegistration(request: IndividualRefundRequest): Promise<RefundResult>;

  /**
   * Issues full refunds for all CONFIRMED registrations for a cancelled event.
   *
   *   - Fetches all CONFIRMED registrations for the event.
   *   - For each: calls stripe.refunds.create() then sp_cancel_registration()
   *     with p_restore_availability: false (event is being cancelled;
   *     restoring individual slots is meaningless).
   *   - Does NOT abort on individual Stripe failure; continues processing others.
   *     All outcomes collected in BulkRefundResult.
   *   - Already-cancelled registrations return ALREADY_REFUNDED and count as succeeded.
   *   - After all registrations processed: sets events.status = 'CANCELLED'.
   *   - Returns full audit record.
   *
   * The admin controller must confirm intent before calling this. Irreversible.
   */
  refundEvent(request: BulkRefundRequest): Promise<BulkRefundResult>;
}
```

### 7.4 `IWaitlistService`

```typescript
export interface IWaitlistService {

  /**
   * Adds a user to the event waitlist.
   * Duplicate entries (same email + eventId) are silently de-duplicated:
   * returns the existing entry without inserting a new row.
   * Always accepted regardless of event status.
   */
  addToWaitlist(formData: WaitlistFormData): Promise<WaitlistEntry>;

  /** Returns all waitlist entries for an event in FIFO order (created_at ASC). */
  getWaitlist(eventId: EventId): Promise<WaitlistEntry[]>;

  /**
   * Returns the 1-based waitlist position for a given email.
   * Returns null if the email is not on the waitlist.
   */
  getWaitlistPosition(eventId: EventId, email: string): Promise<number | null>;

  /** Removes a waitlist entry. Returns false if not found. */
  removeFromWaitlist(waitlistEntryId: WaitlistEntryId): Promise<boolean>;
}
```

### 7.5 `IReconciliationService`

```typescript
export interface IReconciliationService {

  /**
   * Main reconciliation sweep. Called by the scheduled Fly.io worker (see §10).
   * Safe to run concurrently — uses SELECT ... FOR UPDATE SKIP LOCKED throughout.
   *
   * Performs three independent scans in sequence:
   *
   * ── SCAN 1: Expired PENDING_PAYMENT registrations ────────────────────────
   * Query: registrations WHERE status = 'PENDING_PAYMENT'
   *        AND created_at < now() - interval '<ttlMinutes> minutes'
   *        FOR UPDATE SKIP LOCKED
   * For each:
   *   a. Call stripe.paymentIntents.retrieve(piId).
   *   b. If PI status = 'requires_capture': call handlePaymentAuthorized()
   *      (recovers a missed webhook — the card was authorized but the
   *      server never received the notification).
   *   c. If PI status = 'canceled', 'requires_payment_method', or other non-
   *      capturable terminal state: call stripe.paymentIntents.cancel() if
   *      PI is not already terminal, then call sp_expire_registration().
   *   d. On Stripe API error: log, increment errorCount, continue.
   *
   * ── SCAN 2: PENDING_CAPTURE registrations (capture retry) ────────────────
   * Query: registrations WHERE status = 'PENDING_CAPTURE'
   *        FOR UPDATE SKIP LOCKED
   * For each:
   *   a. If created_at < now() - interval '6 days':
   *      Escalate — call sp_restore_slot_on_capture_failure() regardless of
   *      retry count. Authorization is about to expire; recovery is not possible.
   *   b. Check exponential backoff: skip if
   *      last_capture_attempt_at > now() - interval '(2^capture_attempt_count) minutes'
   *   c. If capture_attempt_count >= CAPTURE_MAX_RETRIES:
   *      Call sp_restore_slot_on_capture_failure(). Log permanent failure.
   *   d. Otherwise: call sp_increment_capture_attempt().
   *      Call stripe.paymentIntents.capture(piId).
   *      On SUCCESS: call sp_finalize_registration(); send confirmation email.
   *      On TRANSIENT FAILURE: log, continue (will retry next sweep).
   *      On PERMANENT FAILURE: call sp_restore_slot_on_capture_failure().
   *
   * ── SCAN 3: CONFIRMED registrations with unsent confirmation emails ───────
   * Query: registrations WHERE status = 'CONFIRMED'
   *        AND confirmation_email_sent_at IS NULL
   * For each:
   *   a. Call INotificationService.sendRegistrationConfirmation().
   *   b. On success: call sp_mark_confirmation_email_sent().
   *   c. On failure: log, increment emailResentCount (not errorCount), continue.
   *
   * Returns ReconciliationResult summarizing all actions taken.
   *
   * @param ttlMinutes Default: REGISTRATION_TTL_MINUTES env var (30).
   */
  reconcilePendingRegistrations(ttlMinutes?: number): Promise<ReconciliationResult>;
}
```

---

## 8. Invariants the Implementation Must Enforce

No code path may violate these constraints.

1. **No slot decrement without a verified card authorization.**
   `sp_acquire_slot_and_stage_capture()` is only called from `handlePaymentAuthorized()`,
   and only after the PaymentIntent status has been verified as `requires_capture`
   via a signed Stripe webhook or a Stripe API retrieve call.

2. **No double slot decrement.**
   `sp_acquire_slot_and_stage_capture()` checks `status IN ('PENDING_CAPTURE', 'CONFIRMED')`
   under a row lock before decrementing. A second call for the same `paymentIntentId`
   returns `IDEMPOTENT_REPLAY`.

3. **Every slot decrement is matched by either a successful capture or a slot restore.**
   - Normal: decrement → capture → `CONFIRMED`
   - Failed capture: decrement → `sp_restore_slot_on_capture_failure()` → `PAYMENT_FAILED`
   - Approaching auth expiry: reconciliation job → `sp_restore_slot_on_capture_failure()`
   There is no code path that decrements a slot without a corresponding `CONFIRMED`
   registration or an explicit slot restore.

4. **No charge for a failed registration.**
   `AVAILABILITY_EXHAUSTED` outcomes call `stripe.paymentIntents.cancel()` — the hold
   is released and no money moves. `capture_method: 'manual'` guarantees funds do not
   move until an explicit capture call succeeds.

5. **`grossAmountCents` is server-authoritative.**
   Controllers resolve `grossAmountCents` from `events.registration_fee_cents`.
   The service validates this matches the event record. The client never determines
   the charge amount.

6. **`IEventAvailabilityService` is read-only.**
   All mutations to `available_slots` and `confirmed_count` happen exclusively inside
   stored procedures. No service method executes ad-hoc UPDATE statements on these columns.

7. **Webhook signature verified by controller, not service.**
   `handleAuthorizationWebhook()` and `handlePaymentFailed()` assume signature
   verification has already been done via `stripe.webhooks.constructEvent()`.
   The webhook endpoint must receive the raw unparsed body — body-parsing middleware
   must not run before webhook routes.

8. **Email notification is post-commit and never in-transaction.**
   `INotificationService.sendRegistrationConfirmation()` is called only after the
   transaction setting `status = 'CONFIRMED'` has committed. A failed email send
   never rolls back a confirmed registration.

9. **`available_slots + confirmed_count = total_capacity` at all times.**
   The `capacity_invariant` CHECK constraint in the `events` table enforces this at
   the database level. It is the final safety net against any bug in the service layer.

---

## 9. Notification Interface

File: `src/registration/interfaces.ts`

```typescript
export interface INotificationService {

  /**
   * Sends a registration confirmation email to the registrant.
   * Called post-commit after status = 'CONFIRMED' is set.
   * Also called by the reconciliation job for missed emails.
   *
   * Email must include at minimum:
   *   - Registrant full name
   *   - Event name, date, location
   *   - Registration ID (for support reference)
   *   - Amount charged (grossAmountCents formatted as currency)
   *   - Cancellation policy and contact information
   *
   * Use the email delivery infrastructure already in place on the site.
   * Throws on unrecoverable failure so the reconciliation job can log and retry.
   */
  sendRegistrationConfirmation(
    registration: RegistrationRecord,
    eventName: string
  ): Promise<void>;

  /**
   * Sends a waitlist acknowledgement email.
   * Content: position on waitlist, event name, what happens next.
   */
  sendWaitlistAcknowledgement(
    entry: WaitlistEntry,
    position: number,
    eventName: string
  ): Promise<void>;

  /**
   * Sends a refund confirmation email.
   * Content: amount refunded, registration ID, expected timeline (5–10 business days).
   */
  sendRefundConfirmation(
    registration: RegistrationRecord,
    refundedAmountCents: number,
    eventName: string
  ): Promise<void>;
}
```

---

## 10. Scheduled Reconciliation — Fly.io Deployment

### 10.1 Overview

The reconciliation job must run every 5 minutes in production. On Fly.io this is
implemented as a **separate Machine process group** using
[supercronic](https://github.com/aptible/supercronic) — a container-native cron
runner. The web server and worker processes are defined in the same `fly.toml` and
built from the same Docker image, but run as independent Fly.io Machines that scale
separately.

This approach is chosen because:
- The web server's CPU and memory budget is not consumed by reconciliation
- Reconciliation continues independently of web server restarts or scaling events
- The job can be invoked manually for operational purposes
- Supercronic is battle-tested for container environments (unlike system cron)

### 10.2 File Structure

```
project-root/
├── fly.toml
├── Dockerfile
├── crontab                              ← supercronic crontab; 1 line
└── src/
    └── registration/
        └── reconciliation-runner.ts    ← standalone script; entry point for supercronic
```

### 10.3 `fly.toml`

```toml
[build]
  dockerfile = "Dockerfile"

[processes]
  web    = "node dist/server.js"
  worker = "supercronic /app/crontab"

# Web process: public HTTPS service
[[services]]
  processes     = ["web"]
  internal_port = 3000
  protocol      = "tcp"

  [[services.ports]]
    port     = 443
    handlers = ["tls", "http"]

  [[services.ports]]
    port     = 80
    handlers = ["http"]

# Worker process: no public ports; no HTTP service
# Fly.io creates a separate Machine for this process group
# Scale it independently: fly scale count 1 --process-group worker
```

### 10.4 `crontab`

```crontab
# Run reconciliation sweep every 5 minutes
*/5 * * * * node /app/dist/registration/reconciliation-runner.js
```

This file lives at the project root and is copied into the Docker image (see §10.5).

### 10.5 Dockerfile additions

Add to the existing Dockerfile. Verify the supercronic version and SHA at
https://github.com/aptible/supercronic/releases before using.

```dockerfile
# Install supercronic
ENV SUPERCRONIC_URL=https://github.com/aptible/supercronic/releases/download/v0.2.29/supercronic-linux-amd64 \
    SUPERCRONIC=/usr/local/bin/supercronic \
    SUPERCRONIC_SHA1SUM=cd48d45c4b10f3f0bfdd3a57d054cd05ac96812b

RUN curl -fsSLO "$SUPERCRONIC_URL" \
 && echo "${SUPERCRONIC_SHA1SUM}  supercronic-linux-amd64" | sha1sum -c - \
 && chmod +x supercronic-linux-amd64 \
 && mv supercronic-linux-amd64 "$SUPERCRONIC"

# Copy crontab into image
COPY crontab /app/crontab
```

### 10.6 `reconciliation-runner.ts`

Standalone TypeScript script compiled to `dist/registration/reconciliation-runner.js`.
Instantiates services, runs one sweep, and exits.

```typescript
// src/registration/reconciliation-runner.ts
//
// Entry point for the scheduled reconciliation job.
// Executed by supercronic every 5 minutes.
// Exit code 0: success (including partial success with logged errors).
// Exit code 1: fatal startup error (missing env vars, DB unreachable, etc.).

import Stripe from 'stripe';
import { ReconciliationService } from './services/ReconciliationService';
import { RegistrationService }   from './services/RegistrationService';
import { NotificationService }   from './services/NotificationService';

async function main(): Promise<void> {
  const requiredEnv = ['STRIPE_SECRET_KEY', 'DATABASE_URL'];
  for (const key of requiredEnv) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  const ttlMinutes       = parseInt(process.env.REGISTRATION_TTL_MINUTES ?? '30', 10);
  const captureMaxRetries = parseInt(process.env.CAPTURE_MAX_RETRIES ?? '5', 10);
  const stripeTimeout    = parseInt(process.env.STRIPE_API_TIMEOUT_MS ?? '10000', 10);

  console.log(`[reconciliation] sweep starting at ${new Date().toISOString()}`);
  console.log(`[reconciliation] config: ttlMinutes=${ttlMinutes}, captureMaxRetries=${captureMaxRetries}`);

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2024-06-20',
    timeout: stripeTimeout,
  });

  const notificationService  = new NotificationService();
  const registrationService  = new RegistrationService(stripe, notificationService);
  const reconciliationService = new ReconciliationService(
    stripe,
    registrationService,
    notificationService,
    { captureMaxRetries }
  );

  const result = await reconciliationService.reconcilePendingRegistrations(ttlMinutes);

  console.log(`[reconciliation] sweep complete:`, JSON.stringify(result, null, 2));

  if (result.errorCount > 0) {
    // Log as warning but do not exit 1 — partial success is normal.
    // Supercronic will re-run in 5 minutes.
    console.warn(`[reconciliation] ${result.errorCount} errors encountered during sweep`);
  }
}

main().catch((err) => {
  console.error('[reconciliation] fatal error:', err);
  process.exit(1);
});
```

### 10.7 Deployment Commands

```bash
# Initial deploy (creates both web and worker Machines)
fly deploy

# Scale worker to exactly 1 instance
# (web scales independently based on traffic)
fly scale count 1 --process-group worker

# Verify both process groups are running
fly status

# View reconciliation logs
fly logs --process-group worker

# Run a manual sweep immediately (for ops/debugging)
fly ssh console --process-group worker --command \
  "node /app/dist/registration/reconciliation-runner.js"

# Pause reconciliation (e.g. during maintenance)
fly scale count 0 --process-group worker

# Resume
fly scale count 1 --process-group worker
```

### 10.8 Environment Variables

Set via `fly secrets set` — secrets apply to all process groups automatically:

```bash
fly secrets set \
  STRIPE_SECRET_KEY="sk_live_..." \
  STRIPE_PUBLISHABLE_KEY="pk_live_..." \
  STRIPE_WEBHOOK_SECRET="whsec_..." \
  DATABASE_URL="postgresql://..." \
  REGISTRATION_TTL_MINUTES="30" \
  CAPTURE_MAX_RETRIES="5" \
  STRIPE_API_TIMEOUT_MS="10000"
```

### 10.9 VM Sizing for the Worker

The worker Machine does not serve HTTP traffic and has modest resource requirements.
Size it smaller than the web Machine:

```bash
# Set worker VM to shared-cpu-1x with 256MB RAM
fly scale vm shared-cpu-1x --memory 256 --process-group worker
```

---

## 11. Registration Form Page Requirements

### 11.1 Overview

The registration form page is a server-rendered Hono page with client-side Stripe.js
integration. It orchestrates Phase 1 (form POST → PaymentIntent creation) and
Phase 3 Path B (client POST after authorization → slot acquisition and capture).

Event-specific form fields are defined in `REGISTRATION-FORM-FIELDS.md` (separate
document). This section covers structure, flow, security, and Stripe.js integration.

### 11.2 Page Flow

```
GET /events/:eventId/register
  Server: fetch EventAvailability
  If available_slots = 0: redirect to /events/:eventId/waitlist
  Render: participant fields form + Stripe.js script tag
          Inject STRIPE_PUBLISHABLE_KEY as data attribute on a page element

User fills participant fields → clicks "Continue to Payment"

POST /events/:eventId/register   [PHASE 1]
  Controller:
    - Validate all fields server-side (never trust client-side validation alone)
    - Resolve grossAmountCents from event record
    - Call IRegistrationService.initiateRegistration()
  Response (JSON):
    SUCCESS           → { clientSecret, paymentIntentId, registrationId }
    ALREADY_REGISTERED → { error: 'already_registered' }
    STRIPE_TIMEOUT    → { error: 'payment_setup_failed' }
    STRIPE_ERROR      → { error: 'payment_setup_failed' }
    NOT_FOUND         → { error: 'event_not_found' }
    INTERNAL_ERROR    → { error: 'internal_error' }

Browser receives { clientSecret }:
  - Initialize: const stripe = Stripe(PUBLISHABLE_KEY)
  - const elements = stripe.elements({ clientSecret })
  - const paymentElement = elements.create('payment')
  - paymentElement.mount('#payment-element')
  - Show payment form section; hide or show read-only summary of participant fields

User enters card details → clicks "Pay $XX.XX"
  - Disable Pay button immediately (prevent double-submit)
  - Show spinner
  - stripe.confirmPayment({
      elements,
      confirmParams: { /* billing details */ },
      redirect: 'if_required'    ← handles 3DS in-page without full redirect
    })
  On Stripe.js authorization success (status = 'requires_capture'):
    Browser POSTs to /registration/confirm/:paymentIntentId
  On Stripe.js decline:
    Payment Element displays inline error message
    Re-enable Pay button; user corrects and retries
    No server call for decline — Stripe handles entirely in browser

POST /registration/confirm/:paymentIntentId   [PHASE 3 PATH B]
  Controller:
    - Call IRegistrationService.confirmRegistrationFromClient(paymentIntentId)
  On SUCCESS or IDEMPOTENT_REPLAY:
    Redirect to /registration/:registrationId/confirmed
  On AVAILABILITY_EXHAUSTED:
    Redirect to /events/:eventId/waitlist?reason=full
  On PAYMENT_FAILED:
    Render payment-failed page (option to retry with different card)
  On CAPTURE_FAILED:
    Render "finalizing your registration" page (§11.6)
  On INTERNAL_ERROR:
    Render generic error page

GET /registration/:registrationId/confirmed
  Render: registration summary, event details, amount, confirmation email notice
```

### 11.3 Stripe.js Integration Requirements

- Load from `https://js.stripe.com/v3/` only — **never self-host**
- Initialize: `const stripe = Stripe(PUBLISHABLE_KEY)`
  where `PUBLISHABLE_KEY` is server-rendered into the page (e.g., as a `data-stripe-key`
  attribute on a container div) — not fetched from the client environment
- Mount Payment Element only after receiving `clientSecret` from the Phase 1 POST
- Use `redirect: 'if_required'` in `confirmPayment()` to handle 3DS in-page
- Do not re-enable the Pay button after click until an error is returned
- Show a loading spinner between the Phase 1 POST and Payment Element mount
- Show a loading spinner after "Pay" is clicked until the Phase 3 POST resolves

### 11.4 Availability Display

- Display current availability at page render time (point-in-time)
  e.g., "14 of 64 spots remaining"
- No real-time polling in this iteration
- If the event fills between page load and Phase 3 confirmation, the user sees the
  AVAILABILITY_EXHAUSTED outcome and is redirected to the waitlist page

### 11.5 Waitlist Page

Route: `/events/:eventId/waitlist`

Shown when: availability exhausted at page load, or after `AVAILABILITY_EXHAUSTED`
redirect from Phase 3.

- Message: explain event is full; offer waitlist enrollment
- Form fields: first name, last name, email, phone (optional)
- `POST /events/:eventId/waitlist`
  - Controller calls `IWaitlistService.addToWaitlist()`
  - On success: render waitlist confirmation with position number
  - Call `INotificationService.sendWaitlistAcknowledgement()` post-commit

### 11.6 Error Messages

| Condition | User-Facing Message |
|---|---|
| ALREADY_REGISTERED | "We already have a registration for this email address for this event. Please contact us if you believe this is an error." |
| AVAILABILITY_EXHAUSTED | Redirect to waitlist page |
| STRIPE_TIMEOUT | "We had trouble setting up your payment. You have not been charged. Please try again." |
| STRIPE_ERROR | "A payment error occurred. You have not been charged. Please try again or contact support." |
| Card declined (Stripe.js) | Payment Element displays inline message; no custom page needed |
| CAPTURE_FAILED | "Your payment was authorized and your spot is being held while we finalize your registration. You will receive a confirmation email shortly. If you do not receive it within 30 minutes, please contact support." |
| INTERNAL_ERROR | "Something went wrong on our end. You have not been charged. Please try again." |

### 11.7 Security Requirements

- CSRF protection on all form POST endpoints (consistent with existing site)
- Registration fee amount resolved server-side; never read from the form submission
- Webhook endpoint (`/webhooks/stripe`) must verify `Stripe-Signature` header via
  `stripe.webhooks.constructEvent()` before any service call
- Webhook route must receive the **raw unparsed request body** — body-parsing
  middleware must not run before the webhook route handler in the Hono router
- `paymentIntentId` values from client POSTs are verified server-side via Stripe API
  retrieve before any registration state change

---

## 12. Implementation Sequence & Testable Increments

Implement strictly in this order. Each increment must pass all acceptance tests before
proceeding. All tests run against a live PostgreSQL test database (`TEST_DATABASE_URL`).
The Stripe client is mocked in all increments except INCREMENT 13.

---

### INCREMENT 1 — Database Migration & Stored Procedures

**File:** `migrations/001_registration_schema.sql`

Apply the full migration (all tables, indexes, stored procedures from §4 and §5).

**Acceptance tests (direct SQL):**
```sql
-- 1a. capacity_invariant rejects bad insert
INSERT INTO events (name, event_date, total_capacity, confirmed_count,
  available_slots, registration_fee_cents)
VALUES ('Test', now(), 10, 5, 6, 10000);
-- Expected: ERROR — violates check constraint "capacity_invariant"

-- 1b. sp_initiate_registration happy path
INSERT INTO events (name, event_date, total_capacity, confirmed_count,
  available_slots, registration_fee_cents)
VALUES ('Test Event', now() + interval '30 days', 10, 0, 10, 10000)
RETURNING event_id;  -- capture as <event_id>

SELECT * FROM sp_initiate_registration(
  '<event_id>', 'a@test.com', 'Alice', 'Smith', NULL, '{}', 10000, 'pi_test_001'
);
-- Expected: result_code='SUCCESS', registration_id IS NOT NULL

-- 1c. Duplicate check
SELECT * FROM sp_initiate_registration(
  '<event_id>', 'a@test.com', 'Alice', 'Smith', NULL, '{}', 10000, 'pi_test_002'
);
-- Expected: result_code='ALREADY_REGISTERED'

-- 1d. sp_acquire_slot_and_stage_capture happy path
SELECT * FROM sp_acquire_slot_and_stage_capture('pi_test_001');
-- Expected: result_code='SLOT_ACQUIRED'
-- Verify: events.available_slots=9, events.confirmed_count=1

-- 1e. Idempotent replay
SELECT * FROM sp_acquire_slot_and_stage_capture('pi_test_001');
-- Expected: result_code='IDEMPOTENT_REPLAY'
-- Verify: events.available_slots still 9 (no double decrement)

-- 1f. sp_finalize_registration
SELECT * FROM sp_finalize_registration('pi_test_001', 9700);
-- Expected: result_code='SUCCESS'
-- Verify: registrations.status='CONFIRMED', net_amount_cents=9700

-- 1g. capacity_invariant still holds
SELECT available_slots + confirmed_count = total_capacity FROM events WHERE event_id = '<event_id>';
-- Expected: true

-- 1h. Waitlist unique constraint
INSERT INTO waitlist_entries (event_id, email, first_name, last_name)
VALUES ('<event_id>', 'b@test.com', 'Bob', 'Jones');
INSERT INTO waitlist_entries (event_id, email, first_name, last_name)
VALUES ('<event_id>', 'b@test.com', 'Bob', 'Jones');
-- Expected: ERROR — unique constraint "waitlist_unique_email_event"
```

---

### INCREMENT 2 — TypeScript Types

**File:** `src/registration/types.ts`

Implement all types from §6 exactly as specified.

**Acceptance test:** `tsc --noEmit --strict` — zero errors.

---

### INCREMENT 3 — `IEventAvailabilityService`

**Files:**
- `src/registration/interfaces.ts` (stub all interfaces)
- `src/registration/services/EventAvailabilityService.ts`

**Acceptance tests:**
```
Setup: event (total_capacity=10, confirmed_count=0, available_slots=10)
       2 waitlist_entries for the event

getAvailability(eventId) →
  { availableSlots: 10, confirmedCount: 0, waitlistCount: 2, status: 'OPEN' }

getAvailability('nonexistent-uuid') → null
```

---

### INCREMENT 4 — Phase 1: `initiateRegistration`

**File:** `src/registration/services/RegistrationService.ts`
**Mock:** MockStripeClient with default options (§13.2)

**Acceptance tests:**
```
Test 4-1: Happy path
  → outcome: SUCCESS
  → DB: registration row, status=PENDING_PAYMENT, payment_intent_id set
  → mock: paymentIntents.create called with capture_method='manual'
  → stripeClientSecret and paymentIntentId returned

Test 4-2: Duplicate (PENDING_PAYMENT exists for same email+event)
  → outcome: ALREADY_REGISTERED
  → mock: paymentIntents.cancel called (cleanup of just-created PI)
  → DB: no new registration row

Test 4-3: Duplicate with EXPIRED status (should not block)
  → outcome: SUCCESS (expired does not block re-registration)

Test 4-4: Stripe timeout during PI creation
  → mock: createShouldTimeout: true
  → outcome: STRIPE_TIMEOUT
  → DB: no registration row

Test 4-5: grossAmountCents mismatch with event record
  → outcome: INTERNAL_ERROR
  → mock: paymentIntents.cancel called (cleanup)
  → DB: no registration row
```

---

### INCREMENT 5 — Core: `handlePaymentAuthorized`

**File:** `src/registration/services/RegistrationService.ts`

**Acceptance tests:**
```
Test 5-1: Slot available — capture succeeds (normal path)
  → sp_acquire_slot_and_stage_capture → SLOT_ACQUIRED
  → mock: paymentIntents.capture called (captureErrorType: 'none')
  → sp_finalize_registration → CONFIRMED
  → DB: events.available_slots decremented, confirmed_count incremented
  → outcome: SUCCESS

Test 5-2: Slot available — capture fails transiently
  → mock: captureErrorType: 'transient'
  → sp_increment_capture_attempt called
  → DB: registrations.status = PENDING_CAPTURE (unchanged)
  → DB: capture_attempt_count = 1
  → outcome: CAPTURE_FAILED

Test 5-3: Slot available — capture fails permanently
  → mock: captureErrorType: 'permanent'
  → sp_restore_slot_on_capture_failure called
  → DB: registrations.status = PAYMENT_FAILED
  → DB: events.available_slots restored
  → outcome: CAPTURE_FAILED

Test 5-4: No slot available (event full)
  → Set events.available_slots = 0 before calling
  → sp_acquire_slot_and_stage_capture → AVAILABILITY_EXHAUSTED
  → mock: paymentIntents.cancel called (auth released)
  → DB: registrations.status = PAYMENT_FAILED
  → DB: events.available_slots unchanged (still 0)
  → outcome: AVAILABILITY_EXHAUSTED

Test 5-5: Already PENDING_CAPTURE (idempotent)
  → sp_acquire_slot_and_stage_capture → IDEMPOTENT_REPLAY
  → mock: paymentIntents.capture NOT called
  → DB: available_slots NOT double-decremented
  → outcome: IDEMPOTENT_REPLAY

Test 5-6: Already CONFIRMED (idempotent)
  → Same assertions as 5-5
  → outcome: IDEMPOTENT_REPLAY
```

---

### INCREMENT 6 — Webhook and Client-Confirm Paths

**File:** `src/registration/services/RegistrationService.ts`

**Acceptance tests:**
```
Test 6-1: handleAuthorizationWebhook — delegates to handlePaymentAuthorized
  → Same outcome as Test 5-1

Test 6-2: confirmRegistrationFromClient — retrieved PI status = 'requires_capture'
  → mock: retrieveStatus: 'requires_capture'
  → delegates to handlePaymentAuthorized
  → outcome: SUCCESS

Test 6-3: confirmRegistrationFromClient — retrieved PI status ≠ 'requires_capture'
  → mock: retrieveStatus: 'requires_payment_method'
  → handlePaymentAuthorized NOT called
  → outcome: PAYMENT_FAILED

Test 6-4: Race — webhook and client POST arrive for the same PI
  (simulate by calling both sequentially)
  → First call: SUCCESS, slot decremented once
  → Second call: IDEMPOTENT_REPLAY, no second decrement
  → DB: events.available_slots decremented exactly once
  → DB: registrations.status = CONFIRMED (not double-confirmed)
```

---

### INCREMENT 7 — `handlePaymentFailed`

**Acceptance tests:**
```
Test 7-1: Card declined webhook
  → sp_fail_registration called
  → DB: registrations.status = PAYMENT_FAILED
  → DB: events.available_slots unchanged

Test 7-2: Idempotent — call twice
  → Second call: IDEMPOTENT_REPLAY
```

---

### INCREMENT 8 — `INotificationService` + email integration

**File:** `src/registration/services/NotificationService.ts`

**Tasks:**
1. Implement all three methods using existing site email infrastructure
2. Integrate `sendRegistrationConfirmation()` post-commit in `handlePaymentAuthorized()`
3. Verify `confirmation_email_sent_at` is populated after send

**Acceptance tests:**
```
Test 8-1: Successful registration → confirmation email received at test inbox
  → DB: registrations.confirmation_email_sent_at populated

Test 8-2: sendWaitlistAcknowledgement → email received at test inbox

Test 8-3: sendRefundConfirmation → email received at test inbox
```

---

### INCREMENT 9 — `IRefundService`

**File:** `src/registration/services/RefundService.ts`

**Acceptance tests:**
```
Test 9-1: Full individual refund
  → mock: refunds.create called with gross_amount_cents
  → sp_cancel_registration called (p_restore_availability: true)
  → DB: registrations.status = CANCELLED
  → DB: events.available_slots + 1
  → DB: refund_log entry exists
  → outcome: REFUND_ISSUED

Test 9-2: Partial refund
  → DB: registrations.status remains CONFIRMED
  → DB: refunded_amount_cents incremented
  → DB: events.available_slots unchanged
  → DB: refund_log entry exists
  → outcome: PARTIAL_REFUND_ISSUED

Test 9-3: Already cancelled → outcome: ALREADY_REFUNDED

Test 9-4: Partial amount exceeds refundable balance → outcome: AMOUNT_EXCEEDS_BALANCE

Test 9-5: Bulk event refund (3 CONFIRMED registrations)
  → all 3: CANCELLED
  → DB: events.status = 'CANCELLED'
  → DB: 3 refund_log entries
  → BulkRefundResult: totalSucceeded=3, totalFailed=0

Test 9-6: Bulk with one Stripe failure
  → 2 succeed, 1 fails
  → Processing continues after failure (no abort)
  → BulkRefundResult: totalSucceeded=2, totalFailed=1
```

---

### INCREMENT 10 — `IWaitlistService`

**File:** `src/registration/services/WaitlistService.ts`

**Acceptance tests:**
```
Test 10-1: Add 3 entries → getWaitlist returns FIFO order

Test 10-2: Add duplicate email → returns existing entry; DB row count unchanged

Test 10-3: getWaitlistPosition for second-added entry → returns 2

Test 10-4: removeFromWaitlist existing → returns true; entry gone
           removeFromWaitlist non-existent → returns false
```

---

### INCREMENT 11 — `IReconciliationService`

**File:** `src/registration/services/ReconciliationService.ts`

**Acceptance tests:**
```
Test 11-1: PENDING_PAYMENT older than TTL; PI status = 'requires_payment_method'
  → mock: paymentIntents.retrieve returns requires_payment_method
  → mock: paymentIntents.cancel called
  → sp_expire_registration called
  → DB: registrations.status = EXPIRED
  → result.expiredCount = 1

Test 11-2: PENDING_PAYMENT older than TTL; PI status = 'requires_capture' (missed webhook)
  → handlePaymentAuthorized called
  → DB: registrations.status = CONFIRMED
  → result.webhookRecoveredCount = 1

Test 11-3: PENDING_CAPTURE — transient capture failure on retry
  → mock: captureErrorType: 'transient'
  → DB: capture_attempt_count incremented
  → DB: registrations.status still PENDING_CAPTURE
  → result.captureRetriedCount = 1

Test 11-4: PENDING_CAPTURE — capture succeeds on retry
  → mock: captureErrorType: 'none'
  → sp_finalize_registration called
  → DB: registrations.status = CONFIRMED
  → result.captureRetriedCount = 1

Test 11-5: PENDING_CAPTURE — max retries exceeded
  → Set capture_attempt_count = CAPTURE_MAX_RETRIES
  → sp_restore_slot_on_capture_failure called
  → DB: registrations.status = PAYMENT_FAILED
  → DB: events.available_slots restored
  → result.captureRestoredCount = 1

Test 11-6: PENDING_CAPTURE created 6+ days ago (approaching 7-day expiry)
  → sp_restore_slot_on_capture_failure called regardless of retry count
  → DB: registrations.status = PAYMENT_FAILED

Test 11-7: CONFIRMED with confirmation_email_sent_at = NULL
  → sendRegistrationConfirmation called
  → sp_mark_confirmation_email_sent called
  → DB: confirmation_email_sent_at populated
  → result.emailResentCount = 1

Test 11-8: Concurrent reconciliation runs (SKIP LOCKED)
  → Insert 3 PENDING_PAYMENT records (TTL-expired)
  → Run two reconciliation sweeps in parallel (or simulate sequentially)
  → Each record processed exactly once
  → Total result.expiredCount across both runs = 3 (no double-processing)
```

---

### INCREMENT 12 — Reconciliation Runner & Fly.io Configuration

**Files:**
- `src/registration/reconciliation-runner.ts` (§10.6)
- `crontab` (§10.4)
- Dockerfile additions (§10.5)

**Acceptance tests:**
```
Test 12-1: Script runs and exits 0
  npx ts-node src/registration/reconciliation-runner.ts
  → exit code 0
  → stdout contains "[reconciliation] sweep complete"

Test 12-2: Script exits 1 on missing STRIPE_SECRET_KEY
  Unset STRIPE_SECRET_KEY; run script
  → exit code 1

Test 12-3: fly.toml validates (does not need a live Fly.io account)
  fly config validate  (if Fly CLI available)
```

---

### INCREMENT 13 — Full End-to-End Integration Test

**File:** `src/registration/testing/integration.test.ts`

All services, real database, MockStripeClient.

```
Setup: event (total_capacity=2, registration_fee_cents=10000)

Step  1: Register User A → SUCCESS (PENDING_PAYMENT)
Step  2: Register User B → SUCCESS (PENDING_PAYMENT)
Step  3: Register User C → SUCCESS (PENDING_PAYMENT) [event not yet full at initiation]

Step  4: handleAuthorizationWebhook for A → SUCCESS
  → DB: A=CONFIRMED, available_slots=1, confirmed_count=1

Step  5: confirmRegistrationFromClient for B → SUCCESS
  → DB: B=CONFIRMED, available_slots=0, confirmed_count=2, events.status=FULL

Step  6: handleAuthorizationWebhook for C → AVAILABILITY_EXHAUSTED
  → mock: paymentIntents.cancel called (auth released; no charge)
  → DB: C=PAYMENT_FAILED, available_slots unchanged (0)

Step  7: Verify confirmation emails
  → DB: A.confirmation_email_sent_at populated
  → DB: B.confirmation_email_sent_at populated
  → DB: C.confirmation_email_sent_at NULL

Step  8: Add C to waitlist
  → addToWaitlist() → WaitlistEntry
  → getWaitlistPosition(eventId, C.email) → 1

Step  9: Duplicate webhook for B → IDEMPOTENT_REPLAY
  → DB: available_slots still 0 (no double decrement)
  → DB: B.status still CONFIRMED

Step 10: Full refund for A
  → mock: refunds.create called
  → DB: A=CANCELLED, available_slots=1, events.status=OPEN
  → DB: refund_log entry for A

Step 11: Reconciliation sweep
  → No PENDING_PAYMENT or PENDING_CAPTURE records → all counts 0

Step 12: Final state verification
  → events: available_slots=1, confirmed_count=1, total_capacity=2 ✓
  → capacity_invariant: 1 + 1 = 2 ✓
  → registrations: A=CANCELLED, B=CONFIRMED, C=PAYMENT_FAILED
  → waitlist_entries: 1 row (User C)
  → refund_log: 1 row (User A full refund)
```

---

## 13. Test Harness & Stripe Mocking

### 13.1 Philosophy

All service classes accept the Stripe client via constructor injection. In production,
pass the real `Stripe` instance. In tests, pass `MockStripeClient`. No service method
instantiates a Stripe client internally.

### 13.2 `MockStripeClient`

**File:** `src/registration/testing/MockStripeClient.ts`

```typescript
export type StripePaymentIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'requires_capture'
  | 'canceled'
  | 'succeeded';

export type StripeCaptureErrorType = 'none' | 'transient' | 'permanent';

export interface MockStripeOptions {
  // paymentIntents.create
  createShouldTimeout?:     boolean;
  createShouldError?:       boolean;
  createDelayMs?:           number;

  // paymentIntents.retrieve
  retrieveStatus?:          StripePaymentIntentStatus;  // default: 'requires_capture'
  retrieveNetAmountCents?:  number;                     // default: 9700

  // paymentIntents.capture
  captureErrorType?:        StripeCaptureErrorType;     // default: 'none'
  captureNetAmountCents?:   number;                     // default: 9700

  // paymentIntents.cancel
  cancelShouldError?:       boolean;

  // refunds.create
  refundShouldError?:       boolean;
}

export class MockStripeClient {
  options: MockStripeOptions;
  calls: { method: string; args: unknown[] }[] = [];

  constructor(options: MockStripeOptions = {}) {
    this.options = options;
  }

  paymentIntents = {
    create: async (params: Record<string, unknown>, _reqOptions?: unknown) => {
      this.calls.push({ method: 'paymentIntents.create', args: [params] });

      // Enforce the invariant: capture_method must always be 'manual'
      if (params['capture_method'] !== 'manual') {
        throw new Error(
          `MockStripeClient invariant violated: paymentIntents.create called without ` +
          `capture_method: 'manual'. Got: ${params['capture_method']}`
        );
      }

      if (this.options.createShouldTimeout) {
        await new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(Object.assign(new Error('Request timeout'), { type: 'api_error' })),
            this.options.createDelayMs ?? 10001
          )
        );
      }
      if (this.options.createShouldError) {
        throw Object.assign(new Error('Stripe API error (mock)'), { type: 'api_error' });
      }
      const id = `pi_mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      return {
        id,
        client_secret:  `${id}_secret_mock`,
        status:         'requires_payment_method' as StripePaymentIntentStatus,
        amount:         params['amount'],
        currency:       params['currency'],
        capture_method: 'manual',
      };
    },

    retrieve: async (id: string) => {
      this.calls.push({ method: 'paymentIntents.retrieve', args: [id] });
      const net = this.options.retrieveNetAmountCents ?? 9700;
      return {
        id,
        status:          this.options.retrieveStatus ?? 'requires_capture',
        amount_received: net,
        latest_charge:   { amount_captured: net },
      };
    },

    capture: async (id: string) => {
      this.calls.push({ method: 'paymentIntents.capture', args: [id] });
      const errType = this.options.captureErrorType ?? 'none';
      if (errType === 'transient') {
        throw Object.assign(
          new Error('Connection error (mock)'),
          { type: 'api_error', code: 'api_connection_error' }
        );
      }
      if (errType === 'permanent') {
        throw Object.assign(
          new Error('Your card was declined (mock)'),
          { type: 'card_error', code: 'card_declined', decline_code: 'generic_decline' }
        );
      }
      const net = this.options.captureNetAmountCents ?? 9700;
      return {
        id,
        status:          'succeeded' as StripePaymentIntentStatus,
        amount_received: net,
        latest_charge:   { amount_captured: net },
      };
    },

    cancel: async (id: string) => {
      this.calls.push({ method: 'paymentIntents.cancel', args: [id] });
      if (this.options.cancelShouldError) {
        throw Object.assign(new Error('Cancel error (mock)'), { type: 'api_error' });
      }
      return { id, status: 'canceled' as StripePaymentIntentStatus };
    },
  };

  refunds = {
    create: async (params: Record<string, unknown>) => {
      this.calls.push({ method: 'refunds.create', args: [params] });
      if (this.options.refundShouldError) {
        throw Object.assign(new Error('Refund error (mock)'), { type: 'api_error' });
      }
      return {
        id:     `re_mock_${Date.now()}`,
        amount: params['amount'] ?? params['payment_intent'],
        status: 'succeeded',
      };
    },
  };

  webhooks = {
    constructEvent: (payload: string, _sig: string, _secret: string) => {
      // Bypass Stripe signature verification in tests
      return JSON.parse(payload);
    },
  };

  /** Assert a method was called at least once. Throws if not. */
  assertCalled(method: string): void {
    if (!this.calls.some(c => c.method === method)) {
      throw new Error(`MockStripeClient: expected ${method} to have been called`);
    }
  }

  /** Assert a method was NOT called. Throws if it was. */
  assertNotCalled(method: string): void {
    if (this.calls.some(c => c.method === method)) {
      throw new Error(`MockStripeClient: expected ${method} NOT to have been called`);
    }
  }

  /** Reset call log between test cases. */
  reset(): void { this.calls = []; }
}
```

### 13.3 Test Script Structure

Each increment's tests: `src/registration/testing/increment-N.test.ts`

Each file:
1. Truncates all registration-related tables before running
2. Inserts required test event with a known UUID
3. Runs service methods against the live test database (`TEST_DATABASE_URL`)
4. Asserts on both returned values AND direct database state
5. Calls `mockStripe.reset()` between individual test cases

Run all increments in sequence:
```bash
npx ts-node src/registration/testing/run-all-tests.ts
```

Run a specific increment:
```bash
npx ts-node src/registration/testing/increment-5.test.ts
```

Run the reconciliation runner standalone:
```bash
npx ts-node src/registration/reconciliation-runner.ts
```

### 13.4 Environment Variables

```bash
# Application database
DATABASE_URL=postgresql://user:pass@localhost:5432/appdb

# Test database (separate; truncated freely by test scripts)
TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/testdb

# Stripe (real keys; mocked in unit tests; needed for reconciliation-runner live test)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Tuning
STRIPE_API_TIMEOUT_MS=10000
REGISTRATION_TTL_MINUTES=30
CAPTURE_MAX_RETRIES=5
```

---

## 14. Out of Scope

Explicitly excluded — do not implement:

- User profile / account management (linked by email only; no FK to accounts table)
- Waitlist auto-promotion logic (service exposes data; controller acts on it)
- Stripe balance provisioning for refund fee coverage (back-office function)
- Partial bulk event refunds (full refunds only for event cancellation)
- Multi-person registrations (one registration = one participant)
- Organizer-facing event management (creating, editing, opening, closing events)
- Authentication and session management (existing site infrastructure)
- Real-time availability polling on the registration page
- Live registration form page with live Stripe account (separate spec, next iteration —
  this spec ends at the tested service layer and mock test page)

---

## 15. Glossary

| Term | Definition |
|---|---|
| **Authorization** | Stripe's verification that a card is valid and funds are available. Places a hold on the customer's account. No money moves. PaymentIntent enters `requires_capture` status. |
| **Capture** | The Stripe API call (`stripe.paymentIntents.capture()`) that moves authorized funds to the merchant's account. Occurs after authorization in the manual capture flow. PaymentIntent enters `succeeded` status. |
| **Manual capture** | Stripe PaymentIntent configuration (`capture_method: 'manual'`) that separates authorization from capture into two explicit server-controlled operations. |
| **Authorization hold** | The pending charge that appears on the customer's statement after authorization but before capture or cancellation. Valid for 7 days (card network limit). |
| **Release (cancel authorization)** | Calling `stripe.paymentIntents.cancel()` on an authorized-but-not-captured PaymentIntent. The hold is released. No money moves. No Stripe processing fee incurred. |
| **requires_capture** | Stripe PaymentIntent status indicating authorization has succeeded and the server may now call capture or cancel. |
| **PaymentIntent** | Stripe object representing a payment attempt. Created server-side with `capture_method: 'manual'`; authorized client-side via Stripe.js. |
| **client_secret** | Token returned with a PaymentIntent. Passed to the browser for Stripe.js to authorize the payment. Never logged or stored beyond the current request. |
| **PENDING_PAYMENT** | Registration created; PaymentIntent created with `capture_method: 'manual'`; awaiting browser-side card authorization. No slot decremented. |
| **PENDING_CAPTURE** | Card authorized (`requires_capture`); slot decremented; awaiting successful `stripe.paymentIntents.capture()` call. Slot is held. |
| **CONFIRMED** | Stripe capture succeeded; funds moved; slot confirmed; confirmation email sent or queued. |
| **PAYMENT_FAILED** | Card declined at authorization, OR availability exhausted (auth released), OR capture permanently failed (slot restored). Terminal. |
| **EXPIRED** | PaymentIntent abandoned (tab closed, 3DS abandoned); cancelled by reconciliation job. Terminal. No slot was ever decremented. |
| **CANCELLED** | Registration cancelled after CONFIRMED; full Stripe refund issued; slot restored. |
| **IDEMPOTENT_REPLAY** | A second call to an operation already completed for this `paymentIntentId`. Returns success with no side effects. |
| **AVAILABILITY_EXHAUSTED** | Event has no available slots at the time of slot acquisition. Authorization hold released; no charge. |
| **gross_amount_cents** | Full amount authorized in cents; sourced from `events.registration_fee_cents`. Server-authoritative. |
| **net_amount_cents** | Amount settled after Stripe fees; recorded on CONFIRMED (`latest_charge.amount_captured` from capture response). |
| **Stripe fee shortfall** | `gross_amount_cents − net_amount_cents` per registration. The fee not returned on a full refund. Back-office reconciliation concern only. |
| **capacity_invariant** | DB constraint: `available_slots + confirmed_count = total_capacity` at all times. Enforced by a CHECK constraint. |
| **Reconciliation job** | Scheduled background process that expires orphaned PaymentIntents, retries failed captures, and re-sends missed confirmation emails. Runs every 5 minutes via supercronic on Fly.io. |
| **SKIP LOCKED** | PostgreSQL locking option: skip rows already locked by another transaction. Enables safe concurrent reconciliation job execution without double-processing. |
| **supercronic** | Container-native cron process runner. Used to schedule the reconciliation job inside the Fly.io worker Machine. https://github.com/aptible/supercronic |
| **Fly.io process group** | A named process type in `fly.toml [processes]`. `web` serves HTTP; `worker` runs supercronic. Each scales independently as a separate Fly.io Machine. |
| **Transient Stripe error** | Retryable error: network timeout, HTTP 5xx, `rate_limit`. Reconciliation job retries with exponential backoff. |
| **Permanent Stripe error** | Non-retryable error: card decline codes (`card_declined`, `expired_card`, `insufficient_funds`, `do_not_honor`, `fraudulent`, etc.). Triggers immediate slot restoration. |
