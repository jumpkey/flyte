# Stripe Payment Workflow: Two-Phase Commit over Constrained Inventory

## Purpose

This document briefs an implementation agent on the Stripe integration pattern required to build an **approval → fulfillment → finalization** checkout workflow. The pattern uses Stripe's manual capture feature to implement a two-phase commit over a constrained inventory resource, ensuring atomicity and idempotency when decrementing stock during purchase.

A complete working reference implementation is available on the Stripe documentation site at:
**https://docs.stripe.com/payments/place-a-hold-on-a-payment-method**

---

## Core Concept

Stripe's PaymentIntent API supports separating **authorization** (card hold) from **capture** (actual charge) via `capture_method: manual`. This maps directly to a two-phase commit:

| Phase | Stripe Mechanism | Application Action |
|---|---|---|
| **Prepare** | Card authorized → `requires_capture` status | Atomically reserve inventory in DB |
| **Commit** | Call `/capture` on the PaymentIntent | Decrement inventory, fulfill, finalize charge |
| **Abort** | Call `/cancel` on the PaymentIntent | Release reservation, no charge to customer |

---

## PaymentIntent Lifecycle (with manual capture)

```
[created]
  → [requires_payment_method]
  → [requires_confirmation]
  → [requires_action]          ← 3DS / bank redirect / wallet auth (Stripe handles)
  → [requires_capture]         ← YOUR CRITICAL WINDOW: lock inventory here
  → [succeeded]                ← after your server calls /capture
  → [canceled]                 ← if you call /cancel, or auth window expires
```

**Authorization window:** Online card payments are held for 7 days by default. Extended holds are available for eligible card types. The auth **must** be captured before expiry or it lapses and status becomes `canceled`. Design fulfillment pipelines accordingly.

---

## What Needs to Be Built

### Server-Side Components

#### 1. PaymentIntent Creation Endpoint
- Accepts order details (order ID, amount in smallest currency unit)
- Creates a PaymentIntent with `capture_method: "manual"`
- Attaches `metadata: { order_id: "..." }` so the order ID survives into webhook payloads
- Uses an **idempotency key** tied to the order ID on the Stripe API call (safe retry on network failure)
- Returns only the `client_secret` to the frontend — never log or expose it further
- The `client_secret` is what the frontend uses to confirm the payment

#### 2. Webhook Handler Endpoint
- Receives and **verifies** Stripe webhook signatures before processing (using the raw request body, not parsed JSON)
- Handles at minimum these events:
  - `payment_intent.amount_capturable_updated` — fired when PI enters `requires_capture`; this is the trigger for inventory locking and fulfillment
  - `payment_intent.succeeded` — fired after successful capture; use for order finalization
  - `payment_intent.payment_failed` — clean up any partial state
  - `payment_intent.canceled` — release inventory hold if applicable
- Must be **idempotent**: the same Stripe event may be delivered more than once. Store processed `event.id` values and no-op on duplicates.
- Must return a 2xx response within 20 seconds, or Stripe retries delivery (with exponential backoff for up to 3 days).

#### 3. Inventory Reservation Logic (triggered by webhook)
- Called from the `payment_intent.amount_capturable_updated` handler
- Atomically reserves the inventory item using an `INSERT ... ON CONFLICT (order_id) DO NOTHING` pattern (or equivalent) — this is the idempotency guard for duplicate webhook delivery
- If inventory is **unavailable**: call Stripe `/cancel` on the PaymentIntent (with its own idempotency key), mark the reservation as canceled, notify the customer
- If inventory is **available**: place a hold (e.g., increment a `held` counter), then trigger fulfillment

#### 4. Fulfillment Logic
- Runs after inventory is successfully reserved
- Domain-specific: shipping, license key generation, service provisioning, etc.
- On success: calls Stripe `/capture` on the PaymentIntent (with idempotency key), then permanently decrements inventory and marks the order complete
- On failure: calls Stripe `/cancel`, releases the inventory hold

#### 5. Capture Call
- `POST /v1/payment_intents/{id}/capture`
- Must use an idempotency key scoped to the order (safe to retry on timeout)
- Can optionally pass `amount_to_capture` if the final amount differs from the authorized amount (e.g., weight-based pricing)

### Client-Side Components

Two checkout surfaces are required. Both share the same server-side webhook and capture logic — they differ only in frontend presentation.

#### Standard Checkout (Stripe Elements — Payment Element)
- Fetches `client_secret` from the server
- Mounts the Stripe `payment` Element into the page
- Calls `stripe.confirmPayment()` on form submission
- After confirmation, Stripe transitions the PI to `requires_capture` and fires the webhook
- Handle both redirect-based (default) and in-page (`redirect: "if_required"`) confirmation flows

#### Express Checkout (Apple Pay, Google Pay, Link, PayPal)
- Uses the Stripe `expressCheckout` Element
- `client_secret` must be obtained from the server **before** mounting the button
- Listens for the `confirm` event on the element, then calls `stripe.confirmPayment()` with `redirect: "if_required"`
- Calls `event.paymentFailed()` if confirmation fails
- No other frontend differences — the same server-side webhook handles the rest

---

## Idempotency Requirements (Summary)

Every mutating operation must be made safe for retry:

| Operation | Idempotency Mechanism |
|---|---|
| Create PaymentIntent | Stripe `Idempotency-Key` header: `"pi-create-{order_id}"` |
| Cancel PaymentIntent | Stripe `Idempotency-Key` header: `"pi-cancel-{order_id}"` |
| Capture PaymentIntent | Stripe `Idempotency-Key` header: `"pi-capture-{order_id}"` |
| Inventory reservation | DB: `INSERT ... ON CONFLICT (order_id) DO NOTHING` |
| Webhook handler | DB: check `event.id` before processing; store after |

Stripe's idempotency layer caches the result of the first successful execution for a given key and returns the same response on retries.

---

## State Machine (Full Flow)

```
Customer submits payment (Elements or Express Checkout)
        │
        ▼
  Stripe authorizes card
        │
   ┌────┴────────────────────┐
   │ fails                   │ succeeds
   ▼                         ▼
Show error              payment_intent.amount_capturable_updated webhook
No inventory touched         │
                        Try atomic inventory reservation
                             │
                   ┌─────────┴──────────────┐
                   │ unavailable             │ available
                   ▼                         ▼
             Cancel PI                  Lock inventory (held++)
             Notify customer            Run fulfillment
                                             │
                                   ┌─────────┴──────────┐
                                   │ fails               │ succeeds
                                   ▼                     ▼
                             Cancel PI             Capture PI
                             Release hold          Decrement stock permanently
                                                   Mark order complete
                                                        │
                                                        ▼
                                              payment_intent.succeeded webhook
                                              Final order confirmation to customer
```

---

## Key Constraints and Edge Cases to Handle

- **Auth window expiry:** If fulfillment takes longer than 7 days (e.g., pre-orders), the auth lapses automatically and status becomes `canceled`. Either use extended holds where supported, or use a Setup Intent + delayed charge pattern for very long lead times.
- **Webhook ordering:** Events may arrive out of order. Use the `created` timestamp for ordering if needed; do not assume delivery sequence.
- **Partial capture:** Stripe supports capturing less than the authorized amount (and for some card types, more). Use `amount_to_capture` if the final price is determined post-authorization.
- **Payment method support:** Not all payment methods support manual capture. Cards, Affirm, Afterpay, Cash App Pay, Klarna, and PayPal do. ACH and iDEAL do not. Design the checkout UI accordingly.
- **Webhook signature verification:** Always verify using the raw request body. Middleware that parses JSON before the raw body is read will break signature verification.
- **5xx from Stripe:** Treat as indeterminate. Stripe will attempt reconciliation and may fire webhooks retroactively. Always rely on webhook events as the source of truth for payment state, not synchronous API responses alone.

---

## Reference Links

- Stripe manual capture (place a hold): https://docs.stripe.com/payments/place-a-hold-on-a-payment-method
- PaymentIntents API overview: https://docs.stripe.com/payments/payment-intents
- PaymentIntent lifecycle: https://docs.stripe.com/payments/paymentintents/lifecycle
- Express Checkout Element: https://docs.stripe.com/elements/express-checkout-element
- Idempotent requests: https://docs.stripe.com/api/idempotent_requests
- Webhook best practices: https://docs.stripe.com/webhooks/best-practices
- Capture API reference: https://docs.stripe.com/api/payment_intents/capture
