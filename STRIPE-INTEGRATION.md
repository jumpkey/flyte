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

## Required Environment Variables

```
STRIPE_SECRET_KEY=sk_test_...          # Stripe secret key
STRIPE_PUBLISHABLE_KEY=pk_test_...     # Stripe publishable key (used in frontend)
STRIPE_WEBHOOK_SECRET=whsec_...        # Webhook signing secret
STRIPE_API_TIMEOUT_MS=10000            # Stripe API timeout (milliseconds)
REGISTRATION_TTL_MINUTES=30            # Expiry time for PENDING_PAYMENT registrations
CAPTURE_MAX_RETRIES=5                  # Max capture retry attempts before restoring slot
```

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

The reconciliation runner (`src/registration/reconciliation-runner.ts`) is scheduled via supercronic every 5 minutes in production.

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
