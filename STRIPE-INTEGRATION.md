# Stripe Integration

## Architecture Overview

The registration payment flow uses Stripe's **two-phase authorization/capture** pattern:

1. **Phase 1 — Authorization**: A `PaymentIntent` with `capture_method: 'manual'` is created. The customer's card is authorized (funds held) but not charged.
2. **Phase 2 — Capture**: After the webhook `payment_intent.amount_capturable_updated` fires (or client-side confirmation), the server acquires a slot in the DB and captures the funds.

### State Machine

```
PENDING_PAYMENT → PENDING_CAPTURE → CONFIRMED
                ↘                 ↘ PAYMENT_FAILED
                  EXPIRED           CANCELLED
```

### Key Services

| Service | Purpose |
|---|---|
| `RegistrationService` | Orchestrates initiation, authorization, capture, and failure handling |
| `EventAvailabilityService` | Reads event availability and waitlist counts |
| `WaitlistService` | Manages waitlist entries |
| `RefundService` | Full and partial refunds via Stripe |
| `ReconciliationService` | Background sweep: expires stale records, retries captures, re-sends emails |
| `NotificationService` | Sends confirmation/waitlist/refund emails via SMTP |

### Database Stored Procedures

All critical state transitions are performed inside PostgreSQL stored procedures to ensure atomicity:

- `sp_initiate_registration` — creates registration record
- `sp_acquire_slot_and_stage_capture` — decrements available_slots, transitions to PENDING_CAPTURE
- `sp_finalize_registration` — transitions to CONFIRMED
- `sp_restore_slot_on_capture_failure` — restores slot on capture failure
- `sp_cancel_registration` — full refund + cancellation
- `sp_partial_refund_registration` — partial refund
- `sp_expire_registration` — expires stale PENDING_PAYMENT records
- `sp_fail_registration` — marks registration as PAYMENT_FAILED
- `sp_increment_capture_attempt` — tracks retry count
- `sp_mark_confirmation_email_sent` — idempotency for email sending

## Stubbed Mode vs Live Mode

**Without Stripe keys** (development): The registration routes will return a 500 error when Stripe is not configured. To test registration UI without Stripe, set `STRIPE_SECRET_KEY=sk_test_...` with a valid test key.

**With test keys**: Use Stripe's test card numbers (e.g., `4242 4242 4242 4242`) to simulate payments.

**With live keys**: Set `STRIPE_SECRET_KEY=sk_live_...` and configure webhook endpoint.

> **Going live on Fly.io:** the complete pre-merge checklist — live-mode key
> and webhook setup, required Fly secrets, the auto-deploy-on-merge flow, and
> a live smoke test — is in **`DEPLOYMENT-CHECKLIST.md`**. Live mode requires
> live keys, a live-mode dashboard webhook endpoint, and that endpoint's own
> `whsec_` signing secret (test-mode and Stripe CLI secrets will not verify
> live events).

## Required Environment Variables

```
STRIPE_SECRET_KEY=sk_test_...          # Stripe secret key
STRIPE_PUBLISHABLE_KEY=pk_test_...     # Stripe publishable key (used in frontend)
STRIPE_WEBHOOK_SECRET=whsec_...        # Webhook signing secret
STRIPE_API_TIMEOUT_MS=10000            # Stripe API timeout (milliseconds)
REGISTRATION_TTL_MINUTES=30            # Expiry time for PENDING_PAYMENT registrations
CAPTURE_MAX_RETRIES=5                  # Max capture retry attempts before restoring slot
```

### Optional: Stripe Simulator Override

For load testing and integration tests, redirect all Stripe API calls to a local simulator:

```
STRIPE_SIMULATOR_HOST=localhost        # Simulator hostname
STRIPE_SIMULATOR_PORT=12111            # Simulator port (default: Stripe default)
STRIPE_SIMULATOR_PROTOCOL=http         # Protocol (default: https)
```

Both the main app and the reconciliation runner honour these variables via `stripe-factory.ts`.

## Frontend

The registration page's payment script lives at
`public/js/registration-form.js` (served from `/public/js/registration-form.js`,
covered by the CSP's `script-src 'self'`). It is intentionally **not** inlined
in the EJS view: the CSP does not allow `'unsafe-inline'` scripts. If you
change the payment flow, edit the static file — do not add inline `<script>`
blocks to the views.

## Webhook Setup

The webhook endpoint is: `POST /webhooks/stripe`

This route is registered **before** CSRF middleware so it receives the raw request body for signature verification.

Events handled:
- `payment_intent.amount_capturable_updated` → triggers slot acquisition and capture
- `payment_intent.payment_failed` → marks registration as PAYMENT_FAILED

## Reconciliation Job

The `ReconciliationService` performs three sweeps:

1. **Expire stale PENDING_PAYMENT**: Registrations older than `REGISTRATION_TTL_MINUTES` are expired. If the PI is in `requires_capture`, a missed webhook recovery is attempted.
2. **Retry PENDING_CAPTURE**: Uses exponential backoff. After `CAPTURE_MAX_RETRIES`, the slot is restored.
3. **Re-send unsent confirmation emails**: For CONFIRMED registrations missing `confirmation_email_sent_at`.

The reconciliation runner (`src/registration/reconciliation-runner.ts`) is scheduled via supercronic every 5 minutes in production. It uses `stripe-factory.ts` for Stripe client construction (honouring simulator overrides) and cleanly closes the database connection pool on exit.

## How to Run Tests

Run the migration first:
```bash
npm run migrate
```

Run individual test files:
```bash
npx tsx src/registration/testing/increment-1.test.ts
npx tsx src/registration/testing/increment-3.test.ts
# ... etc
```

Run all tests:
```bash
npx tsx src/registration/testing/run-all-tests.ts
```

## Rate Limiting

Registration endpoints (`POST /events/:id/register`, `POST /registration/confirm/:piId`,
`POST /events/:id/waitlist`) are rate-limited to **60 requests per 60 seconds per IP**.

When the limit is exceeded, the middleware retries with random backoff (500ms–2s) up to
3 times before returning HTTP 429. This absorbs brief legitimate traffic spikes without
surfacing errors to the customer. Only sustained abuse triggers a hard rejection.

## Manual Verification Steps

1. Create a test event in the database:
```sql
INSERT INTO events (name, event_date, total_capacity, confirmed_count, available_slots, registration_fee_cents)
VALUES ('Test Event', now() + interval '30 days', 10, 0, 10, 5000);
```

2. Visit `/events/<event_id>/register` — should show registration form

3. Fill in participant info → Continue to Payment

4. Use Stripe test card `4242 4242 4242 4242` — should confirm and redirect to `/registration/<id>/confirmed`

5. Visit `/events/<event_id>/waitlist` to test waitlist flow

6. Test webhook with Stripe CLI:
```bash
stripe listen --forward-to localhost:3000/webhooks/stripe
stripe trigger payment_intent.amount_capturable_updated
```

---

## Disabling Stripe Link (CRITICAL — privacy)

**Symptom.** On a browser where one user previously checked out, the Payment
Element offers *that* user's saved card to a *different* logged-in Flyte user
(or a guest). Reported in pilot round 2: logged in as Alice Adams, checkout
surfaced leb@jumpkey's stored Visa.

**Root cause.** Stripe **Link** is a wallet, and per Stripe's documentation you
**cannot exclude Link per transaction** via `payment_method_types` /
`excluded_payment_method_types`. Link's "returning user" recognition is keyed to
a **browser-level session on Stripe's own domain (js.stripe.com)** — it has no
relationship to Flyte's login. So `payment_method_types: ['card']` (our W1 fix)
restricts payment-method *types* but does **not** remove Link, and the browser's
remembered Link account leaks across Flyte users on the same machine. There is
**no client-side Stripe.js option to disable Link in the Payment Element.**

Refs: https://docs.stripe.com/payments/link/payment-element-link ·
https://support.stripe.com/questions/how-do-i-turn-off-payment-methods

**Fix — do BOTH:**

1. **Account toggle (authoritative, required — do this now).**
   Stripe Dashboard → **Settings → Payment methods → Link → turn Off**, for the
   account whose keys are deployed (test *and* live). This is the only switch the
   Payment Element fully honors; it immediately stops any saved Link card from
   surfacing for anyone.

2. **Code-enforced per-PaymentIntent (deterministic, survives account drift).**
   Create a **Payment Method Configuration** with Link disabled and card on, then
   set its id as an env var:
   ```bash
   # one-time: create a Link-off configuration
   curl https://api.stripe.com/v1/payment_method_configurations \
     -u "$STRIPE_SECRET_KEY:" \
     -d name='Flyte (card only, no Link)' \
     -d 'card[display_preference][preference]=on' \
     -d 'link[display_preference][preference]=off'
   # → returns pmc_xxx
   fly secrets set STRIPE_PAYMENT_METHOD_CONFIGURATION=pmc_xxx
   ```
   When `STRIPE_PAYMENT_METHOD_CONFIGURATION` is set, `RegistrationService` pins
   that PMC on every PaymentIntent (`payment_method_configuration`) instead of
   `payment_method_types`, so Link is excluded at the configuration level
   regardless of the account default. When unset, it falls back to card-only
   `payment_method_types: ['card']` (unchanged behavior).

**Alternative (pure client-side, no Dashboard dependency).** Switch the checkout
from the Payment Element to the **Card Element**, which supports
`disableLink: true`. That is a larger checkout refactor (different confirm flow)
and is tracked as an option, not yet implemented.
