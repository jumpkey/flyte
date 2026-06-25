# Mahjracks Storefront — Design Notes

> **STATUS: DRAFT — First conversation only.**
> These notes were captured from an initial brainstorming session and represent
> a stream-of-thought exploration, not a considered specification. Much is
> tentative. Requirements are incomplete. Open questions outnumber answers.
> A proper specification document will follow once requirements are more fully
> worked through. Do not treat anything here as a build directive.

---

## Context and Intent

**mahjracks.com** currently exists as a static HTML site with images —
functionally a brochure. The intent is to evolve it into a working storefront
with order entry, payment processing, customer management, and back-end
operational tooling for a one-person custom woodworking shop (Four Woods /
Mahjracks) that builds and sells handcrafted mahjong tile racks.

The `ui-elaboration` branch of this repository contains a mature, nearly-complete
event-registration application. The proposition explored in this session is to
take that application as an **architectural exemplar** — not to fork its domain
logic, but to lift its structure, patterns, service layer discipline, payment
integration, email infrastructure, auth system, and deployment posture wholesale,
then repurpose the domain layer: **event registration becomes product ordering.**

The analogy is close enough to be genuinely useful:

| Event registration concept | Mahjracks storefront concept |
|---|---|
| An event (name, date, location, capacity, fee) | A product / rack configuration (style, size, price, lead time) |
| A registration (person, event, payment, status) | An order (person, product, specs, payment, status) |
| Slot availability / sold-out | Units on hand / sold-out or backlogged |
| Waitlist | Waitlist (same semantics) |
| Confirmation email | Order confirmation + build update emails |
| Refund workflow | Order cancellation / refund workflow |
| Admin panel | Admin panel + CRM/OM dashboard |

The existing application is also the founding exemplar for the Craklins.com
tournament-management project. The intent is that the auth layer, deployment
tooling, service patterns, and Stripe/Postmark integrations will be reusable
across all three applications.

---

## What This Is Not (Yet)

This document does not address:

- A finalised data model (schema changes are directional only)
- A complete route inventory
- UI wireframes or view specifications
- A shipping integration (carriers, label printing, tracking — all TBD,
  pending finding a discounted-rate shipping partner)
- A shopping cart implementation (noted as a future requirement; see below)
- A mobile-specific design pass
- A decision on whether mahjracks.com runs as a separate fly.io app or shares
  infrastructure with the Craklins deployment

---

## Architecture Overview

The inherited architecture from `ui-elaboration` is retained intact:

```
┌─────────────────────────────────────────────────────┐
│  Browser (HTMX + minimal JS)                        │
│  + React SPA at /admin/dashboard (new, see below)   │
└──────────────┬──────────────────────────────────────┘
               │  HTML fragments over HTTP (customer-facing)
               │  JSON over HTTP (admin dashboard API)
┌──────────────▼──────────────────────────────────────┐
│  Web App Layer (TypeScript / Hono)                  │
│  - Route handlers (controllers)                     │
│  - Server-side HTML rendering (EJS/Eta)             │
│  - Session management, CSRF protection              │
│  - Input validation                                 │
│  - JSON API endpoints for admin dashboard           │  ← new
└──────────────┬──────────────────────────────────────┘
               │  Internal function calls
┌──────────────▼──────────────────────────────────────┐
│  Service Layer (TypeScript)                         │
│  - OrderService         (was RegistrationService)   │
│  - ProductService       (was CatalogService/Events) │
│  - WaitlistService      (unchanged semantics)       │
│  - NotificationService  (new templates)             │
│  - ReconciliationService(retooled — see below)      │
│  - RefundService        (unchanged)                 │
│  - ContactService       (new)                       │  ← new
│  - CommunicationsService(new)                       │  ← new
└──────────────┬──────────────────────────────────────┘
               │  SQL via postgres.js, stored procedures
┌──────────────▼──────────────────────────────────────┐
│  PostgreSQL (fly.io managed)                        │
└─────────────────────────────────────────────────────┘
```

**Key constraint inherited and preserved:** The customer-facing site remains
server-rendered HTML with HTMX for interactivity. No client-side framework on
the public-facing side. The single exception is the admin CRM/OM dashboard
(see §Admin Dashboard below), where drag-and-drop Kanban interactivity justifies
a small React SPA.

---

## Reuse Assessment

### Carried over unchanged or near-unchanged (~70% of the codebase)

| Component | Notes |
|---|---|
| Auth system | Users, sessions, shadow accounts, login events, password reset — reuse verbatim |
| Shadow account pattern | Particularly valuable: manual contact entry creates a shadow user; website order auto-links via email match |
| Stripe infrastructure | `stripe-factory.ts`, webhook handler, two-phase payment plumbing — reuse, adjust flow (see §Payment) |
| Postmark / NotificationService | Infrastructure unchanged; email templates rewritten for order domain |
| WaitlistService | Semantics identical — "sold out, join waitlist" |
| RefundService | Unchanged |
| Reconciliation runner | Architecture preserved; purpose shifts (see §Reconciliation) |
| fly.io deployment | `fly.toml`, Dockerfile, multi-stage build — reuse |
| Docker Compose local dev | Unchanged |
| Migration toolchain | dbmate sequential `.sql` files — continue |
| CSRF / session middleware | Unchanged |
| Request/action logging | Unchanged |
| `attributes JSONB` column | Already designed as an extension point; becomes the rack specification carrier |

### Needs domain adaptation

| Component | Change |
|---|---|
| `events` table | Becomes `products` — no date/location/capacity in the same sense (see §Schema) |
| `registrations` table | Becomes `orders` — richer status machine, deposit+balance payment, shipping fields |
| `catalog.ts` controller | Event browsing → product browsing; same HTMX pagination pattern |
| `registration.ts` controller | Becomes `order.ts`; richer configuration flow (wood, size, finish, magnets) |
| ReconciliationService | Shifts from "recover stuck payment intents" to "flag orders needing attention / build queue aging" |
| NotificationService templates | All email templates rewritten for order domain |

### Net new

| Component | Notes |
|---|---|
| `contacts` table | Pre-order inquiries — people who've reached out but haven't ordered |
| `communications` table | Log of email/phone/in-person interactions per contact or order |
| `ContactService` | CRUD + aging queries |
| `CommunicationsService` | Interaction log management |
| Admin CRM/OM dashboard | React SPA at `/admin/dashboard`; Kanban + aging view (see §Admin Dashboard) |
| Shipping integration | TBD — not designed |
| Shopping cart | TBD — not designed; see §Future Considerations |

---

## Domain Model (Directional — Not Final)

### Products (`events` → `products`)

An event in the existing schema has a date, location, capacity, and fee. A
Mahjracks product has a style (plain wood vs. artisan end-grain), a nominal
size (regular/oversized/travel/custom), a base price, and a build lead time.
Capacity is replaced by an on-hand count — units built in advance if any,
otherwise zero and the product is a pure custom-to-order item.

**Directional schema change (not final, not migration-ready):**

```sql
-- events becomes products
CREATE TABLE products (
    product_id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT        NOT NULL,          -- e.g. "Artisan End-Grain Oversized Rack Set"
    description         TEXT,
    style               TEXT        NOT NULL           -- 'PLAIN' | 'ARTISAN_END_GRAIN'
                            CHECK (style IN ('PLAIN', 'ARTISAN_END_GRAIN')),
    nominal_size        TEXT        NOT NULL           -- 'REGULAR' | 'OVERSIZED' | 'TRAVEL' | 'CUSTOM'
                            CHECK (nominal_size IN ('REGULAR', 'OVERSIZED', 'TRAVEL', 'CUSTOM')),
    base_price_cents    INTEGER     NOT NULL CHECK (base_price_cents >= 0),
    units_on_hand       INTEGER     NOT NULL DEFAULT 0 CHECK (units_on_hand >= 0),
    lead_time_weeks     INTEGER,                       -- typical build time
    status              TEXT        NOT NULL DEFAULT 'AVAILABLE'
                            CHECK (status IN ('AVAILABLE', 'BACKLOGGED', 'DISCONTINUED', 'DRAFT')),
    image_url           TEXT,
    has_image           BOOLEAN     NOT NULL DEFAULT FALSE,
    waitlist_enabled    BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Note on capacity:** Custom-to-order goods have no meaningful inventory ceiling.
`units_on_hand` tracks pre-built stock only. When zero, the product is still
orderable (build-to-order) unless `status = 'BACKLOGGED'` or `'DISCONTINUED'`.
The "FULL" sold-out/waitlist trigger from the events model becomes a manual
admin toggle (`BACKLOGGED`) or an automatic transition when a pre-built unit
count hits zero. This is an open design question — see §Open Questions.

### Orders (`registrations` → `orders`)

The existing registration status machine is:
```
PENDING_PAYMENT → PENDING_CAPTURE → CONFIRMED
                                  → PAYMENT_FAILED
              → EXPIRED
              → CANCELLED
```

The proposed order status machine is richer:
```
INQUIRY → QUOTED → DEPOSIT_PENDING → DEPOSIT_PAID
                                   → IN_BUILD
                                   → READY_TO_SHIP → SHIPPED → DELIVERED
       → CANCELLED  (from any active state)
```

`INQUIRY` is a new upstream state — an order that came in via the contact form
or was entered manually by the admin, but no quote has been issued yet.

The `attributes JSONB` field from the existing registrations table is kept and
becomes the **rack specification carrier**:

```json
{
  "wood_species":    "acacia",
  "finish":          "white_stain",
  "magnet_config":   "both_sides_center",
  "tile_height_in":  "1.44",
  "tile_depth_in":   "0.59",
  "rack_length_in":  "20.5",
  "custom_notes":    "herringbone end-grain pattern"
}
```

**Additional fields on `orders` vs `registrations` (directional):**

```sql
-- Fields present in registrations that carry forward unchanged or renamed:
--   email, first_name, last_name, phone, attributes (JSONB), user_id,
--   gross_amount_cents, net_amount_cents, refunded_amount_cents,
--   stripe_refund_id, created_at, updated_at, cancelled_at

-- New or changed fields:
    product_id          UUID        REFERENCES products(product_id),
    quoted_cents        INTEGER,                   -- may differ from base price for custom work
    deposit_cents       INTEGER,                   -- typically 50% of quoted
    deposit_intent_id   TEXT,                      -- Stripe PI for deposit
    balance_intent_id   TEXT,                      -- Stripe PI for balance (created at ship time)
    shipping_address    JSONB,                     -- {line1, line2, city, state, zip, country}
    tracking_number     TEXT,
    carrier             TEXT,
    source              TEXT,                      -- 'WEBSITE' | 'CONTACT_FORM' | 'VENDOR_EVENT' | 'REFERRAL'
    last_contact_at     TIMESTAMPTZ,               -- drives CRM aging view
    quoted_at           TIMESTAMPTZ,
    deposit_paid_at     TIMESTAMPTZ,
    build_started_at    TIMESTAMPTZ,
    shipped_at          TIMESTAMPTZ,
    delivered_at        TIMESTAMPTZ,
    admin_notes         TEXT                       -- internal only, not shown to customer
```

### Contacts (new)

The existing schema has no concept of a prospective customer who has not yet
placed an order. The business reality is that a significant portion of customer
interactions are pre-order inquiries that may or may not convert. The `contacts`
table captures this.

```sql
CREATE TABLE contacts (
    contact_id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID        REFERENCES users(id),  -- linked when they create an account
    email               TEXT        NOT NULL,
    first_name          TEXT,
    last_name           TEXT,
    phone               TEXT,
    shipping_address    JSONB,
    source              TEXT,       -- 'CONTACT_FORM' | 'VENDOR_EVENT' | 'REFERRAL' | 'MANUAL'
    notes               TEXT,       -- admin notes
    last_contact_at     TIMESTAMPTZ,  -- key field for aging — drives the "needs attention" view
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_contacts_email ON contacts(LOWER(email));
CREATE INDEX idx_contacts_last_contact ON contacts(last_contact_at ASC NULLS FIRST);
```

The shadow account pattern from migration 007 applies here: a manually-entered
contact creates both a shadow `users` row and a `contacts` row linked by
`user_id`. If that person later registers on the website, the shadow row is
activated and their contact record is automatically associated with their account.

### Communications Log (new)

Captures the interaction history per contact or per order. This is the audit
trail that currently lives in SiYuan markdown tables and email thread summaries.

```sql
CREATE TABLE communications (
    comm_id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_id      UUID        REFERENCES contacts(contact_id),
    order_id        UUID        REFERENCES orders(order_id),  -- nullable
    direction       TEXT        NOT NULL
                        CHECK (direction IN ('INBOUND', 'OUTBOUND')),
    channel         TEXT        NOT NULL
                        CHECK (channel IN ('EMAIL', 'PHONE', 'IN_PERSON', 'TEXT', 'OTHER')),
    subject         TEXT,
    summary         TEXT,
    comm_date       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_communications_contact ON communications(contact_id, comm_date DESC);
CREATE INDEX idx_communications_order   ON communications(order_id,   comm_date DESC)
    WHERE order_id IS NOT NULL;
```

`last_contact_at` on the `contacts` table is updated by a trigger (or
application logic) whenever a `communications` row is inserted for that contact.

---

## Payment Flow

The existing Stripe integration implements a two-phase authorize→capture flow
designed for the "hold a seat, confirm when slot is secured" pattern, where
the window between authorization and capture is minutes to hours.

For Mahjracks the window between order and shipment is **weeks**. Stripe
payment intent authorizations expire in 7 days, making a direct port of the
existing two-phase flow impractical for the balance payment. The proposed
approach:

**Phase 1 — Deposit (at order confirmation):**
- Standard Stripe immediate-capture payment intent for 50% of quoted price.
- Existing `sp_initiate_registration` stored procedure adapted as
  `sp_initiate_order`; slot-acquisition logic removed (no capacity constraint
  for custom builds).
- Confirmation email sent immediately on deposit capture.

**Phase 2 — Balance (at ship-ready time):**
- Admin marks order `READY_TO_SHIP` in the admin dashboard.
- New Stripe payment intent created for the balance amount, OR a Stripe payment
  link is generated and emailed to the customer via Postmark.
- On payment, order transitions to `SHIPPED`; tracking info entered.

This means the reconciliation service's role shifts:
- **Existing role:** recover stuck payment intents, expire abandoned
  PENDING_PAYMENT registrations.
- **New role:** additionally flag orders whose `last_contact_at` is stale
  (aging), surface orders in `DEPOSIT_PAID` that have been sitting without
  build activity, and re-ping customers who have not completed balance payment
  within N days of the `READY_TO_SHIP` notification.

> **Open question:** Should balance collection use a Stripe payment link
> (customer self-serves via email) or a manual admin flow (admin charges
> card on file)? The former requires no saved payment method; the latter
> requires Stripe's saved payment method infrastructure. Stripe payment link
> is simpler to implement first.

---

## CRM Aging View

The core CRM insight from this session: the most operationally valuable view
is a list of active contacts and orders where `last_contact_at` is older than
a threshold, sorted oldest-first. This immediately surfaces who needs attention.

```sql
-- "Needs attention" view: contacts with active interest, not contacted in > 14 days
SELECT
    c.first_name, c.last_name, c.email,
    c.source,
    c.last_contact_at,
    EXTRACT(DAY FROM now() - c.last_contact_at) AS days_since_contact,
    COUNT(o.order_id) AS open_orders
FROM contacts c
LEFT JOIN orders o ON o.contact_id = c.contact_id  -- (contact_id FK TBD on orders)
    AND o.status NOT IN ('DELIVERED', 'CANCELLED')
WHERE c.last_contact_at < now() - INTERVAL '14 days'
   OR c.last_contact_at IS NULL
GROUP BY c.contact_id
ORDER BY c.last_contact_at ASC NULLS FIRST;
```

This query — or a variant of it — is the centrepiece of the admin dashboard.

---

## Admin Dashboard

The customer-facing storefront stays server-rendered with HTMX throughout.
The admin CRM/OM dashboard is the one area where richer interactivity justifies
a different approach. The proposed design:

- A React SPA mounted at `/admin/dashboard`, served as a static bundle.
- Communicates with the Hono server via a small set of JSON API endpoints
  (e.g., `GET /api/admin/orders`, `PATCH /api/admin/orders/:id/status`,
  `GET /api/admin/contacts`, `GET /api/admin/contacts/aging`).
- The SPA is admin-only; the existing `is_admin` flag on `users` gates access.

**Dashboard panels (directional):**

1. **Kanban board** — order cards in columns by status
   (`INQUIRY → QUOTED → DEPOSIT_PAID → IN_BUILD → READY_TO_SHIP → SHIPPED`).
   Cards show: contact name, product, wood spec summary, days since last contact
   (colour-coded badge: green < 7d, yellow 7–14d, red > 14d). Drag-and-drop
   to move an order between stages.

2. **Aging list** — contacts and open orders sorted by `last_contact_at`
   ascending. The primary "who needs a reply" view.

3. **Events sidebar** — upcoming vendor events with countdown in days,
   commitment status, action items.

> **Open question:** Should the React SPA live in this repo as a `src/admin/`
> subtree, or as a separate repo deployed to the same fly.io app? Given the
> shared auth and API, co-location in this repo is probably simpler.

---

## Analytics and Conversion Tracking

The event registration app already tracks page views per event (`page_views`
table, migration 009) and has Open Graph support for rich link unfurls on social
sharing. Both are relevant and carry over.

For a storefront, additional metrics matter that have no equivalent in event
registration:

- **Click-throughs per product** — which rack configurations get the most
  detail-page views. Existing `analyticsService.recordEventView()` maps
  directly to `recordProductView()`.
- **Leads vs. orders** — contact inquiries that do not convert to an order.
  The `contacts` table + `orders` table gives this naturally; conversion rate
  = `COUNT(orders WHERE contact_id IS NOT NULL) / COUNT(contacts)`.
- **Order conversion curve** — time from first contact to deposit paid.
  Unlike event registration (where the booking curve is rapid and predictable
  relative to an event date), rack orders have a much slower and more variable
  conversion window. The booking-curve analytics meaningful for events are
  less relevant here. What matters instead is per-contact aging and pipeline
  velocity.

---

## Future Considerations (Not Designed)

### Shopping cart

The existing application is a single-item flow: one registration per event
per person. Mahjracks may eventually want a customer to be able to order
multiple items in a single transaction — e.g., a set of racks plus a custom
playing table. This implies a shopping cart abstraction and a checkout flow
distinct from the current click-to-order-and-pay single-step pattern.

This is noted as a future requirement. It is a meaningful architectural change
(the payment intent is against a cart total, not a single product) and should
not be retrofitted — it should be designed in from the start if the business
case is clear. TBD.

### Shipping integration

No carrier integration is designed. The current business process is manual
FedEx shipment with tracking numbers entered by hand. Future possibilities:

- Discounted rate negotiation with a carrier (prerequisite: sufficient volume)
- Label printing via ShipStation, EasyPost, or direct carrier API
- Automated tracking updates to customers
- Shipping cost calculation at checkout

All TBD pending a carrier/rate relationship.

### Multi-vendor / consignment

An open thread exists around a potential retail/consignment arrangement
("Lexi's" in the vendor events history). This would imply a channel or
fulfilment-source concept on orders. Not designed.

### Mobile app

Out of scope. The HTMX server-rendered approach is inherently responsive;
a mobile-optimised view is a CSS/layout concern, not an architecture one.

---

## Open Questions

All of the following were identified in the initial conversation but not
resolved. They represent the primary open design surface.

| # | Question | Impact |
|---|---|---|
| Q1 | Does mahjracks.com deploy as its own fly.io app, or share an app/cluster with Craklins? | Deployment architecture, DNS, cost |
| Q2 | Are products a fixed catalog (admin-defined SKUs) or purely custom-configured per order? Currently the business has a few standard configurations but every order is somewhat bespoke. | Schema of `products` table; whether a product detail page shows a fixed price or a quote request |
| Q3 | Does the deposit use the existing two-phase Stripe authorize→capture pattern (timed to < 7 days), or an immediate capture with a separate balance PI at ship time? | Stripe integration design; reconciliation service |
| Q4 | Does balance collection use a Stripe payment link (self-serve, no saved card) or a saved payment method (requires Stripe Customer + SetupIntent)? | Stripe infrastructure, UX |
| Q5 | Where does the React admin SPA live — in this repo as `src/admin/`, or a separate repo? | Build tooling, deployment |
| Q6 | Is there a `contact_id` FK on the `orders` table, or is the contact relationship only via `user_id` and email matching? | CRM linkage |
| Q7 | Should `last_contact_at` on `contacts` be maintained by a DB trigger or application-layer logic in `CommunicationsService`? | Consistency vs. simplicity |
| Q8 | What constitutes "in stock" vs "build to order"? Is there ever pre-built inventory, or is every item always custom? | `units_on_hand` semantics, waitlist trigger |
| Q9 | Shopping cart — is this a v1 requirement or deferred? | Significant architectural impact if v1 |
| Q10 | Shipping integration — is there a carrier relationship in place or imminent? | Whether to design shipping cost calculation into the order flow |
| Q11 | Does the admin dashboard need a mobile-responsive design, or is it desktop-only (admin uses a desktop)? | React SPA complexity |
| Q12 | Is there a need for a customer-facing "my orders" view (authenticated order history), or is the storefront unauthenticated / guest-checkout only for v1? | Auth flow for customers; shadow account activation |

---

## Source of These Notes

Captured from a conversation on June 25, 2026 in which the existing `ui-elaboration`
branch was reviewed (directory structure, controller inventory, service layer,
migrations 005–010, `types.ts`, `catalog.ts`) and the domain mapping was worked
through at a high level. The conversation also covered:

- A comparison of Airtable vs. a bespoke Postgres schema for the CRM layer,
  concluding that the Postgres/Flyte approach is the correct one given existing
  scaffolding and the planned overlap with Craklins CRM requirements.
- The value of the `attributes JSONB` field as a spec carrier.
- The shadow account pattern as a CRM/storefront integration point.
- The admin Kanban as a React SPA exception to the HTMX-everywhere rule.
- The two-payment-phase approach (deposit at order, balance at ship).
- The conversion curve difference between event registration and custom goods.

These notes should be treated as a **starting point for a proper requirements
gathering session**, not as a design that is ready for implementation.
