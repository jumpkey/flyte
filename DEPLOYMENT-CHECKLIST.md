# Deployment Checklist — Stripe Registration Flow (Live Mode)

This is the authoritative pre-merge reference for deploying the registration
payment feature with the **live Stripe API**.

> ## ⚠️ Read this first
> Merging to `main` **automatically deploys to Fly.io** via GitHub Actions
> (`.github/workflows/fly-deploy.yml` runs `flyctl deploy` on every push to
> `main`). There is no manual deploy gate. **Complete Parts 1 and 2 below
> BEFORE merging the PR** — otherwise the app deploys with Stripe
> unconfigured and every registration attempt fails with a 500.

The app name is `flyte` (from `fly.toml`), so the production URL is
`https://flyte.fly.dev`. Substitute your real app name/domain if different.

---

## Part 1 — Stripe Live-Mode Setup (before merge)

Live mode is a separate world from test mode in Stripe: separate API keys,
separate webhook endpoints, separate signing secrets. A test-mode webhook
secret will **fail signature verification** against live events.

- [ ] **Activate the Stripe account** at https://dashboard.stripe.com →
  complete the business profile and bank account (payouts) so live charges
  are permitted. Until activation completes, live keys won't work.
- [ ] **Switch the Dashboard out of "Test mode"** (toggle, top-right) before
  doing the next two steps — keys and webhooks are mode-specific.
- [ ] **Copy the live API keys** from Developers → API Keys:
  - Secret key `sk_live_...`
  - Publishable key `pk_live_...`
- [ ] **Create the live webhook endpoint** at Developers → Webhooks → Add endpoint:
  - URL: `https://flyte.fly.dev/webhooks/stripe`
  - Events to subscribe (exactly these two):
    - `payment_intent.amount_capturable_updated`
    - `payment_intent.payment_failed`
  - [ ] Copy this endpoint's signing secret (`whsec_...`). It is unique to
    this endpoint — not the same as any Stripe CLI or test-mode secret.

> **Optional rehearsal:** to exercise the full flow against the Stripe *test*
> API on a throwaway Fly app before going live, follow
> `STRIPE-LIVE-SANDBOX-TEST-GUIDE.md` (Part D.2 covers an ephemeral Fly app
> with a real dashboard webhook endpoint).

---

## Part 2 — Fly.io Secrets (before merge)

### 2a. Set the Stripe live secrets

Set all three in a single command (each `fly secrets set` restarts the
machines; batching avoids multiple restarts):

```bash
fly secrets set \
  STRIPE_SECRET_KEY=sk_live_... \
  STRIPE_PUBLISHABLE_KEY=pk_live_... \
  STRIPE_WEBHOOK_SECRET=whsec_... \
  --app flyte
```

The currently deployed (pre-Stripe) code ignores these variables, so setting
them ahead of the merge is safe. If you prefer not to restart the running app
at all, add `--stage` — staged secrets take effect on the next deploy (i.e.,
the merge).

Optional tuning (defaults are sensible — only set to override):

```bash
fly secrets set STRIPE_API_TIMEOUT_MS=10000 REGISTRATION_TTL_MINUTES=30 CAPTURE_MAX_RETRIES=5 --app flyte
```

### 2b. Verify the pre-existing secrets are in place

```bash
fly secrets list --app flyte
```

| Secret | Required | Notes |
|---|---|---|
| `DATABASE_URL` | Yes | From `fly postgres attach` |
| `SESSION_SECRET` | Yes | App **refuses to boot** in production without it |
| `APP_DOMAIN` | Yes | `https://flyte.fly.dev` (or custom domain) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Yes | Must be a **real mail provider** — confirmation, waitlist, and refund emails are part of the payment flow. The dev default (`localhost:1025`) silently drops mail. |
| `STRIPE_SECRET_KEY` | Yes | `sk_live_...` from Part 1 |
| `STRIPE_PUBLISHABLE_KEY` | Yes | `pk_live_...` from Part 1 |
| `STRIPE_WEBHOOK_SECRET` | Yes | Live endpoint's `whsec_...` from Part 1 |
| `SEED_ADMIN_PASSWORD` | Only when seeding | See Part 5 — the seeder now refuses to run in production without it |

- [ ] All required secrets present
- [ ] Send a test email through the configured SMTP credentials if they
  haven't been exercised recently

---

## Part 3 — Merge → Automatic Deploy

- [ ] Merge the PR. The `Fly Deploy` workflow then runs `flyctl deploy --remote-only`.

What happens automatically:

1. Docker image builds (multi-stage: builder → runner with supercronic)
2. Release command runs `node dist/scripts/migrate.js`, applying
   `005_registration_schema.sql` (tables `events`, `registrations`,
   `waitlist_entries`, `refund_log` + stored procedures) and
   `006_fix_email_uniqueness.sql` (partial unique index on active
   registrations per event/email + atomic `sp_initiate_registration`)
3. `web` process starts: `node dist/index.js`
4. `worker` process starts: `supercronic /app/crontab` (reconciliation sweep
   every 5 minutes)

- [ ] Watch the workflow in GitHub Actions → confirm the deploy step succeeds
- [ ] `fly status --app flyte` shows both `web` and `worker` machines running

---

## Part 4 — Post-Deploy Verification (live mode)

### 4a. Verify migrations

```bash
fly ssh console --app flyte -C "node -e \"
  const p = require('postgres');
  const sql = p(process.env.DATABASE_URL);
  sql\\\`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename\\\`
    .then(r => { console.log(r.map(x=>x.tablename).join(', ')); sql.end(); });
\""
```

- [ ] Tables exist: `events`, `registrations`, `refund_log`,
  `schema_migrations`, `sessions`, `user_action_events`, `users`,
  `waitlist_entries`

### 4b. Verify the reconciliation worker

```bash
fly logs --app flyte | grep reconciliation
```

- [ ] `[reconciliation] sweep starting` / `sweep complete` entries appear
  every 5 minutes

### 4c. Live smoke test — real card, real money

> **Stripe test cards (`4242 4242 4242 4242`) do NOT work in live mode.**
> The smoke test below places a real authorization and capture on a real
> card. Use a low-fee event and refund yourself afterwards.

1. [ ] Create a low-priced smoke-test event:

```bash
fly proxy 5433:5432 --app flyte-db &

psql "postgres://flyte:<password>@localhost:5433/flyte" -c "
INSERT INTO events (name, event_date, total_capacity, confirmed_count, available_slots, registration_fee_cents)
VALUES ('Launch Smoke Test', now() + interval '30 days', 2, 0, 2, 100)
RETURNING event_id;
"
```

2. [ ] Visit `https://flyte.fly.dev/events/<event_id>/register`
3. [ ] Fill in participant info (use an email you control) → "Continue to
   Payment" → pay the $1.00 fee with a real card
4. [ ] Redirects to `/registration/<id>/confirmed`
5. [ ] Confirmation email arrives at the address you used
6. [ ] Verify in the database: status `CONFIRMED`, `confirmed_count = 1`,
   `available_slots` decremented, `net_amount_cents` populated
7. [ ] In the Stripe Dashboard (live mode) → Payments: the PaymentIntent
   shows **Succeeded** (authorized then captured)
8. [ ] **Refund the smoke-test charge** from the Stripe Dashboard.
   Note: a dashboard-issued refund does **not** update the app's
   `registrations`/`refund_log` rows (the in-app `RefundService` is only
   invoked by internal flows) — that's fine for a smoke test; just delete or
   cancel the smoke-test event row afterwards.

### 4d. Verify webhook delivery

Stripe Dashboard (live mode) → Developers → Webhooks → your endpoint:

- [ ] The smoke test's events were delivered with `200` responses
- [ ] If failures appear, check `fly logs --app flyte` for `[webhook]`
  entries — `Invalid signature` means the live `whsec_` doesn't match the
  endpoint (see Part 1)

### 4e. Capacity + waitlist checks (optional, recommended)

- [ ] Fill the smoke-test event (capacity 2 above) and confirm the next
  registration attempt redirects to `/events/<event_id>/waitlist`
- [ ] Submit the waitlist form → row appears in `waitlist_entries` and an
  acknowledgement email arrives

---

## Part 5 — Admin User Seeding (production rules)

The seeder (`npm run seed`) was hardened in this release:

- It **refuses to run** when `NODE_ENV=production` and `SEED_ADMIN_PASSWORD`
  is unset — there is no longer a `changeme123` default in production.
- It is **insert-only**: if the admin user already exists it is left
  untouched, so re-running the seeder can never reset a changed password.

When seeding the production database over a `fly proxy` tunnel, set both
variables explicitly (the guard keys off `NODE_ENV`, which is not
automatically `production` on your local machine):

```bash
NODE_ENV=production \
SEED_ADMIN_PASSWORD='<strong-unique-password>' \
DATABASE_URL='postgres://flyte:<password>@localhost:5433/flyte' \
npm run seed
```

---

## Rollback Plan

```bash
# List recent releases
fly releases --app flyte

# Roll back to a specific release
fly deploy --app flyte --image <previous-image-ref>
```

Migrations `005` and `006` are **additive** — they create new tables, indexes,
and stored procedures without modifying existing ones. Rolling back the app
code will not break existing user-management functionality.

If payments must be halted quickly without a rollback: delete (or disable) the
webhook endpoint in the Stripe Dashboard and set the affected events' `status`
to a non-`OPEN` value — the registration form refuses new initiations for
non-open events.

---

## Post-Deploy Notes

- **Rate limiting**: registration POST endpoints are limited to 60 requests
  per 60 seconds per IP, with server-side retry-with-backoff before a hard
  429. See `STRIPE-INTEGRATION.md`.
- **Reconciliation**: the supercronic worker runs every 5 minutes — expires
  stale `PENDING_PAYMENT` records, retries failed captures (cancelling the
  PaymentIntent and restoring the slot after `CAPTURE_MAX_RETRIES`), and
  re-sends unsent confirmation emails.
- **Load testing**: never load-test against live keys. Use the simulator
  setup in `load_testing/README.md` / `load_testing/DEPLOY.md`, or the
  test-mode recipes in `STRIPE-LIVE-SANDBOX-TEST-GUIDE.md`.
- **Remaining issues**: see `ISSUE-LOG.md` for deferred low-priority items,
  and the repo issue tracker for open security follow-ups.
