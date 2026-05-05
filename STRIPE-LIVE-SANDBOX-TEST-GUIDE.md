# Stripe Live Sandbox Test Guide

**Purpose:** Step-by-step recipe to run the registration test suite against
the **real** Stripe API (test mode) — both the synchronous client-confirm
path and the asynchronous webhook path — and to run a low-volume load test
that respects Stripe's test-mode rate limits.

**Audience:** Future-you, after a long day, who has forgotten this whole
conversation. Do the steps in order. They build on each other.

---

## What "Stripe test mode" gives you

Stripe test mode (a.k.a. sandbox) uses the same `api.stripe.com` endpoint
your production code will use, but with `sk_test_…` / `pk_test_…` keys.
Test cards work, no money moves, the data is isolated from live mode.
Your code path is identical — this is a real integration test, not a stub.

The two-phase capture flow has two confirmation paths, both of which need
to be exercised:

- **Path A (webhook):** Stripe POSTs `payment_intent.amount_capturable_updated`
  to `/webhooks/stripe`. To receive these in a test environment, you need
  the **Stripe CLI** running `stripe listen --forward-to ...` to tunnel
  events into your local server. Without it, Stripe's webhooks have no
  public URL to reach.
- **Path B (client confirm):** The browser POSTs to
  `/registration/confirm/:piId`, which calls `stripe.paymentIntents.retrieve`
  synchronously. No webhook delivery required.

You can test Path B with just secret keys and no Stripe CLI. You need the
Stripe CLI for Path A and for any test that exercises the full flow.

---

## Prerequisites (one-time setup)

1. **Stripe account** with test mode access (every Stripe account has
   this; nothing to enable).

2. **Stripe CLI** installed locally and on whatever machine runs the
   tests (Copilot's container, your laptop, CI runner, etc.).

   ```
   # macOS:
   brew install stripe/stripe-cli/stripe

   # Linux (one-liner; pinned version recommended):
   curl -fsSL https://github.com/stripe/stripe-cli/releases/download/v1.21.8/stripe_1.21.8_linux_x86_64.tar.gz \
     | tar xz -C /usr/local/bin stripe
   ```

3. **Stripe CLI auth** (one-time, persists in `~/.config/stripe/`):

   ```
   stripe login
   ```

   This opens a browser for you to authorize the CLI against your Stripe
   account. After auth, `stripe config --list` shows the stored API key.

   For a headless environment (Copilot's container or CI), use a restricted
   key instead of `stripe login`:

   ```
   stripe config --set test_mode_api_key=rk_test_…
   ```

   Restricted keys are created at dashboard.stripe.com → Developers →
   API keys → "Create restricted key". Give it `read+write` on
   PaymentIntents, Refunds, Webhook Endpoints, and Events.

4. **Postgres** reachable via `DATABASE_URL`, with the schema applied:

   ```
   psql "$DATABASE_URL" -f db/migrations/005_registration_schema.sql
   ```

---

## Part A — Set secrets in GitHub (web UI recipe)

These are needed for any GitHub Actions workflow that runs live-Stripe
tests in CI.

### A.1 Get the keys from Stripe

1. Go to <https://dashboard.stripe.com>.
2. **Top-right toggle: switch to "Test mode"** (orange "Test data" banner
   appears). Everything you do from here is sandbox.
3. Left sidebar → **Developers** → **API keys**.
4. Copy the **Publishable key** (`pk_test_…`).
5. Click "Reveal test key" next to **Secret key**, copy (`sk_test_…`).

### A.2 Get a webhook signing secret

There are **two** kinds of webhook secret. Pick the one matching how the
test environment will receive webhooks:

- **For deployed test endpoints** (e.g. a Fly preview app with a public
  hostname): Stripe Dashboard → Developers → Webhooks → "Add endpoint" →
  enter `https://your-test-app.fly.dev/webhooks/stripe`, select event
  `payment_intent.amount_capturable_updated` and `payment_intent.payment_failed`,
  save. Click into the new endpoint, reveal **Signing secret** (`whsec_…`).
- **For local/CI testing via Stripe CLI**: the CLI prints a different
  signing secret when you run `stripe listen` (it tunnels events through a
  Stripe-managed endpoint). You'll see it in the CLI output:

  ```
  > Ready! Your webhook signing secret is whsec_abc123… (^C to quit)
  ```

  This `whsec_…` is what you set as `STRIPE_WEBHOOK_SECRET` for the
  duration of that CLI process. **It changes every time you re-auth the
  CLI.** For repeatable CI, use the dashboard endpoint approach.

### A.3 Add the secrets to GitHub

1. <https://github.com/jumpkey/flyte> → **Settings** (repo nav).
2. Left sidebar → **Secrets and variables** → **Actions**.
3. Click **New repository secret** for each of the following:

   | Name                       | Value                            |
   |----------------------------|----------------------------------|
   | `STRIPE_SECRET_KEY`        | `sk_test_…` from step A.1        |
   | `STRIPE_PUBLISHABLE_KEY`   | `pk_test_…` from step A.1        |
   | `STRIPE_WEBHOOK_SECRET`    | `whsec_…` from step A.2          |

4. (Optional) If you also want to run the existing app smoke test in CI,
   add `DATABASE_URL` pointing at a CI-reachable Postgres (e.g. the
   workflow's service container).

These secrets are write-only after creation — GitHub never shows the
value back. To rotate, delete and recreate.

**Important security notes:**
- These are **test mode** keys. They are still secret (a leak is
  embarrassing and worth rotating), but no money is at risk.
- Do **not** put live (`sk_live_…`) keys in GitHub Actions secrets unless
  you have a strict reason to deploy from CI. Keep live keys on Fly via
  `fly secrets set`.

---

## Part B — Run regression tests against live Stripe

The repository ships with `MockStripeClient` and 11 increment test files
(`src/registration/testing/increment-N.test.ts`). The mock simulates Stripe
behavior deterministically. To run the same tests against the real Stripe
test API, the trick is **dependency injection**: the `RegistrationService`
takes a `StripeClient` interface in its constructor, and the existing tests
already pass `MockStripeClient`. We add a thin runner that swaps in the
real Stripe SDK.

### B.1 Decide what you're testing

The increment tests cover:
- `increment-1` — `sp_initiate_registration` (DB only, no Stripe needed).
- `increment-3` — `RegistrationService.initiateRegistration` (calls
  `stripe.paymentIntents.create`).
- `increment-4` — `handlePaymentAuthorized` happy path (slot acquire +
  capture + finalize). Calls `stripe.paymentIntents.capture`.
- `increment-5` — capture failure paths (transient + permanent).
- `increment-6` — webhook authorization handler.
- `increment-7` — client confirmation path.
- `increment-8` — refunds (full + partial). Calls `stripe.refunds.create`.
- `increment-9` — bulk event refunds.
- `increment-10` — waitlist (no Stripe needed).
- `increment-11` — `ReconciliationService` (the biggest target — exercises
  retrieve, capture, cancel, and the new advisory lock).
- `increment-13` — end-to-end smoke.

### B.2 Quick path: just the synchronous calls (no webhook)

If you only want to verify outbound Stripe calls work — `create`,
`retrieve`, `capture`, `cancel`, `refunds.create` — you don't need the
Stripe CLI. Just point the suite at the real Stripe SDK:

1. Export the test-mode keys in your shell:
   ```
   export STRIPE_SECRET_KEY=sk_test_…
   export STRIPE_PUBLISHABLE_KEY=pk_test_…
   export DATABASE_URL=postgresql://localhost/flyte_test
   ```

2. The existing tests instantiate `MockStripeClient` directly. To swap in
   the real SDK, the cleanest pattern is a "live" runner that imports
   each test's `runTests` function and passes a real Stripe instance.
   Since the current tests construct mocks inside themselves, this
   requires a small refactor — instead of editing each test, create:

   ```
   # File: src/registration/testing/run-all-tests-live.ts
   ```

   See section B.4 below for the script content.

3. Run it:
   ```
   npx tsx src/registration/testing/run-all-tests-live.ts
   ```

### B.3 Full path: include webhook (Path A)

For the webhook handler test, you need Stripe to deliver a real event to
your server. Use the Stripe CLI as a tunnel.

1. **Terminal 1 — start the app:**
   ```
   export STRIPE_SECRET_KEY=sk_test_…
   export STRIPE_PUBLISHABLE_KEY=pk_test_…
   export DATABASE_URL=postgresql://localhost/flyte_test
   # leave STRIPE_WEBHOOK_SECRET unset for now
   npx tsx src/index.ts
   ```

2. **Terminal 2 — start Stripe CLI listener:**
   ```
   stripe listen --forward-to localhost:3000/webhooks/stripe \
     --events payment_intent.amount_capturable_updated,payment_intent.payment_failed
   ```

   It prints:
   ```
   > Ready! You are using Stripe API Version [2026-04-22.dahlia].
   > Your webhook signing secret is whsec_abc123…
   ```

   Copy that `whsec_…`.

3. **Terminal 1 — restart the app with the secret:**
   ```
   export STRIPE_WEBHOOK_SECRET=whsec_abc123…
   npx tsx src/index.ts
   ```

4. **Terminal 3 — trigger the test scenario.** The Stripe CLI can fire
   real test events on demand:

   ```
   # Successful authorization (Path A):
   stripe trigger payment_intent.amount_capturable_updated
   ```

   Or run the full end-to-end via the browser at
   `http://localhost:3000/events/<id>/register` using a test card
   (`4242 4242 4242 4242`, any future expiry, any CVC, any ZIP).

5. **Watch all three terminals.** Terminal 1 shows your app processing
   the webhook (look for `[webhook] event:` and `[RegistrationService]`
   logs). Terminal 2 shows the CLI's view of delivery and HTTP response.
   Terminal 3 (or browser) shows the trigger result.

### B.4 The live test runner script

Drop this file at `src/registration/testing/run-all-tests-live.ts`. It
imports the real Stripe SDK, builds a thin `StripeClient` adapter, and
invokes a subset of the existing tests by re-exporting their inner
functions. Tests that depend on `MockStripeClient`-specific options (like
`captureErrorType: 'transient'`) **cannot** be run live — Stripe doesn't
let you on-demand inject a transient error. Mark those skipped.

```typescript
import 'dotenv/config';
import Stripe from 'stripe';
import { sql } from '../../services/db.js';
import type { StripeClient } from '../interfaces.js';

const REQUIRED_ENV = ['STRIPE_SECRET_KEY', 'DATABASE_URL'];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`Missing required env: ${key}`);
    process.exit(1);
  }
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-04-22.dahlia' as const,
  timeout: 15000,
}) as unknown as StripeClient;

// Tests that only exercise outbound API calls (no transient-error injection).
const LIVE_SAFE_TESTS = [
  'increment-1.test.ts',  // DB only
  'increment-3.test.ts',  // create PI
  'increment-4.test.ts',  // capture happy path
  'increment-7.test.ts',  // client confirm
  'increment-8.test.ts',  // refunds
  'increment-10.test.ts', // waitlist
];

// Tests that require deterministic failure injection — mock-only.
const MOCK_ONLY_TESTS = [
  'increment-5.test.ts',  // capture transient/permanent failures
  'increment-6.test.ts',  // webhook signature edge cases
  'increment-9.test.ts',  // bulk refund partial failures
  'increment-11.test.ts', // reconciliation with simulated states
  'increment-13.test.ts', // end-to-end with controlled failures
];

console.log('=== LIVE-safe tests (against real Stripe test API) ===');
for (const t of LIVE_SAFE_TESTS) console.log(`  - ${t}`);
console.log('=== MOCK-only (cannot run live, deterministic failure injection) ===');
for (const t of MOCK_ONLY_TESTS) console.log(`  - ${t}`);

// To actually run the live tests, the simplest approach is:
// 1. Edit each test file's `runTests` function to accept an injected
//    StripeClient instead of constructing a MockStripeClient internally.
// 2. Or, set an env var STRIPE_TEST_MODE=live and have the test files
//    branch on it: if (process.env.STRIPE_TEST_MODE === 'live') use real;
//    else use mock.
//
// The MOCK_ONLY tests should stay in MOCK mode regardless.
//
// This file is a template — the actual edits to each increment test
// are out of scope for this guide. The above lists show which tests
// are candidates for live runs.

console.log('\nDone (template only — see comments to wire up actual runs).');
await sql.end();
```

The runner is intentionally a template, because making each increment
test injectable is a small but non-trivial refactor of files outside the
scope of this guide. When you do that refactor, the rule of thumb is:
**mocks for failure injection, live for happy paths**.

### B.5 Test cards you'll use

| Card                  | Behavior                                             |
|-----------------------|------------------------------------------------------|
| `4242 4242 4242 4242` | Always succeeds                                      |
| `4000 0000 0000 9995` | Declined (insufficient funds) — tests fail path     |
| `4000 0000 0000 0002` | Declined (generic) — tests fail path                |
| `4000 0027 6000 3184` | Requires 3DS authentication — tests `requires_action`|
| `4000 0000 0000 0259` | Authorizes, then disputes as fraudulent at capture   |

Full list: <https://docs.stripe.com/testing>.

### B.6 Cleanup between runs

Test mode keeps everything indefinitely. Two cleanup options:

```
# Cancel all uncaptured PaymentIntents created in the last hour:
stripe payment_intents list --limit 100 \
  | jq -r '.data[] | select(.status == "requires_capture") | .id' \
  | xargs -I{} stripe payment_intents cancel {}

# Delete test customers (if you start creating them):
stripe customers list --limit 100 | jq -r '.data[].id' \
  | xargs -I{} stripe customers delete {}
```

Or just leave the data — it's all sandboxed and Stripe doesn't bill on
storage. The tests don't depend on a clean slate as long as your local
DB is fresh (re-apply the migration to wipe registrations).

---

## Part C — Low-volume load test respecting rate limits

### C.1 Stripe test-mode rate limits — what to actually plan around

Stripe's published rate limits for test mode are **lower** than live mode
to discourage abuse:

- **25 read requests per second**
- **25 write requests per second**

(Live mode is 100/100 by default, raisable on request.) Treat test mode
as a hard ceiling at ~20 req/sec to leave headroom for the Stripe CLI's
own polling and avoid 429s during long runs.

The registration flow's Stripe API call count per user, per successful
registration:

| Step                              | Stripe calls |
|-----------------------------------|--------------|
| `initiateRegistration`            | 1 (`pi.create`)        |
| `confirmRegistrationFromClient`   | 1 (`pi.retrieve`)      |
| `handlePaymentAuthorized`         | 1 (`pi.capture`)       |
| **Total per registration**        | **3 calls (writes mostly)** |

Plus 1 `pi.cancel` for failure paths. So a single user registration ≈ 3-4
Stripe API calls. At 20 calls/sec ceiling, that's roughly **5
registrations/sec sustained**.

For the load test, target a deliberately conservative **3 registrations
per second** = 9 Stripe calls/sec. Leaves plenty of headroom and matches
realistic event-registration burst patterns (a tournament's "registration
opens at noon" surge).

### C.2 Load test recipe

This uses the existing `initiateRegistration` + `confirmRegistrationFromClient`
endpoints in series, which exercises Path B end-to-end without needing
the Stripe CLI tunnel.

1. **Pre-seed the DB** with a single test event that has high capacity:

   ```sql
   INSERT INTO events (event_id, name, event_date, total_capacity, available_slots, registration_fee_cents)
   VALUES (gen_random_uuid(), 'Load Test Event', now() + interval '30 days', 1000, 1000, 5000)
   RETURNING event_id;
   ```

   Save that UUID as `$EVENT_ID`.

2. **Create a load-test script** at `scripts/load-test-stripe-sandbox.ts`:

```typescript
import 'dotenv/config';
import Stripe from 'stripe';

const EVENT_ID = process.env.LOAD_TEST_EVENT_ID;
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const TARGET_RPS = 3;            // registrations per second
const DURATION_S = 60;           // 60s = 180 registrations total
const TOTAL_REGISTRATIONS = TARGET_RPS * DURATION_S;

if (!EVENT_ID) { console.error('Set LOAD_TEST_EVENT_ID'); process.exit(1); }
if (!process.env.STRIPE_SECRET_KEY) { console.error('Set STRIPE_SECRET_KEY'); process.exit(1); }

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-04-22.dahlia' as const,
});

interface Result { ok: boolean; durationMs: number; error?: string; piId?: string; }

async function getCsrfToken(): Promise<string> {
  // The middleware mints a token on first GET. Fetch the registration page.
  const res = await fetch(`${BASE_URL}/events/${EVENT_ID}/register`);
  const html = await res.text();
  const m = html.match(/name="_csrf"\s+value="([^"]+)"/);
  if (!m) throw new Error('Could not extract CSRF token from registration page');
  // Capture the session cookie too:
  const cookie = res.headers.get('set-cookie')?.split(';')[0] ?? '';
  return JSON.stringify({ token: m[1], cookie });
}

async function registerOne(idx: number): Promise<Result> {
  const t0 = Date.now();
  try {
    const csrfBlob = await getCsrfToken();
    const { token, cookie } = JSON.parse(csrfBlob);
    const res = await fetch(`${BASE_URL}/events/${EVENT_ID}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
        'Cookie': cookie,
      },
      body: JSON.stringify({
        email: `loadtest+${idx}-${Date.now()}@example.com`,
        firstName: 'Load',
        lastName: `Test${idx}`,
        phone: '5551234567',
      }),
    });
    if (!res.ok) {
      return { ok: false, durationMs: Date.now() - t0, error: `HTTP ${res.status}: ${await res.text()}` };
    }
    const body = await res.json();
    const piId = body.paymentIntentId;

    // Confirm the PaymentIntent server-side using a test payment method
    // (skipping the browser Stripe.js step for headless load testing).
    await stripe.paymentIntents.confirm(piId, {
      payment_method: 'pm_card_visa', // test payment method that always succeeds
      return_url: 'https://example.com',
    });

    // Now hit our confirm endpoint:
    const confirmRes = await fetch(`${BASE_URL}/registration/confirm/${piId}`, {
      method: 'POST',
      headers: { 'X-CSRF-Token': token, 'Cookie': cookie },
      redirect: 'manual',
    });
    if (![200, 302].includes(confirmRes.status)) {
      return { ok: false, durationMs: Date.now() - t0, error: `confirm HTTP ${confirmRes.status}`, piId };
    }
    return { ok: true, durationMs: Date.now() - t0, piId };
  } catch (err) {
    return { ok: false, durationMs: Date.now() - t0, error: String(err) };
  }
}

async function main() {
  console.log(`Load test: ${TOTAL_REGISTRATIONS} registrations at ${TARGET_RPS}/s for ${DURATION_S}s`);
  const intervalMs = 1000 / TARGET_RPS;
  const results: Result[] = [];
  const inflight: Promise<void>[] = [];

  for (let i = 0; i < TOTAL_REGISTRATIONS; i++) {
    const p = registerOne(i).then((r) => { results.push(r); });
    inflight.push(p);
    await new Promise((res) => setTimeout(res, intervalMs));
    if (i % 10 === 0) {
      const okCount = results.filter((r) => r.ok).length;
      const errCount = results.filter((r) => !r.ok).length;
      process.stdout.write(`\r[${i}/${TOTAL_REGISTRATIONS}] ok=${okCount} err=${errCount}    `);
    }
  }
  await Promise.all(inflight);

  const ok = results.filter((r) => r.ok);
  const err = results.filter((r) => !r.ok);
  const durations = ok.map((r) => r.durationMs).sort((a, b) => a - b);
  const p50 = durations[Math.floor(durations.length * 0.5)] ?? 0;
  const p95 = durations[Math.floor(durations.length * 0.95)] ?? 0;
  const p99 = durations[Math.floor(durations.length * 0.99)] ?? 0;
  const max = durations[durations.length - 1] ?? 0;

  console.log(`\n\n=== Results ===`);
  console.log(`Total:      ${results.length}`);
  console.log(`Successful: ${ok.length}`);
  console.log(`Failed:     ${err.length}`);
  console.log(`Latency p50/p95/p99/max: ${p50}/${p95}/${p99}/${max} ms`);

  if (err.length > 0) {
    console.log(`\n=== Sample failures ===`);
    const rateLimited = err.filter((r) => r.error?.includes('429') || r.error?.includes('rate_limit'));
    if (rateLimited.length > 0) {
      console.log(`** ${rateLimited.length} rate-limited responses — back off TARGET_RPS **`);
    }
    for (const e of err.slice(0, 5)) console.log(`  - ${e.error}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
```

3. **Run it:**

   ```
   export STRIPE_SECRET_KEY=sk_test_…
   export LOAD_TEST_EVENT_ID=<the UUID from step 1>
   export BASE_URL=http://localhost:3000
   npx tsx scripts/load-test-stripe-sandbox.ts
   ```

4. **What to look for:**

   - **Zero `429` responses.** If you see any "rate_limit" errors, drop
     `TARGET_RPS` to 2 and rerun. 25 writes/s is a hard ceiling and bursts
     can push over.
   - **p95 latency under 2 seconds.** The slow path is `pi.create` +
     network round-trip to Stripe. Anything beyond 2s suggests app-side
     issues (DB pool exhaustion, postgres advisory lock contention).
   - **Database state.** After the run, check:
     ```sql
     SELECT status, COUNT(*) FROM registrations
       WHERE event_id = '<EVENT_ID>'::UUID GROUP BY status;
     SELECT available_slots, confirmed_count, total_capacity FROM events
       WHERE event_id = '<EVENT_ID>'::UUID;
     ```
     - Every successful run should produce a `CONFIRMED` row.
     - The capacity invariant must hold: `available_slots + confirmed_count = total_capacity`.
     - No row should be stuck in `PENDING_CAPTURE` for more than a few seconds (run reconciliation if any are).
   - **Stripe dashboard.** Visit dashboard.stripe.com (test mode) →
     Payments. You should see ~180 successful captures matching your
     load test count.

### C.3 Stress test the rate limiter

The application also has its own per-IP rate limit (`rateLimit(10, 60000)`
on registration endpoints — added in fix #5). To verify that's working
without burning Stripe quota:

```
# 15 rapid POSTs from the same source — 11th onward should 429.
for i in $(seq 1 15); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST http://localhost:3000/events/$LOAD_TEST_EVENT_ID/register \
    -H 'Content-Type: application/json' \
    -H "X-CSRF-Token: $TOKEN" \
    -H "Cookie: $COOKIE" \
    -d '{"email":"a@a","firstName":"a","lastName":"a","phone":"1"}' &
done
wait
```

Expected output: ten `400` (because the body fails validation — but the
rate limiter sees the request first), then five `429`. If you see
fifteen `400`s, the rate limiter isn't engaging — investigate.

---

## Common gotchas

- **CSP and Stripe.js:** The CSP in `src/web/app.ts` already allows
  `js.stripe.com`. If you see CSP errors in the browser console during
  a manual test, the meta tag may have been overridden somewhere — check
  the response `Content-Security-Policy` header.

- **Webhook signature failures:** If Stripe CLI is restarted, its
  `whsec_…` changes. Your app needs to be restarted with the new value
  in `STRIPE_WEBHOOK_SECRET`. Symptom: `[webhook] signature verification
  failed`. Fix: copy the new secret from the CLI output and restart the
  app.

- **`No such payment_intent`:** Means you're using a PI ID created with
  one Stripe account against a different account. Your `STRIPE_SECRET_KEY`
  must match the account that originated the PI. The Stripe CLI also has
  to be authed against the same account.

- **Idempotency replay:** Re-running the same test script with the same
  registration emails will hit `ALREADY_REGISTERED` from
  `sp_initiate_registration`. The load test script above appends
  `Date.now()` to the email to avoid this.

- **Reconciliation runner advisory lock:** If you're running the
  reconciliation runner (`reconciliation-runner.ts`) concurrently with
  load tests, only one runner at a time will actually sweep (by design,
  fix #12). The other returns immediately with empty counts. This is
  correct behavior; don't be alarmed by "another worker holds the
  advisory lock; skipping sweep" log lines.

---

## When you're done testing

1. **Rotate the Stripe test keys** if you suspect they leaked anywhere
   (CI logs, screenshots, etc.). Dashboard → Developers → API keys →
   "Roll key".

2. **Don't deploy these scripts to production**. The load test script
   in particular hardcodes `pm_card_visa` (a test-mode-only payment
   method). Add it to `.dockerignore` or `scripts/` should be excluded
   from the production build.

3. **Document the run.** A short note in your project journal: "Load
   tested 180 registrations at 3 req/s on YYYY-MM-DD, p95 = ?ms,
   zero 429s" beats trying to reconstruct it later.

---

## TL;DR / Punch list

When you sit down to do this:

- [ ] Stripe CLI installed and authed (`stripe login`)
- [ ] GitHub secrets set: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`
- [ ] Local Postgres running, schema applied, test event seeded
- [ ] App runs locally with the three env vars set
- [ ] `stripe listen --forward-to localhost:3000/webhooks/stripe` running in a side terminal
- [ ] Run `npx tsx src/registration/testing/run-all-tests.ts` (mock baseline) — must pass
- [ ] Refactor at least one increment test to inject `StripeClient` and run it live (B.4 template)
- [ ] Run the load test at 3 req/s for 60s; verify zero 429s, capacity invariant holds
- [ ] Verify rate limiter blocks the 11th rapid request (C.3)
- [ ] Spot-check the Stripe dashboard to see the test PaymentIntents you created
