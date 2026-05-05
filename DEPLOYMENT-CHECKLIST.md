# Deployment Checklist — Stripe Registration Flow

Use this checklist when deploying the registration payment feature after merging
the `implement-stripe-registration-flow` branch.

---

## Pre-Deploy: Stripe Account Setup

- [ ] Create or confirm your Stripe account at https://dashboard.stripe.com
- [ ] Get your API keys from Stripe Dashboard → Developers → API Keys:
  - Secret key (`sk_test_...` for staging, `sk_live_...` for production)
  - Publishable key (`pk_test_...` / `pk_live_...`)
- [ ] Create a webhook endpoint in Stripe Dashboard → Developers → Webhooks:
  - URL: `https://<your-app>.fly.dev/webhooks/stripe`
  - Events to subscribe:
    - `payment_intent.amount_capturable_updated`
    - `payment_intent.payment_failed`
  - Copy the webhook signing secret (`whsec_...`)

---

## Step 1: Set Stripe Secrets on Fly.io

```bash
fly secrets set STRIPE_SECRET_KEY=sk_test_... --app <your-app>
fly secrets set STRIPE_PUBLISHABLE_KEY=pk_test_... --app <your-app>
fly secrets set STRIPE_WEBHOOK_SECRET=whsec_... --app <your-app>
```

Optional tuning (defaults are sensible — only set if you need to override):

```bash
fly secrets set STRIPE_API_TIMEOUT_MS=10000 --app <your-app>
fly secrets set REGISTRATION_TTL_MINUTES=30 --app <your-app>
fly secrets set CAPTURE_MAX_RETRIES=5 --app <your-app>
```

---

## Step 2: Verify All Secrets

Confirm these are set (both pre-existing and new):

```bash
fly secrets list --app <your-app>
```

Expected secrets:

| Secret | Source |
|---|---|
| `DATABASE_URL` | Previous deployment (via `fly postgres attach`) |
| `SESSION_SECRET` | Previous deployment |
| `APP_DOMAIN` | Previous deployment |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Previous deployment |
| `STRIPE_SECRET_KEY` | Step 1 above |
| `STRIPE_PUBLISHABLE_KEY` | Step 1 above |
| `STRIPE_WEBHOOK_SECRET` | Step 1 above |

---

## Step 3: Deploy

```bash
fly deploy --app <your-app>
```

What happens automatically:

1. Docker image builds (multi-stage: builder → runner with supercronic)
2. Release command runs: `node dist/scripts/migrate.js` — applies `005_registration_schema.sql`
   (creates `events`, `registrations`, `waitlist_entries`, `refund_log` tables and all stored procedures)
3. `web` process starts: `node dist/index.js`
4. `worker` process starts: `supercronic /app/crontab` (reconciliation sweep every 5 minutes)

---

## Step 4: Verify Migration

```bash
fly ssh console --app <your-app> -C "node -e \"
  const p = require('postgres');
  const sql = p(process.env.DATABASE_URL);
  sql\\\`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename\\\`
    .then(r => { console.log(r.map(x=>x.tablename).join(', ')); sql.end(); });
\""
```

- [ ] Confirm these tables exist: `events`, `registrations`, `refund_log`, `schema_migrations`,
  `sessions`, `user_action_events`, `users`, `waitlist_entries`

---

## Step 5: Create a Test Event

```bash
fly proxy 5433:5432 --app flyte-db &

psql "postgres://flyte:<password>@localhost:5433/flyte" -c "
INSERT INTO events (name, event_date, total_capacity, confirmed_count, available_slots, registration_fee_cents)
VALUES ('Test Event', now() + interval '30 days', 10, 0, 10, 5000);
"
```

- [ ] Note the returned `event_id` UUID for the smoke test below

---

## Step 6: Smoke Test the Registration Flow

1. [ ] Visit `https://<your-app>.fly.dev/events/<event_id>/register`
2. [ ] Fill in participant info → "Continue to Payment"
3. [ ] Use Stripe test card `4242 4242 4242 4242`, any future expiry, any CVC
4. [ ] Should redirect to `/registration/<id>/confirmed`
5. [ ] Verify in database:
   - Registration status is `CONFIRMED`
   - `confirmed_count` incremented to 1
   - `available_slots` decremented to 9

---

## Step 7: Verify Reconciliation Worker

```bash
fly logs --app <your-app> | grep reconciliation
```

- [ ] Confirm `[reconciliation] sweep starting` / `sweep complete` entries appear every 5 minutes

---

## Step 8: Verify Webhook Delivery

In Stripe Dashboard → Developers → Webhooks → your endpoint:

- [ ] Events are being delivered with `200` status
- [ ] If failures appear, check `fly logs --app <your-app>` for `[webhook]` entries

---

## Step 9: Test Capacity Exhaustion

Register enough users to fill the test event (or create a small-capacity event), then verify:

- [ ] Next registration attempt redirects to `/events/<event_id>/waitlist`
- [ ] `available_slots = 0` in the database
- [ ] `confirmed_count = total_capacity`

---

## Step 10: Test Waitlist

1. [ ] Visit `/events/<event_id>/waitlist`
2. [ ] Submit waitlist form
3. [ ] Verify `waitlist_entries` row created in database

---

## Rollback Plan

If something goes wrong after deployment:

```bash
# List recent releases
fly releases --app <your-app>

# Roll back to a specific release
fly deploy --app <your-app> --image <previous-image-ref>
```

The registration migration (`005_registration_schema.sql`) is **additive** — it creates new
tables and stored procedures without modifying existing ones. Rolling back the app code will
not break existing user management functionality.

---

## Post-Deploy Notes

- **Rate limiting**: Registration POST endpoints are rate-limited to 10 requests per 60 seconds
  per IP, with server-side retry-with-backoff (not hard 429). See `STRIPE-INTEGRATION.md` for details.
- **Reconciliation**: The supercronic worker process runs every 5 minutes. It expires stale
  `PENDING_PAYMENT` records, retries failed captures, and re-sends unsent confirmation emails.
- **Load testing**: For load testing against the staging environment, follow the instructions
  in `load_testing/README.md` and `load_testing/DEPLOY.md`.
- **Remaining issues**: See `ISSUES-PARKING-LOT.md` for deferred low-priority items.
