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

## Part D — End-to-end browser test with real Stripe.js

The load test in Part C is a server-side script: it skips the browser
entirely and confirms PaymentIntents directly via the Stripe SDK using
`pm_card_visa`. That validates the **server** flow but not the **client**
flow — Stripe.js loading from `js.stripe.com`, the embedded card Element
iframe collecting card data, the `stripe.confirmPayment()` call from the
browser, and the redirect-and-confirm dance that real users go through.

This part covers two scenarios for the *real* end-to-end:

- **D.1** — Headless automation (Playwright) suitable for an agent like
  GitHub Copilot to run in its container.
- **D.2** — Manual testing in an ephemeral environment (a throwaway
  Fly.io app) with a real browser and the full webhook delivery loop.

Both rely on the same app build; the difference is who's clicking buttons
and how webhooks get back to the server.

### D.1 Headless agent test (Playwright + Stripe.js)

Goal: an agent in a container with no inbound network can drive a real
browser through the registration page, fill the actual Stripe Element,
submit, and verify the resulting DB state.

#### D.1.1 Install Playwright

```
npm install --save-dev @playwright/test
npx playwright install --with-deps chromium
```

In Copilot's container, `--with-deps` pulls in the system libraries
Chromium needs (libnss3, libxkbcommon, etc.). On a barebones Alpine
container this can take a minute.

#### D.1.2 Run the app + Stripe CLI listener

The agent needs **both** running before the test starts:

```
# Background the app:
DATABASE_URL=postgresql://localhost/flyte_test \
STRIPE_SECRET_KEY=sk_test_… \
STRIPE_PUBLISHABLE_KEY=pk_test_… \
STRIPE_WEBHOOK_SECRET=whsec_… \
npx tsx src/index.ts &
APP_PID=$!

# Background the Stripe CLI tunnel:
stripe listen --forward-to localhost:3000/webhooks/stripe \
  --events payment_intent.amount_capturable_updated,payment_intent.payment_failed &
STRIPE_PID=$!

# Wait for both to be ready:
sleep 5
curl -fsS http://localhost:3000/ >/dev/null  # confirm app is up
```

The `whsec_…` for `STRIPE_WEBHOOK_SECRET` must be the one printed by
`stripe listen` on this run. To make the agent self-contained, capture it
programmatically:

```
WHSEC=$(stripe listen --print-secret 2>/dev/null)
export STRIPE_WEBHOOK_SECRET=$WHSEC
```

`stripe listen --print-secret` is non-interactive: it prints the signing
secret for the CLI's authenticated session and exits. Use that **before**
starting the actual `stripe listen` tunnel and the app, so the secret is
known up front.

#### D.1.3 Playwright test script

Drop this at `tests/e2e/registration.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
const EVENT_ID = process.env.E2E_EVENT_ID;

test.describe('Registration E2E with real Stripe.js', () => {
  test.beforeAll(() => {
    if (!EVENT_ID) throw new Error('Set E2E_EVENT_ID to a seeded test event UUID');
  });

  test('successful registration with test card 4242', async ({ page }) => {
    // 1. Load the registration page. Stripe.js loads from js.stripe.com.
    await page.goto(`${BASE_URL}/events/${EVENT_ID}/register`);
    await expect(page.locator('h1')).toContainText(/register/i);

    // 2. Fill the personal info fields.
    const ts = Date.now();
    await page.fill('input[name="firstName"]', 'E2E');
    await page.fill('input[name="lastName"]', `Test${ts}`);
    await page.fill('input[name="email"]', `e2e+${ts}@example.com`);
    await page.fill('input[name="phone"]', '5551234567');

    // 3. Fill the Stripe Payment Element. The Element renders inside a
    // cross-origin iframe served from js.stripe.com. Playwright addresses
    // it via frameLocator. The iframe's `name` is generated by Stripe.js
    // and looks like __privateStripeFrame####. Match by URL pattern.
    const stripeFrame = page.frameLocator('iframe[src*="js.stripe.com"]').first();
    // Card number field inside the Element:
    await stripeFrame.locator('[name="number"]').fill('4242424242424242');
    await stripeFrame.locator('[name="expiry"]').fill('12 / 34');
    await stripeFrame.locator('[name="cvc"]').fill('123');
    // Postal code is shown for US-billing Elements:
    const zipField = stripeFrame.locator('[name="postalCode"]');
    if (await zipField.count() > 0) await zipField.fill('94107');

    // 4. Submit. The page calls stripe.confirmPayment({ elements, ... })
    // which triggers Stripe.js to confirm the PI and either redirect to
    // the return_url or update the URL in-place on success.
    await page.click('button[type="submit"]');

    // 5. The app routes the post-confirm flow to /registration/:id/confirmed.
    await page.waitForURL(/\/registration\/[a-f0-9-]+\/confirmed/, { timeout: 30_000 });
    await expect(page.locator('body')).toContainText(/confirmed|success/i);
  });

  test('declined card 4000-0000-0000-9995 shows failure page', async ({ page }) => {
    await page.goto(`${BASE_URL}/events/${EVENT_ID}/register`);
    const ts = Date.now();
    await page.fill('input[name="firstName"]', 'Decline');
    await page.fill('input[name="lastName"]', `Test${ts}`);
    await page.fill('input[name="email"]', `decline+${ts}@example.com`);
    await page.fill('input[name="phone"]', '5551234567');

    const stripeFrame = page.frameLocator('iframe[src*="js.stripe.com"]').first();
    await stripeFrame.locator('[name="number"]').fill('4000000000009995');
    await stripeFrame.locator('[name="expiry"]').fill('12 / 34');
    await stripeFrame.locator('[name="cvc"]').fill('123');
    const zipField = stripeFrame.locator('[name="postalCode"]');
    if (await zipField.count() > 0) await zipField.fill('94107');

    await page.click('button[type="submit"]');

    // Expect either the failure view or an inline error message from
    // Stripe.js. The current implementation renders 'registration-payment-failed'
    // when the server-side confirm path returns PAYMENT_FAILED, but a
    // client-side decline may also show as an inline error before any
    // server roundtrip. Accept either.
    await Promise.race([
      page.waitForURL(/payment-failed/, { timeout: 30_000 }),
      page.waitForSelector('text=/declined|insufficient/i', { timeout: 30_000 }),
    ]);
  });
});
```

Add a minimal `playwright.config.ts` at the repo root:

```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1,            // serial: avoid race over the test event's slot count
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
```

#### D.1.4 Run it

```
# Pre-seed the test event:
psql "$DATABASE_URL" -c "
  INSERT INTO events (event_id, name, event_date, total_capacity, available_slots, registration_fee_cents)
  VALUES (gen_random_uuid(), 'E2E Test', now()+interval '30 days', 100, 100, 5000)
  RETURNING event_id;" \
  | grep -E '[0-9a-f-]{36}' | tr -d ' '

# Capture the UUID printed above:
export E2E_EVENT_ID=<that UUID>

# (App + stripe listen already running per D.1.2)
npx playwright test tests/e2e/registration.spec.ts
```

On failure, Playwright drops a `playwright-report/` directory with HTML
traces and screenshots. The agent can attach those to its PR comment for
the human reviewer to look at.

#### D.1.5 What this test actually verifies (vs. what it doesn't)

**Verifies:**
- Stripe.js loads from `js.stripe.com` despite the CSP (regression check
  for fix #5 / earlier CSP work).
- The Payment Element renders and accepts input.
- `stripe.confirmPayment()` succeeds against the real Stripe API.
- The redirect or in-place navigation to `/registration/:id/confirmed`
  works after confirm.
- Webhook delivery via Stripe CLI tunnel reaches `/webhooks/stripe` and
  the handler processes it.
- DB ends in the expected state (run a follow-up query to verify
  `CONFIRMED` status and capacity invariant — see Part C.2).

**Does NOT verify:**
- 3DS challenges (test card `4000 0027 6000 3184`) — Playwright would
  need to interact with the 3DS popup iframe, which is doable but adds
  complexity. Worth a separate test if the audience expects 3DS support.
- The webhook-only path (Path A) without the client confirm step. The
  current registration-form.ejs always client-confirms. To test pure
  Path A, you'd need a separate route that creates a PI and skips the
  client confirm, then triggers the webhook via `stripe trigger`.
- Race conditions between concurrent registrations on a near-full event —
  use the load test from Part C for that.

### D.2 Manual test in an ephemeral Fly.io environment

For when you (the human) want to walk through the flow yourself with a
real browser, on infrastructure that resembles production but isn't
production, and tear it all down afterwards.

#### D.2.1 Spin up an ephemeral Fly app

```
# From the repo root:
fly launch --name flyte-stripe-test-$(date +%s) \
  --region <your-region> \
  --no-deploy \
  --copy-config \
  --yes
```

`--no-deploy` lets you set secrets before the first deploy. The
`--name` includes a timestamp so multiple test apps coexist without
collision.

#### D.2.2 Provision the test database

Either:

- **Quick path:** attach a Fly Postgres cluster: `fly postgres create`
  then `fly postgres attach <cluster-name> --app <test-app-name>`. This
  sets `DATABASE_URL` automatically.
- **Throwaway path:** point `DATABASE_URL` at a temporary Neon/Supabase
  free-tier instance. Saves Fly Postgres provisioning time. Set with:
  `fly secrets set DATABASE_URL=postgresql://… --app <test-app-name>`.

Apply the migration:

```
# Locally, against the same DB:
psql "$DATABASE_URL" -f db/migrations/005_registration_schema.sql
```

#### D.2.3 Set Stripe secrets on the Fly app

```
fly secrets set --app <test-app-name> \
  STRIPE_SECRET_KEY=sk_test_… \
  STRIPE_PUBLISHABLE_KEY=pk_test_… \
  STRIPE_WEBHOOK_SECRET=<placeholder, will update after D.2.5> \
  SESSION_SECRET=$(openssl rand -hex 32)
```

#### D.2.4 First deploy

```
fly deploy --app <test-app-name>
```

After it boots, `fly status --app <test-app-name>` shows the public
hostname (e.g. `https://flyte-stripe-test-1714000000.fly.dev`).

#### D.2.5 Configure a real Stripe webhook endpoint

Now that you have a public URL:

1. Stripe Dashboard (test mode) → Developers → Webhooks → **Add endpoint**.
2. URL: `https://flyte-stripe-test-….fly.dev/webhooks/stripe`
3. Events to send: `payment_intent.amount_capturable_updated`,
   `payment_intent.payment_failed`.
4. Save. Click into the new endpoint → **Signing secret** → reveal,
   copy the `whsec_…`.
5. Update the Fly secret:
   ```
   fly secrets set --app <test-app-name> STRIPE_WEBHOOK_SECRET=whsec_…
   ```
6. Wait for Fly to roll the deployment (`fly status --app <test-app-name>`).

#### D.2.6 Seed a test event

```
psql "$DATABASE_URL" -c "
  INSERT INTO events (name, event_date, total_capacity, available_slots, registration_fee_cents)
  VALUES ('Manual E2E Test', now()+interval '30 days', 10, 10, 2500)
  RETURNING event_id;"
```

#### D.2.7 Run the manual flow

1. Open `https://<test-app-name>.fly.dev/events/<event_id>/register` in
   your browser.
2. Fill the form with arbitrary fake data (the input validation from
   fix #14 enforces presence + length but accepts anything that looks
   shaped right).
3. Use test card `4242 4242 4242 4242`, expiry `12/34`, CVC `123`,
   ZIP `94107`.
4. Click submit. The browser performs `stripe.confirmPayment(...)`,
   which goes to Stripe's servers. Stripe authorizes the card and
   transitions the PI to `requires_capture`.
5. Two things now happen in parallel:
   - **Path A:** Stripe POSTs `payment_intent.amount_capturable_updated`
     to your `/webhooks/stripe` endpoint. The handler captures the PI
     and finalizes the registration.
   - **Path B:** The browser POSTs `/registration/confirm/:piId`. If
     this races ahead of the webhook, it does the capture itself; if
     the webhook already finished, the SP returns IDEMPOTENT_REPLAY
     and the redirect goes to the confirmed page anyway.
6. You land on `/registration/<id>/confirmed`. Verify in DB:
   ```
   psql "$DATABASE_URL" -c "
     SELECT registration_id, status, gross_amount_cents, net_amount_cents,
            confirmed_at, confirmation_email_sent_at
     FROM registrations
     WHERE email LIKE 'whatever-you-used%' ORDER BY created_at DESC LIMIT 1;
   "
   ```
   Expected: `status = 'CONFIRMED'`, `confirmed_at` populated,
   `net_amount_cents = 2500`.
7. Verify the event capacity decremented:
   ```
   psql "$DATABASE_URL" -c "
     SELECT total_capacity, confirmed_count, available_slots
     FROM events WHERE event_id = '<event_id>'::UUID;"
   ```
   Expected: `confirmed_count = 1`, `available_slots = 9`,
   `total_capacity = confirmed_count + available_slots`.
8. Visit Stripe Dashboard → test mode → Payments. You should see your
   test PaymentIntent with status "Succeeded".

#### D.2.8 Test the failure path

Repeat D.2.7 with declined card `4000 0000 0000 9995`. Expected:
- Stripe.js shows an inline error or the page navigates to
  `registration-payment-failed`.
- DB row exists with `status = 'PAYMENT_FAILED'` (from `sp_fail_registration`)
  or never advances past `PENDING_PAYMENT` (if the decline happened
  before our server saw any signal — reconciliation will eventually
  expire it).
- `available_slots` returns to its original value.

#### D.2.9 Test the refund path

Pick a `CONFIRMED` registration's UUID. Then either:

- Add a temporary admin route that calls `RefundService.refundRegistration({...})`,
  hit it from `curl`.
- Or invoke directly via `psql`+ a test script:
  ```typescript
  // scripts/manual-refund-test.ts
  import 'dotenv/config';
  import { RefundService } from './src/registration/services/RefundService.js';
  // ... wire up Stripe + NotificationService + invoke .refundRegistration()
  ```

Verify:
- Stripe Dashboard shows a "Refunded" payment.
- DB row has `status = 'CANCELLED'`, `refunded_amount_cents = net_amount_cents`
  (this is the fix #7 you want to confirm — should equal the captured
  amount, not gross).

#### D.2.10 Tear down

```
fly apps destroy <test-app-name>     # destroys the app + machines
fly postgres destroy <pg-cluster>    # if you used Fly Postgres
# In Stripe Dashboard: delete the webhook endpoint you created in D.2.5
```

Stripe test-mode PaymentIntents stick around in the dashboard forever
but don't affect anything; ignore them or batch-cancel via
`stripe payment_intents cancel <id>` if the noise bothers you.

#### D.2.11 Sanity-check before tearing down

Things to glance at while the app is still up:

- Click around the public URL and verify CSP doesn't break anything in
  the browser console.
- Tail Fly logs: `fly logs --app <test-app-name>`. Look for unexpected
  errors during the registration flow. The new advisory-lock log line
  ("[reconciliation] another worker holds the advisory lock; skipping
  sweep") is **expected** noise if you have multiple worker machines —
  one acquires, the others skip.
- Check the worker process is actually running supercronic and the
  reconciliation is firing on schedule:
  `fly logs --app <test-app-name> | grep "\[reconciliation\] sweep"`.
  Should appear every 5 minutes per `crontab`.

---

## Choosing between D.1, D.2, and Part C's load test

| Scenario                                              | Use   |
|-------------------------------------------------------|-------|
| Agent regression run in a container, no public URL    | **D.1** (Playwright + Stripe CLI tunnel) |
| Human eyes-on test, full webhook delivery loop        | **D.2** (ephemeral Fly app) |
| Throughput / rate-limit / capacity-invariant testing  | **Part C** (server-side script, no browser) |
| Ad-hoc one-shot of a single scenario                  | **D.2** without ephemeral — just run the app locally + Stripe CLI |

Mix and match: spin up a D.2 Fly app, then point a D.1 Playwright run at
its public URL by setting `BASE_URL=https://flyte-stripe-test-….fly.dev`.
That gives you Playwright automation against real-internet Stripe webhook
delivery, no CLI tunnel needed.

---



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
- [ ] (Optional, agent path) Install Playwright, run `tests/e2e/registration.spec.ts` (D.1)
- [ ] (Optional, manual path) Spin up an ephemeral Fly test app per D.2; walk through the registration in a real browser
- [ ] Spot-check the Stripe dashboard to see the test PaymentIntents you created
- [ ] Tear down the ephemeral Fly app and the dashboard webhook endpoint when done
