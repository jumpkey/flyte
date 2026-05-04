# Stripe Two-Phase Commit Payment Workflow
## Personal Reference: Auth-Hold → Fulfillment → Capture over Constrained Inventory

---

## The Problem Being Solved

When selling a resource-constrained item (limited inventory, finite seats, unique goods), a naive checkout flow has a race condition:

1. Customer pays → charge succeeds
2. You try to decrement inventory → already gone
3. You refund the customer → bad experience, operational mess

What you actually want is a **two-phase commit**:

1. **Prepare:** Reserve the customer's funds AND atomically hold the inventory unit
2. **Commit:** Only charge the card once you've confirmed you can fulfill
3. **Abort:** If you can't fulfill, release both the card hold and the inventory reservation — customer sees no charge

Stripe's `capture_method: manual` on a PaymentIntent is the mechanism that makes this possible.

---

## Key Concepts

### PaymentIntent

A PaymentIntent is the central object in Stripe's modern payment API. It represents a single payment attempt from creation through resolution. One PaymentIntent per order/session. Its `status` field is a state machine that tracks exactly where in the payment lifecycle you are.

### Authorization vs. Capture

When a card is charged, two things happen that can be separated:

- **Authorization:** The card network confirms the funds exist and places a **hold** on the customer's account. The customer sees a pending charge. No money has moved.
- **Capture:** Money actually moves from the customer to you.

By default, Stripe captures immediately after authorization (`capture_method: automatic`). Setting `capture_method: manual` separates these into two distinct API calls you control.

### `client_secret`

When you create a PaymentIntent server-side, Stripe returns a `client_secret`. This is a scoped credential you pass to the browser so the frontend can confirm the payment directly with Stripe without routing card data through your server. Treat it like a short-lived token: don't log it, don't embed it in URLs, only transmit it over TLS, only send it to the customer whose order it belongs to.

### Webhooks

Stripe's payment flow is asynchronous. Authentication steps (3D Secure, bank redirects) can take time, and you can't block your server waiting for them. Instead, Stripe fires webhook events to your server as state transitions happen. Your webhook handler is where your business logic runs in response to payment events. This is not optional — it is the correct integration point for inventory locking and capture.

---

## PaymentIntent State Machine (manual capture)

```
[created]
  → [requires_payment_method]    ← waiting for customer to enter card
  → [requires_confirmation]      ← payment method attached, not yet confirmed
  → [requires_action]            ← 3DS challenge, bank redirect, wallet auth
                                   (Stripe/browser handles this automatically)
  → [requires_capture]           ← AUTH SUCCEEDED. Your window to act.
  → [succeeded]                  ← you called /capture. Money moved.
  → [canceled]                   ← you called /cancel, OR auth window expired
```

The `requires_capture` status is your critical section. When the PI enters this state, Stripe fires the `payment_intent.amount_capturable_updated` webhook. That webhook is your trigger to lock inventory and begin fulfillment.

**Authorization window:** Online card payments hold for **7 days** by default. You must capture before expiry or the auth lapses, funds are released, and status becomes `canceled` automatically. Extended holds are available for some card types. If your fulfillment pipeline can exceed 7 days (pre-orders, made-to-order), you need either extended auth or a different pattern (Setup Intent + delayed charge).

---

## The Two Checkout Surfaces

Stripe provides two frontend UI elements. Both use the same server-side logic behind them — they differ only in how the customer interacts on the frontend.

### 1. Payment Element (standard checkout form)

The general-purpose embedded checkout UI. Renders a form the customer fills in with card details, bank account, etc. Supports all payment methods your Stripe account has enabled. The customer clicks your "Pay" button, which triggers `stripe.confirmPayment()`.

### 2. Express Checkout Element (ECE)

Renders native wallet buttons: Apple Pay, Google Pay, Link, PayPal. The payment sheet is owned by the wallet/browser, not your page. The customer authenticates within the native wallet UX. The `confirm` event fires on your element when the customer approves, and you call `stripe.confirmPayment()` in that handler.

**Critical ECE difference:** You must have the `client_secret` in hand *before* mounting the Express Checkout button, because the wallet sheet can complete instantly. For the standard Payment Element you fetch it on page load anyway, but for ECE it's a hard requirement.

---

## Integration Architecture

### Frontend Responsibilities (both surfaces)

1. On page/component load, call your server to create (or retrieve) the PaymentIntent and get back the `client_secret`
2. Initialize Stripe.js with your **publishable key** and the `client_secret`
3. Mount the appropriate Stripe element (`payment` or `expressCheckout`)
4. On customer confirmation, call `stripe.confirmPayment()` — Stripe handles 3DS/redirects
5. After confirmation, show a status page (you can read PI status from the URL params on return, or poll your own server)

Your frontend never touches card data. Stripe.js handles tokenization entirely. Your publishable key is safe to embed in client-side code.

### Server Responsibilities

Everything that matters happens server-side:

- **Create the PaymentIntent** with `capture_method: manual`
- **Receive and verify webhooks** from Stripe
- **Lock inventory** atomically when `requires_capture` is reached
- **Run fulfillment** after the lock
- **Capture or cancel** the PaymentIntent based on fulfillment outcome

---

## Server-Side Implementation: What to Build

### Endpoint 1: Create PaymentIntent

```
POST /checkout/intent
```

- Receives: order ID, amount (in cents/smallest currency unit)
- Creates PaymentIntent via Stripe API:
  - `amount`: in smallest currency unit (e.g., 4999 for $49.99)
  - `currency`: e.g., `"usd"`
  - `capture_method`: `"manual"` — the key flag
  - `metadata`: `{ order_id: "..." }` — survives into all webhook payloads; how you correlate Stripe events back to your orders
  - `idempotency_key`: e.g., `"pi-create-{order_id}"` — safe to retry on network failure
- Returns: `{ client_secret: "pi_xxx_secret_xxx" }` to the frontend
- Never returns the full PI object; never logs the client_secret

```python
# Python / stripe-python example
intent = stripe.PaymentIntent.create(
    amount=4999,
    currency="usd",
    capture_method="manual",
    metadata={"order_id": order_id},
    idempotency_key=f"pi-create-{order_id}",
)
return {"client_secret": intent.client_secret}
```

### Endpoint 2: Webhook Handler

```
POST /stripe/webhook
```

Stripe calls this endpoint as payment state changes. Critical implementation requirements:

**Signature verification (mandatory):**
```python
event = stripe.Webhook.construct_event(
    request.data,                        # raw bytes — NOT parsed JSON
    request.headers["Stripe-Signature"],
    "whsec_..."                          # your webhook signing secret from Stripe Dashboard
)
```
If you use body-parsing middleware globally (e.g., `express.json()`), it will consume the raw body and signature verification will fail. The webhook endpoint must receive raw bytes.

**Events to handle:**

| Event | Action |
|---|---|
| `payment_intent.amount_capturable_updated` | PI entered `requires_capture`. Lock inventory, begin fulfillment. |
| `payment_intent.succeeded` | Capture completed. Finalize order, notify customer. |
| `payment_intent.payment_failed` | Clean up any partial state. |
| `payment_intent.canceled` | Release inventory hold if applicable. |

**Idempotency in the webhook handler:**

Stripe will retry webhooks for up to 3 days if your endpoint doesn't return 2xx. The same event *will* be delivered more than once. Your handler must be idempotent:

```python
# Before processing any event:
if db.event_already_processed(event.id):
    return 200  # no-op

# After processing:
db.mark_event_processed(event.id)
```

Always return 2xx within 20 seconds. Do heavy work asynchronously (task queue) and return immediately if fulfillment is slow.

### Inventory Reservation Logic

Triggered from the `payment_intent.amount_capturable_updated` handler:

```python
def handle_authorized(pi_id, order_id, amount_capturable):
    # 1. Atomic reservation — idempotent on duplicate webhook delivery
    reserved = db.execute("""
        INSERT INTO reservations (order_id, pi_id, status)
        VALUES (%s, %s, 'reserved')
        ON CONFLICT (order_id) DO NOTHING
        RETURNING id
    """, (order_id, pi_id))

    if not reserved:
        return  # already handled this event

    # 2. Check availability
    if not inventory_available(order_id):
        stripe.PaymentIntent.cancel(pi_id,
            idempotency_key=f"pi-cancel-{order_id}")
        db.mark_reservation_canceled(order_id)
        notify_customer_out_of_stock(order_id)
        return

    # 3. Lock the unit
    db.hold_inventory_unit(order_id)  # e.g., held = held + 1

    # 4. Begin fulfillment
    fulfill_order(order_id, pi_id)
```

### Capture (after successful fulfillment)

```python
def capture_payment(pi_id, order_id):
    stripe.PaymentIntent.capture(
        pi_id,
        idempotency_key=f"pi-capture-{order_id}",
        # amount_to_capture=final_amount  # optional: capture less (or more for some cards)
    )
    db.decrement_inventory_permanently(order_id)  # held--, stock--
    db.mark_order_complete(order_id)
```

If capture call times out, retry with the same idempotency key — Stripe will return the cached result from the first execution.

---

## Client-Side Implementation: What to Build

### Standard Payment Element

```javascript
const stripe = Stripe("pk_test_...");  // publishable key — safe in client code

// 1. Get client_secret from your server
const { client_secret } = await fetch("/checkout/intent", {
  method: "POST",
  body: JSON.stringify({ order_id, amount }),
  headers: { "Content-Type": "application/json" },
}).then(r => r.json());

// 2. Initialize Elements
const elements = stripe.elements({ clientSecret: client_secret });

// 3. Mount the Payment Element
const paymentElement = elements.create("payment");
paymentElement.mount("#payment-element");

// 4. On form submit
const { error } = await stripe.confirmPayment({
  elements,
  confirmParams: {
    return_url: "https://yourapp.com/checkout/complete",
  },
  // For card payments that don't require redirect:
  // redirect: "if_required"
});

if (error) {
  // Show error to customer (card declined, validation error, etc.)
}
// On success: Stripe redirects to return_url (or resolves in-page if redirect: "if_required")
// PI is now in requires_capture — your webhook fires
```

### Express Checkout Element

```javascript
const stripe = Stripe("pk_test_...");

// CRITICAL: Must have client_secret BEFORE mounting — wallet sheet can fire instantly
const { client_secret } = await fetch("/checkout/intent", { method: "POST", ... })
  .then(r => r.json());

const elements = stripe.elements({ clientSecret: client_secret });

// Mount the Express Checkout button(s)
const expressCheckout = elements.create("expressCheckout", {
  buttonType: { applePay: "buy", googlePay: "buy" },
});
expressCheckout.mount("#express-checkout-element");

// Fires when customer approves in the native wallet sheet
expressCheckout.on("confirm", async (event) => {
  const { error } = await stripe.confirmPayment({
    elements,
    confirmParams: {},
    redirect: "if_required",   // wallet payments confirm in-place, no redirect
  });

  if (error) {
    event.paymentFailed({ reason: "fail" });  // tells the wallet sheet to show failure
  }
  // On success: PI enters requires_capture, webhook fires — same as standard checkout
});
```

---

## Idempotency: The Full Picture

Idempotency means "doing the same operation twice has the same effect as doing it once." It is not optional in a payments integration — networks fail, servers crash, webhooks retry. Every mutating operation needs an idempotency strategy:

| Operation | Strategy |
|---|---|
| `PaymentIntent.create()` | Stripe `Idempotency-Key` header: `"pi-create-{order_id}"` |
| `PaymentIntent.cancel()` | Stripe `Idempotency-Key` header: `"pi-cancel-{order_id}"` |
| `PaymentIntent.capture()` | Stripe `Idempotency-Key` header: `"pi-capture-{order_id}"` |
| Inventory reservation | `INSERT ... ON CONFLICT (order_id) DO NOTHING` |
| Webhook handler | Check `event.id` in DB before processing |

Stripe caches the response to the first execution for a given idempotency key and returns the same response to all retries with that key — including 500 errors. If a request got a 4xx (bad params), generate a new idempotency key for the corrected request.

Use V4 UUIDs or a deterministic string like `"{action}-{order_id}"` — whatever makes the scope unambiguous.

---

## The Complete State Machine (Your Application's View)

```
Customer submits payment
        │
        ▼
  Stripe authorizes card ──── fails ────► Show error. Nothing touched in your DB.
        │
        ▼ webhook: payment_intent.amount_capturable_updated
  ┌─────────────────────────────────────────┐
  │ YOUR CRITICAL SECTION                   │
  │                                         │
  │ Atomic INSERT reservation               │
  │ (ON CONFLICT DO NOTHING for idempotency)│
  └─────────────────────────────────────────┘
        │
   ┌────┴────────────────────────┐
   │ inventory unavailable       │ inventory available
   ▼                             ▼
Cancel PI                   Lock inventory unit (held++)
Release customer hold       Begin fulfillment
Notify customer                  │
                        ┌────────┴─────────────┐
                        │ fulfillment fails     │ fulfillment succeeds
                        ▼                       ▼
                  Cancel PI              Capture PI (idempotent)
                  Release hold           Decrement stock permanently
                                         Mark order complete
                                              │
                                              ▼
                                   webhook: payment_intent.succeeded
                                   Send confirmation to customer
```

---

## Payment Methods: Not All Support Manual Capture

Only certain payment methods support separate authorization and capture. Design your checkout UI to only offer manual-capture-compatible methods when using this pattern.

**Supported:** Cards (Visa, MC, Amex, Discover), Affirm, Afterpay/Clearpay, Cash App Pay, Klarna, PayPal

**Not supported:** ACH Direct Debit, iDEAL, SEPA Debit, and most bank transfer methods

Each supported method has its own auth window:
- **Cards:** 7 days online, 2 days in-person Terminal
- **Affirm:** 30 days
- **Afterpay:** 13 days
- **Cash App Pay:** 7 days

---

## Edge Cases and Failure Modes to Know

### Auth window expiry
If your fulfillment pipeline takes longer than the auth window, the PI auto-cancels and no charge occurs. The customer's hold is released. You need to either:
- Use extended auth (supported on some card types, requires Stripe to enable)
- Switch to a Setup Intent + separate PaymentIntent pattern for long lead times

### Webhook out-of-order delivery
Stripe does not guarantee webhook delivery order. A `payment_intent.succeeded` event could theoretically arrive before `payment_intent.amount_capturable_updated` in pathological cases. Design your handler to be resilient: check PI status directly from Stripe if needed.

### Stripe 500 errors
Treat 5xx responses from Stripe API calls as **indeterminate** — the operation may or may not have executed. Stripe will attempt reconciliation and may fire webhooks retroactively. Always use the webhook event stream as the source of truth for payment state, not synchronous API response codes alone.

### Partial capture
Stripe supports capturing a different amount than was authorized (within limits):
- Capture **less**: always allowed (e.g., item was actually cheaper)
- Capture **more**: allowed on some card types if you increment the authorization first

Use `amount_to_capture` on the capture call, or `stripe.PaymentIntent.increment_authorization()` before capture for overcapture.

### Metadata as correlation
Always put your `order_id` in the PI's `metadata`. This is how you tie a Stripe event back to your order when the webhook fires — the PI ID alone isn't sufficient because you may not have stored it yet when the event arrives from Stripe.

---

## Stripe API Reference Links

- Manual capture (place a hold): https://docs.stripe.com/payments/place-a-hold-on-a-payment-method
- PaymentIntents API overview: https://docs.stripe.com/payments/payment-intents
- PaymentIntent lifecycle: https://docs.stripe.com/payments/paymentintents/lifecycle
- PaymentIntent API reference: https://docs.stripe.com/api/payment_intents
- Capture API reference: https://docs.stripe.com/api/payment_intents/capture
- Express Checkout Element: https://docs.stripe.com/elements/express-checkout-element
- Webhook best practices: https://docs.stripe.com/webhooks/best-practices
- Idempotent requests: https://docs.stripe.com/api/idempotent_requests
- Error handling: https://docs.stripe.com/error-low-level
- Extended holds: https://docs.stripe.com/payments/extended-authorization
