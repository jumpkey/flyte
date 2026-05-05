# Test Plan: Payment-Processing Review Fixes

This branch (`claude/review-payment-processing-VXPz4`) applies 14 fixes against
the open PR #17 / branch `copilot/implement-stripe-registration-flow` based on
a code review. The fixes themselves were not validated against a live Postgres
or live Stripe — Claude only performed a TypeScript type-check and applied the
SQL migration to a fresh local Postgres to confirm syntax. **All behavioral
verification still needs to happen.**

This document tells the next agent (or human) exactly what to verify, and
flags the call-sites that changed so the existing `increment-N.test.ts`
suite can be rerun with intent.

---

## How to run the existing test suite

```bash
# Requires a local Postgres reachable via $DATABASE_URL plus the schema applied.
psql "$DATABASE_URL" -f db/migrations/005_registration_schema.sql
npx tsx src/registration/testing/run-all-tests.ts
```

The suite uses `MockStripeClient` and does not require Stripe credentials.
Expected outcome: every increment passes. If any fail, that's a regression
caused by these fixes, not a flaky test — investigate.

---

## Fixes and what to verify

### Fix #1 — CSRF accepts `X-CSRF-Token` header
**Files:** `src/web/middleware/csrf.ts`

The middleware now reads the token from either a form-body `_csrf` field OR an
`X-CSRF-Token` header. Form parsing is gated on content-type so it no longer
silently consumes JSON request bodies.

**Verify:**
1. `POST /events/:id/register` with JSON body and `X-CSRF-Token` header → succeeds.
2. `POST /events/:id/register` with JSON body and NO header → 403.
3. `POST /events/:id/waitlist` with form body containing `_csrf` field → succeeds (regression check).
4. `POST /login` with form body containing `_csrf` field → succeeds (regression check).
5. Mismatched token in either location → 403.

### Fix #2 — `sp_acquire_slot_and_stage_capture` row lock
**File:** `db/migrations/005_registration_schema.sql`

Added `FOR UPDATE` to the registration row read.

**Verify (concurrency test):**
1. Insert a `PENDING_PAYMENT` registration for an event with `available_slots = 1`.
2. From two concurrent psql sessions, both invoke `sp_acquire_slot_and_stage_capture('pi_test')`.
3. Expected: one returns `SLOT_ACQUIRED`, the other returns `IDEMPOTENT_REPLAY`. `available_slots` ends at `0`. `confirmed_count` ends at `1`.

### Fix #3 — No zero-amount fallback
**File:** `src/registration/services/RegistrationService.ts`

Both `handleAuthorizationWebhook` and `confirmRegistrationFromClient` now return
`{ outcome: 'NOT_FOUND' }` when the registration row is not found, instead of
defaulting `grossAmountCents` to `0`.

**Verify:**
1. Call `handleAuthorizationWebhook('pi_does_not_exist', {})`. Expect outcome `NOT_FOUND`.
2. Call `confirmRegistrationFromClient('pi_does_not_exist')` against a Stripe stub returning `requires_capture` for an unknown PI. Expect outcome `NOT_FOUND`. Confirm no `sp_finalize_registration` call was made and no `net_amount_cents = 0` row exists in the DB.

### Fix #4 — Cancel PI on permanent capture failure
**Files:** `src/registration/services/RegistrationService.ts`, `src/registration/services/ReconciliationService.ts`

After `sp_restore_slot_on_capture_failure`, call `stripe.paymentIntents.cancel`
(best-effort try/catch) so the customer's authorization hold is released.

**Verify:**
1. Trigger a permanent (non-transient) capture failure via `MockStripeClient` (e.g. `card_declined` on capture).
2. Confirm `cancel` was called on the mock with the same PI id. No exception thrown if cancel itself fails.
3. Same check in the reconciliation max-retries-exceeded and age-exceeded paths.

### Fix #5 — Rate limit registration endpoints
**File:** `src/web/app.ts`

`POST /events/:id/register`, `POST /registration/confirm/:piId`, and
`POST /events/:id/waitlist` now use `rateLimit(10, 60000)`.

**Verify:**
1. Make 11 rapid POSTs to `/events/<id>/register` from the same IP within 60s. The 11th returns 429.
2. Same for `/registration/confirm/...` and `/events/<id>/waitlist`.
3. After the 60s window, requests succeed again.

### Fix #6 — Reconciliation row lock held across Stripe call
**File:** `src/registration/services/ReconciliationService.ts`

Each row in scans 1, 2, 3 is now processed inside its own `sql.begin(...)`
transaction. The row is re-selected `FOR UPDATE SKIP LOCKED` inside the
transaction, so two concurrent reconciliation runs against the same DB cannot
process the same row.

**Verify (concurrency test):**
1. Seed the DB with N expired `PENDING_PAYMENT` registrations.
2. Run two `reconcilePendingRegistrations()` calls concurrently from different processes (simulating multiple Fly worker machines, with the advisory lock disabled or commented out for this test only).
3. Expected: each row is processed exactly once. The sum of `expiredCount + webhookRecoveredCount + errorCount` across both runs equals N. No duplicate Stripe `cancel` calls per PI (verifiable via mock spy).

### Fix #7 — Refund tracks net (captured) amount, not gross
**File:** `src/registration/services/RefundService.ts`

`refundAmount = reg.netAmountCents ?? reg.grossAmountCents` is now used in:
- Full refund path (single + bulk)
- Partial refund "remaining balance" calculation

**Verify:**
1. Seed a confirmed registration with `gross_amount_cents = 5000` and `net_amount_cents = 4900` (simulating a hypothetical partial-capture).
2. Issue a full refund. Confirm Stripe `refunds.create` is called with no `amount` param. Confirm DB `refunded_amount_cents` is set to `4900`, not `5000`.
3. Confirm the refund-confirmation email reports `4900`.
4. With `gross = net = 5000` (normal case), behavior is unchanged.

### Fix #8 — Supercronic SHA1 verification
**File:** `Dockerfile`

The supercronic download is now verified against the upstream-published SHA1.

**Verify:**
1. `docker build .` succeeds.
2. Tamper with `SUPERCRONIC_SHA1` env in the Dockerfile (change one character) → build fails with `sha1sum -c` mismatch.

### Fix #9 — `sp_fail_registration` row lock
**File:** `db/migrations/005_registration_schema.sql`

Added `FOR UPDATE` to the registration row read in `sp_fail_registration`. Same
concurrency test pattern as Fix #2.

### Fix #10 — Scan 3 SKIP LOCKED
**File:** `src/registration/services/ReconciliationService.ts`

Scan 3 (email retry) now uses the same per-row transaction + SKIP LOCKED
pattern as scans 1 and 2.

**Verify:**
1. Seed a `CONFIRMED` registration with `confirmation_email_sent_at IS NULL`.
2. Run two reconciliation sweeps concurrently (advisory lock disabled for the test).
3. Expected: exactly one email send. The notification mock is invoked once.

### Fix #11 — Anomalous `succeeded` PI is logged, not expired
**File:** `src/registration/services/ReconciliationService.ts`

If a `PENDING_PAYMENT` registration's PI is in Stripe state `succeeded`,
reconciliation now logs an error and skips the row instead of expiring it.

**Verify:**
1. Seed a `PENDING_PAYMENT` registration. Stub Stripe to return `pi.status = 'succeeded'` for its PI.
2. Run reconciliation. Confirm the registration's status remains `PENDING_PAYMENT` (not `EXPIRED`). Confirm `result.errorCount` increments by 1. Confirm a console.error is emitted with "anomaly".

### Fix #12 — Distributed advisory lock
**File:** `src/registration/services/ReconciliationService.ts`

The full sweep is gated by `pg_try_advisory_lock(0x52454330)` on a reserved
connection. If the lock can't be acquired, the sweep returns an empty result
without doing work.

**Verify:**
1. Run two reconciliation sweeps concurrently in two processes.
2. Expected: only one process performs the actual scans; the other logs "another worker holds the advisory lock; skipping sweep" and returns counts of zero.
3. After the first completes, a third sweep can acquire the lock and run.
4. Confirm `pg_advisory_unlock` is called even when scans throw (use a fault-injection in `runScan1` to verify the `finally` releases the lock — otherwise subsequent sweeps would hang).

### Fix #14 — Input validation
**Files:** `src/web/controllers/registration.ts`

`validateRegistrationFields` checks presence + max-length on `email`,
`firstName`, `lastName`, `phone` for both `POST /events/:id/register` and
`POST /events/:id/waitlist`. Email is validated for `@` only — no regex —
because the client form re-enters the email twice.

**Verify:**
1. Empty `firstName` → 400 with `field: "firstName"`, `reason: "missing"`.
2. `firstName` length 200 → 400 with `reason: "exceeds max length 100"`.
3. `email` without `@` → 400.
4. Whitespace-only fields → 400 (trimmed).
5. Unicode names like `José Ñúñez` → succeed (length check after trim).
6. Same checks apply to waitlist endpoint.

### Fix #15 — `sp_restore_slot_on_capture_failure` invariant guard
**File:** `db/migrations/005_registration_schema.sql`

Added `confirmed_count > 0` guard returning `INVARIANT_VIOLATION` instead of
letting the CHECK constraint surface as an unhandled SQL exception.

**Verify:**
1. Seed a registration in `PENDING_CAPTURE` against an event with `confirmed_count = 0` (manually corrupt state for the test).
2. Call `sp_restore_slot_on_capture_failure('pi_x')`.
3. Expected return: `INVARIANT_VIOLATION` (not a CHECK constraint error).

---

## Out of scope for this round of fixes

The reviewer flagged but the maintainer deferred:
- **#13 (no auth on confirmation page):** Acceptable risk for a small-scale public registration site. Can revisit if it scales.
- **#16 (idempotency key uses randomUUID):** Stripe retry dedup is degraded, but acceptable for current volume.
- **#17 (webhook controller new Stripe instance per request):** Cosmetic.
- **#18 (reconciliation metric counter granularity):** Cosmetic.
- **#19 (duplicate service singletons in two controllers):** Cosmetic.
- **#20 (test infrastructure):** Larger project — the existing increment-N tests were retained as-is.
- **#21 (no `migrate:down`):** Schema is not yet deployed; rollback script can be added when the migration approach is finalized.
- Reviewer's Item 13 (cutoff measured from `created_at` not `PENDING_CAPTURE` entry time): Maintainer indicated not a current priority.

---

## Smoke test for end-to-end registration

After all fixes are applied and the existing test suite passes, run a manual
end-to-end:

1. Boot the app with `STRIPE_SECRET_KEY` (test mode), `STRIPE_PUBLISHABLE_KEY`,
   `STRIPE_WEBHOOK_SECRET` set.
2. Create a test event via SQL.
3. Visit `/events/<id>/register`, fill the form, complete payment with Stripe
   test card `4242424242424242`. Expect redirect to `/registration/<id>/confirmed`.
4. Verify in DB: registration is `CONFIRMED`, event `confirmed_count` is `1`,
   `available_slots` decremented, `net_amount_cents` is set.
5. Test the failure path with card `4000000000009995` (declined).
6. Issue a refund via the RefundService and confirm DB + Stripe both reflect
   the refund.
