# Flyte Load-Test Testbed — Technical Reference

This document is a technical deep-dive into the load-testing infrastructure.
It explains the architecture, describes every significant design decision, and
documents the internals of each component.  The audience is a developer who
needs to understand, extend, or debug the testbed.

---

## Table of Contents

1. [Architecture overview](#1-architecture-overview)
2. [The two-phase registration flow](#2-the-two-phase-registration-flow)
3. [stripe_simulator.py — design and internals](#3-stripe_simulatorpy)
4. [stress_test.py — design and internals](#4-stress_testpy)
5. [stripe-factory.ts — simulator hook](#5-stripe-factoryts)
6. [Supporting files](#6-supporting-files)
7. [Design decisions and trade-offs](#7-design-decisions-and-trade-offs)
8. [Known limitations](#8-known-limitations)
9. [Extending the testbed](#9-extending-the-testbed)

---

## 1. Architecture Overview

```
┌────────────────────────────────────────────────────────────────────┐
│  Load-test runner  (your laptop / CI machine)                      │
│                                                                    │
│   stress_test.py                                                   │
│   ├─ N async workers (aiohttp)                                     │
│   │   ├─ GET /events/:id/register   → extract CSRF token           │
│   │   ├─ POST /events/:id/register  → Phase 1                      │
│   │   ├─ POST <simulator>/v1/payment_intents/:id/confirm            │
│   │   │       (browser-confirm simulation)                         │
│   │   └─ POST /registration/confirm/:piId  → Phase 3               │
│   └─ RunStats → results.json + rich terminal report                │
└─────────────────────────────────────┬──────────────────────────────┘
                                      │ HTTPS (or HTTP)
                        ┌─────────────▼──────────────┐
                        │   Flyte app  (Node.js)      │
                        │   POST /events/:id/register │
                        │   POST /registration/confirm│
                        │   stripe-factory.ts ──────┐ │
                        └───────────────────────────┼─┘
                                       internal     │
                        ┌──────────────────────────▼─┐
                        │  stripe_simulator.py        │
                        │  (FastAPI on :12111)        │
                        │  POST /v1/payment_intents   │
                        │  GET  /v1/payment_intents/* │
                        │  POST …/capture             │
                        │  POST …/cancel              │
                        │  POST /v1/refunds           │
                        └─────────────────────────────┘
                                      │
                        ┌─────────────▼──────────────┐
                        │   PostgreSQL                │
                        │   events, registrations,    │
                        │   sessions tables           │
                        └─────────────────────────────┘
```

### Data flow for one successful registration

```
stress_test.py worker
  1.  GET  /events/:id/register
        ← 200 HTML — extracts CSRF token from hidden input
  2.  POST /events/:id/register  {email, firstName, lastName}
        → app checks CSRF, validates event availability
        → app calls stripe_simulator: POST /v1/payment_intents
              ← {id: "pi_sim_…", clientSecret: "…", status: "requires_payment_method"}
        → app inserts row into registrations (status=PENDING_PAYMENT)
        ← 200 JSON {paymentIntentId, clientSecret, registrationId}
  3.  POST stripe_simulator /v1/payment_intents/:id/confirm
        (stress_test bypasses the browser Stripe.js step)
        → simulator transitions PI status: requires_payment_method → requires_capture
        ← 200 JSON {paymentIntent: {status: "requires_capture", …}}
  4.  POST /registration/confirm/:piId
        → app calls stripe_simulator: GET /v1/payment_intents/:id
              ← {status: "requires_capture"}
        → app calls stripe_simulator: POST /v1/payment_intents/:id/capture
              ← {status: "succeeded", amount_received: 5000}
        → app updates registrations (status=CONFIRMED, net_amount_cents=5000)
        → app decrements events.available_slots (via advisory-lock transaction)
        ← 302 redirect to /confirmed/:registrationId
```

---

## 2. The Two-Phase Registration Flow

Understanding why the registration is split into two HTTP round-trips is
essential context for the testbed design.

### Why two phases?

Stripe's recommended pattern for payment capture on card-not-present
transactions is:

1. **Create a PaymentIntent** server-side with `capture_method: "manual"`.
   This reserves the funds on the card but does not yet charge it.
2. **Confirm the PaymentIntent** client-side using `stripe.confirmPayment()`
   in the browser (Stripe.js).  This is where the user enters their card
   details directly into a Stripe-hosted iframe so that raw card data never
   touches your server.
3. **Capture the PaymentIntent** server-side after verifying the payment is in
   `requires_capture` state.  This actually charges the card.

This split is why the Flyte registration endpoint has distinct "Phase 1" and
"Phase 3" legs (there is no server-side "Phase 2" — that happens entirely in
the Stripe.js browser SDK):

| Phase | HTTP call | Who calls it |
|-------|-----------|-------------|
| 1 | `POST /events/:id/register` | Browser (via HTMX form) |
| 2 (implicit) | `stripe.confirmPayment()` | Stripe.js in the browser |
| 3 | `POST /registration/confirm/:piId` | Browser after Stripe.js returns |

### How the stress test bridges the browser gap

Because there is no real browser in a load test, `stress_test.py` directly
calls the simulator's `/v1/payment_intents/:id/confirm` endpoint between Phase
1 and Phase 3.  This endpoint transitions the PaymentIntent from
`requires_payment_method` to `requires_capture` — exactly what
`stripe.confirmPayment()` does in a real browser.

The `--simulator-url` option tells the stress test where to find the simulator
for this step.  When running against a remote Fly.io deployment the simulator
lives on the server's internal network and is not reachable from the laptop;
in that case `--simulator-url` is omitted and Phase 3 will still exercise the
Flyte confirm endpoint (the PI will be captured — it just needs to already be
in `requires_capture` state from a prior browser-side confirm).  For full
end-to-end coverage from a local machine, run the simulator locally and point
`--simulator-url` at it.

---

## 3. `stripe_simulator.py`

### Purpose

A minimal FastAPI server that mimics the subset of the Stripe REST API used by
the Flyte registration flow.  Goals:

- Allow load testing with no real Stripe credentials.
- Avoid Stripe's rate limits (which would throttle a load test almost immediately).
- Allow deterministic fault injection (controlled failure rates, artificial latency).
- Be fast enough that the simulator itself is not the bottleneck.

### State model

All PaymentIntent state is stored in a Python `dict` in process memory:

```python
_INTENTS: dict[str, dict[str, Any]] = {}
```

This is intentional.  For a load test, durability is not needed — we only
care about the round-trip behaviour.  The trade-off is that state is lost if
the simulator process restarts.  For a multi-worker uvicorn deployment
(`--workers 4`) each worker process has its own `_INTENTS` dict; requests
from the same Flyte app connection may not land on the same worker.  To avoid
cross-worker state misses, run the simulator with a single worker during tests,
or add Redis-backed state if persistence matters.

> **Current default** (`Dockerfile.simulator`): `--workers 4`.  For load
> testing from a single Flyte app instance this is fine because the Flyte app
> reuses its own HTTP connection pool; requests from one Node process will
> typically land on the same uvicorn worker.  If you see `404 No such
> PaymentIntent` errors during load tests, switch to `--workers 1`.

### PaymentIntent lifecycle

```
requires_payment_method
       │
       │  POST /v1/payment_intents/:id/confirm
       ▼
requires_capture
       │
       │  POST /v1/payment_intents/:id/capture  (success)
       ▼
succeeded
       │
       │  POST /v1/payment_intents/:id/cancel
       ▼
canceled
```

### Fault injection

Controlled by environment variables read at request time (so they can be
changed on a running process via `fly secrets set` or in a `.env` file):

| Variable | Behaviour |
|----------|-----------|
| `STRIPE_SIM_CREATE_DELAY_MS` | `asyncio.sleep()` before responding to `POST /v1/payment_intents` |
| `STRIPE_SIM_CAPTURE_DELAY_MS` | `asyncio.sleep()` before responding to capture |
| `STRIPE_SIM_CAPTURE_FAIL_RATE` | `random.random() < rate` → return a `card_declined` 400 response |
| `STRIPE_SIM_CAPTURE_TRANSIENT_RATE` | `random.random() < rate` → return a 500 `api_error` response |

Permanent failures (`CAPTURE_FAIL_RATE`) simulate cards that are declined.
The Flyte app should mark those registrations as `PAYMENT_FAILED` and release
the slot.  Transient failures (`CAPTURE_TRANSIENT_RATE`) simulate Stripe API
timeouts or connectivity issues — the Flyte app's reconciliation job should
retry these.

### Routes implemented

| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/health` | Liveness check — returns `{"status":"ok"}` |
| `POST` | `/v1/payment_intents` | Create PI; supports form-encoded and JSON bodies |
| `GET` | `/v1/payment_intents/{id}` | Retrieve PI by ID |
| `POST` | `/v1/payment_intents/{id}/confirm` | Simulate browser Stripe.js confirm |
| `POST` | `/v1/payment_intents/{id}/capture` | Capture (supports fault injection) |
| `POST` | `/v1/payment_intents/{id}/cancel` | Cancel |
| `POST` | `/v1/refunds` | Create refund (always succeeds; not fault-injected) |
| `DELETE` | `/v1/payment_intents` | Test-only: clear all stored intents |
| `*` | `/{path:path}` | Catch-all: returns 501 for any unimplemented route |

The catch-all is important — if the Flyte app calls a Stripe endpoint that the
simulator doesn't implement, you'll see a clear `501 route not implemented`
error rather than a confusing connection refused or 404.

---

## 4. `stress_test.py`

### Concurrency model

The script uses Python's `asyncio` with `aiohttp` for all HTTP I/O.  The key
design choices:

**Single shared `aiohttp.ClientSession`** — all workers share one session with
a single TCP connection pool (`TCPConnector`).  This is realistic: in
production the Flyte app sees a mix of connections from different browser
clients and load balancers.  Using one shared session also avoids the overhead
of TLS handshake × N workers.

**`asyncio.Semaphore(concurrency)`** — caps the number of in-flight requests.
Even though `asyncio.create_task` schedules all N tasks upfront, only
`concurrency` of them run simultaneously.  This is more faithful to a real
browser-based load than a thread-per-request model because it measures server
throughput under sustained concurrent load rather than burst.

**Worker per-session isolation** — each `RegistrationWorker` maintains its own
CSRF token and cookie jar entry.  This is necessary because the Flyte app binds
the CSRF token to the session: a token from worker A is rejected if sent with
worker B's session cookie.  Workers call `GET /events/:id/register` once at
startup to acquire their token, then reuse it for all subsequent requests.

**Round-robin work distribution** — attempts are assigned to workers as
`workers[i % concurrency]`.  This ensures that each worker handles
approximately `total / concurrency` attempts, spreading the load evenly.

### Ramp-up

`--ramp-up N` introduces a delay of `N / concurrency` seconds between each
worker's first request.  This prevents a thundering-herd cold start (which can
skew the first-request latency numbers) and is more representative of a real
traffic ramp-up.

### Outcome classification

Each HTTP response is classified into a high-level outcome string.  The mapping:

**Phase 1 outcomes:**

| HTTP status | Body | Outcome |
|-------------|------|---------|
| 200 | `clientSecret` present | `SUCCESS` |
| 400 | `error: already_registered` | `ALREADY_REGISTERED` |
| 400 | other | `VALIDATION_ERROR` |
| 403 | — | `CSRF_REJECTED` |
| 404 | — | `NOT_FOUND` |
| 429 | — | `RATE_LIMITED` |
| 503 | — | `STRIPE_ERROR` |
| timeout / network | — | `NETWORK_ERROR` |
| other | — | `ERROR` |

**Phase 3 outcomes:**

| HTTP status | Location header | Outcome |
|-------------|-----------------|---------|
| 3xx | contains `/confirmed` | `SUCCESS` |
| 3xx | contains `waitlist` | `FULL` |
| 3xx | other | `REDIRECT` |
| 200 | — | `SUCCESS` |
| 403 | — | `CSRF_REJECTED` |
| 429 | — | `RATE_LIMITED` |
| other | — | `ERROR` |

### Percentile calculation

Percentiles are computed using the standard sorted-array method:

```python
idx = int((len(latencies) - 1) * p / 100)
```

Using `(n - 1)` rather than `n` ensures the index never exceeds the array
bounds at `p = 100` (or `p = 99` with 100 samples).  The `p99` latency for
100 samples is therefore the 99th element (0-indexed: `latencies[98]`), which
is the standard "nearest rank" definition.

### JSON results file

Every run writes a `results.json` (path configurable with `--output`):

```json
{
  "config": { "base_url": "…", "event_id": "…", "concurrency": 20, … },
  "summary": {
    "total_duration_s": 4.31,
    "phase1": {
      "total_requests": 100,
      "throughput_rps": 23.2,
      "latency_ms": { "p50": 182.3, "p90": 389.4, "p95": 421.7, "p99": 490.1, "max": 512.0, "min": 45.1 },
      "status_codes": { "200": 98, "429": 2 },
      "outcomes": { "SUCCESS": 98, "RATE_LIMITED": 2 }
    },
    "phase3": { … }
  },
  "results": [
    { "worker_id": 0, "attempt": 0, "phase": "phase1", "status_code": 200,
      "latency_ms": 182.3, "outcome": "SUCCESS", "pi_id": "pi_sim_…", … },
    …
  ]
}
```

The `results` array contains one entry per HTTP request (including
`sim_confirm` calls if `--simulator-url` is set).  This raw data is suitable
for import into Pandas, Jupyter, or a time-series database for deeper analysis.

---

## 5. `stripe-factory.ts`

The Stripe Node.js SDK accepts `host`, `port`, and `protocol` in its
constructor options.  `stripe-factory.ts` reads three environment variables
and passes them through:

```typescript
const simHost = process.env['STRIPE_SIMULATOR_HOST'];
const simPort = process.env['STRIPE_SIMULATOR_PORT'];
const simProtocol = process.env['STRIPE_SIMULATOR_PROTOCOL'];

const extraOpts: Record<string, unknown> = {};
if (simHost) {
  extraOpts['host'] = simHost;
  if (simPort) {
    const port = parseInt(simPort, 10);
    if (port >= 1 && port <= 65535) extraOpts['port'] = port;
  }
  if (simProtocol) extraOpts['protocol'] = simProtocol;
}

_stripe = new Stripe(config.stripe.secretKey, {
  apiVersion: '2026-04-22.dahlia',
  ...extraOpts,
});
```

**Why not a mock library?**
Using the real Stripe SDK with a host redirect means:
- All Stripe SDK behaviour (retry logic, timeout, request signing, response
  parsing) is exercised exactly as it would be in production.
- The simulator receives the same HTTP requests that api.stripe.com would,
  making it easy to validate the wire format.
- No test-specific code paths in production; the toggle is purely
  configuration-driven.

**Port validation**
`parseInt` can return `NaN` (e.g. `STRIPE_SIMULATOR_PORT=notanumber`), which
the Stripe SDK would silently convert to the string `"NaN"` in the URL.  The
`port >= 1 && port <= 65535` guard ensures only valid ports are passed,
preventing a hard-to-diagnose connection failure.

**Singleton**
`_stripe` is a module-level singleton.  The first call to `getStripe()` creates
the client; all subsequent calls return the cached instance.  This means
simulator configuration is read once at startup — changing `STRIPE_SIMULATOR_*`
environment variables at runtime requires a process restart.

---

## 6. Supporting Files

### `create_test_event.py`

A small psycopg2 script that inserts a row into the `events` table and prints
the UUID to stdout.  The script is designed to be used in a subshell:

```bash
export FLYTE_EVENT_ID=$(python load_testing/create_test_event.py --capacity 2000)
```

It writes the `export` statement to **stderr** (so it is visible to the user
but not captured by the subshell) and the bare UUID to **stdout** (so the
subshell captures it cleanly).

### `Dockerfile.simulator`

A minimal `python:3.12-slim` image.  Only the packages needed to run the
FastAPI simulator are installed (`fastapi`, `uvicorn[standard]`,
`python-multipart`).  The full `requirements.txt` (which includes `aiohttp`,
`rich`, `click`, etc. for the stress test runner) is deliberately not installed
in the simulator image to keep it small.

The default `CMD` runs 4 uvicorn workers to handle concurrent Stripe SDK
connections from the Flyte app.  If you observe cross-worker state misses
(404 on retrieve/confirm), reduce to `--workers 1`.

### `docker-compose.load-test.yml`

A Compose **overlay** file, not a standalone file.  It must be combined with
the base `docker-compose.yml`:

```bash
docker compose -f docker-compose.yml -f docker-compose.load-test.yml up -d
```

The overlay adds two things:
1. A new `stripe-simulator` service built from `Dockerfile.simulator`.
2. Additional environment variables on the existing `app` service that redirect
   Stripe SDK calls to the simulator.

The `depends_on` with `condition: service_healthy` ensures the app container
does not start until the simulator passes its `GET /health` healthcheck, which
prevents the Stripe singleton from being initialised before the simulator is
ready.

### `.env.load-test`

A template `.env` file.  Copy it to `.env` at the repo root before starting
the app for load testing:

```bash
cp load_testing/.env.load-test .env
```

The `SESSION_SECRET` in this file is a weak placeholder value.  It is
intentionally labelled `not-for-production`.  For staging deployments use a
proper secret.

---

## 7. Design Decisions and Trade-offs

### Decision 1: asyncio + aiohttp over threading or locust

**Chosen:** `asyncio` with `aiohttp`.

**Alternatives considered:**
- *locust*: mature, has a web UI, good for long-running ramp tests.  Rejected
  because it adds a heavy dependency and a separate process model that makes
  CSRF-per-session management harder to control precisely.
- *threading*: simpler but GIL-limited; achieving 50–100 concurrent
  "in-flight" requests would require 50–100 OS threads and high memory
  overhead.
- *multiprocessing*: even more memory; coordination across processes is
  complex.

`asyncio` allows thousands of concurrent I/O waits with a single thread.
Since the bottleneck is always the server, not the client CPU, this is ideal.

### Decision 2: Per-worker CSRF token acquisition

Each worker calls `GET /events/:id/register` once at startup.  This is the
minimal correct approach — the server renders a CSRF token into the HTML and
ties it to the session cookie.  Sharing one token across workers would cause
403 errors because each worker has a different session cookie.

A future optimisation would be to pre-acquire all tokens in a setup phase
before the timed measurement begins, so that CSRF acquisition latency is
excluded from the throughput numbers.

### Decision 3: In-memory PaymentIntent state in the simulator

**Chosen:** Python `dict` in process memory.

**Alternative:** Redis or SQLite.

In-memory state is fast (no I/O), zero-dependency, and perfectly adequate for
a load test where the goal is to measure the *app* not the *simulator*.  The
risk of stale state between runs is mitigated by the `DELETE /v1/payment_intents`
test-only endpoint, which clears all stored intents.

### Decision 4: No real Stripe webhook simulation

The Flyte app listens for Stripe webhooks (e.g. `payment_intent.succeeded`) as
a fallback confirmation path.  The simulator does not currently emit webhooks.
The primary confirmation path (Phase 3 `POST /registration/confirm`) is the
path exercised by the load test, and this is the latency-critical path.
Webhook delivery is asynchronous and would not be captured in the per-request
latency numbers anyway.

### Decision 5: `--rate-limit-bypass` is opt-in

The rate-limiter in the Flyte app is intentionally left in place for normal
load test runs.  Hitting the rate limiter is useful data: it tells you at what
request rate per IP the limiter engages.  The `--rate-limit-bypass` flag
(which spoofs `X-Forwarded-For` headers) is only needed when you want to test
raw server capacity independently of the limiter, e.g. to validate that the
database and Stripe simulator can handle sustained write load.

### Decision 6: Phase selection (`--phase 1` vs `--phase 1+3`)

Splitting the test into phases allows targeted profiling:

- **`--phase 1`**: measures only the PI creation + DB insert path.  Fast to
  run; useful for finding database throughput limits without the overhead of
  the two-step capture flow.
- **`--phase 1+3`**: measures the full user journey including payment capture.
  This is the realistic end-to-end scenario and is the default.

The `phase1` throughput is almost always higher than `phase3` throughput
because Phase 1 only inserts a row and creates a PI, while Phase 3 also
retrieves the PI and performs a capture, then updates the row and decrements
the event counter (with an advisory lock).

---

## 8. Known Limitations

1. **Simulator state is per-worker-process**: With `--workers > 1` in uvicorn,
   PaymentIntents created by one worker process may not be visible to a
   retrieve/capture request handled by a different worker.  Use `--workers 1`
   if you see spurious 404 errors from the simulator.

2. **CSRF tokens are acquired once per worker**: If the server rotates its CSRF
   secret (or the session expires mid-run), the worker's token becomes invalid
   and all subsequent requests return 403.  The stress test will report these
   as `CSRF_REJECTED` outcomes.  Re-run the test after the session expires to
   get fresh tokens.

3. **No webhook simulation**: The simulator does not emit Stripe webhook
   events.  If the Flyte app has a code path that depends on receiving a
   `payment_intent.succeeded` webhook before confirming a registration, those
   registrations will time out rather than succeed.

4. **`--rate-limit-bypass` is layer-4 only**: Spoofing `X-Forwarded-For`
   bypasses *IP-based* rate limiting.  It does not bypass account-level or
   event-level rate limits that are enforced in the application logic itself.

5. **No latency baseline subtraction**: The `latency_ms` numbers in `results.json`
   include network round-trip time between the test runner and the server.  For
   local tests this is sub-millisecond.  For remote Fly.io tests, subtract the
   baseline round-trip (measurable with `curl -w "%{time_total}"`) to get
   server-only processing time.

6. **Single-region**: The stress test runner sends requests from one geographic
   location.  For global deployment testing, run the stress test from multiple
   machines in different regions simultaneously.

---

## 9. Extending the Testbed

### Add a new simulator endpoint

Edit `stripe_simulator.py`:

```python
@app.post("/v1/payment_intents/{pi_id}/new_action")
async def new_action(pi_id: str = Path(...)) -> JSONResponse:
    intent = _INTENTS.get(pi_id)
    if not intent:
        return JSONResponse(status_code=404, content={…})
    # mutate intent state
    return JSONResponse(content=intent)
```

The catch-all route means any unimplemented endpoint already returns a clear
`501` error, so you can always identify which routes need to be added.

### Change fault injection rates at runtime (Fly.io)

```bash
fly secrets set STRIPE_SIM_CAPTURE_FAIL_RATE=0.10 --app flyte-stripe-sim
# fly restarts the simulator automatically
```

Then run the stress test and observe how the app handles 10% permanent
capture failures (you should see `PAYMENT_FAILED` registrations in the DB
and the slot should be released).

### Add a Pandas analysis notebook

The `results.json` output is designed to be easy to analyse:

```python
import json, pandas as pd

with open("results.json") as f:
    data = json.load(f)

df = pd.DataFrame(data["results"])
p1 = df[df.phase == "phase1"]
print(p1.groupby("outcome").latency_ms.describe())
print(p1.latency_ms.quantile([0.5, 0.9, 0.95, 0.99]))
```

### Run from GitHub Actions (CI load test)

```yaml
# .github/workflows/load-test.yml
jobs:
  load-test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_USER: flyte, POSTGRES_PASSWORD: flyte, POSTGRES_DB: flyte }
        ports: ["5432:5432"]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: pip install -r load_testing/requirements.txt psycopg2-binary
      - run: npm ci && npm run build
      - name: Start simulator
        run: uvicorn stripe_simulator:app --app-dir load_testing --port 12111 &
      - name: Start app
        env:
          DATABASE_URL: postgres://flyte:flyte@localhost:5432/flyte
          STRIPE_SIMULATOR_HOST: localhost
          STRIPE_SIMULATOR_PORT: "12111"
          STRIPE_SIMULATOR_PROTOCOL: http
          STRIPE_SECRET_KEY: sk_test_sim
          SESSION_SECRET: ci-test-secret
        run: node dist/index.js &
      - run: sleep 5 && npm run migrate
      - name: Create event
        run: |
          export DATABASE_URL=postgres://flyte:flyte@localhost:5432/flyte
          echo "FLYTE_EVENT_ID=$(python load_testing/create_test_event.py)" >> $GITHUB_ENV
      - name: Run load test
        run: |
          python load_testing/stress_test.py \
            --event-id "$FLYTE_EVENT_ID" \
            --concurrency 10 \
            --total 50 \
            --phase 1+3 \
            --simulator-url http://localhost:12111
      - uses: actions/upload-artifact@v4
        with:
          name: load-test-results
          path: results.json
```
