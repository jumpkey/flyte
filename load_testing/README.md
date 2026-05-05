# Flyte Registration Load Testing

This directory contains a Python-based load/stress test suite for the Flyte
event registration endpoint.  It ships with a **Stripe API simulator** so that
realistic end-to-end load testing can happen without real Stripe credentials
and without incurring API rate limits or costs.

---

## Directory layout

```
load_testing/
├── README.md                  ← this file (quick-start and options reference)
├── DEPLOY.md                  ← step-by-step deployment guide (local, Docker, Fly.io)
├── TECHNICAL_REFERENCE.md     ← deep-dive into architecture and design decisions
├── requirements.txt           ← Python dependencies (aiohttp, fastapi, rich, click…)
├── stress_test.py             ← main load-test program
├── stripe_simulator.py        ← FastAPI Stripe API stub
├── Dockerfile.simulator       ← container image for the simulator
├── create_test_event.py       ← helper: insert a test event into the DB
└── .env.load-test             ← environment variable template
../docker-compose.load-test.yml ← Compose overlay that wires in the simulator
```

See **[DEPLOY.md](DEPLOY.md)** for the complete deployment playbook (local
dev, Docker Compose, and live Fly.io).  See
**[TECHNICAL_REFERENCE.md](TECHNICAL_REFERENCE.md)** for architecture
diagrams, component internals, and design rationale.

The `stripe-factory.ts` module in the application was extended to read three
optional environment variables (`STRIPE_SIMULATOR_HOST`, `STRIPE_SIMULATOR_PORT`,
`STRIPE_SIMULATOR_PROTOCOL`) that redirect all Stripe SDK calls to the simulator.
When those variables are unset the application behaves exactly as before.

---

## Quick Start (local, everything on one machine)

### 1. Install Python dependencies

```bash
cd load_testing
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install psycopg2-binary    # only needed for create_test_event.py
```

### 2. Start the Stripe simulator

```bash
# In a separate terminal, from the load_testing/ directory:
uvicorn stripe_simulator:app --host 127.0.0.1 --port 12111 --reload
# or
python -m uvicorn stripe_simulator:app --host 0.0.0.0 --port 12111
```

Verify it works:
```bash
curl http://localhost:12111/health
# → {"status":"ok","service":"stripe-simulator"}
```

### 3. Start the Flyte app pointed at the simulator

Copy the environment template:
```bash
cp load_testing/.env.load-test .env
```

Apply the schema (if not already done):
```bash
psql "$DATABASE_URL" -f db/migrations/005_registration_schema.sql
```

Start the app:
```bash
npm run dev
```

### 4. Create a test event

```bash
export DATABASE_URL=postgres://flyte:flyte@localhost:5432/flyte
export FLYTE_EVENT_ID=$(python load_testing/create_test_event.py --capacity 500)
echo "Event ID: $FLYTE_EVENT_ID"
```

### 5. Run the stress test

```bash
# 50 registrations, 10 concurrent workers, full two-phase flow
python load_testing/stress_test.py \
    --url http://localhost:3000 \
    --event-id "$FLYTE_EVENT_ID" \
    --concurrency 10 \
    --total 50 \
    --phase 1+3 \
    --simulator-url http://localhost:12111

# Phase 1 only (measures PI creation + DB insert, skips capture):
python load_testing/stress_test.py \
    --event-id "$FLYTE_EVENT_ID" \
    --phase 1 \
    --total 200 \
    --concurrency 20

# Aggressive test with rate-limit bypass (dev/staging only!):
python load_testing/stress_test.py \
    --event-id "$FLYTE_EVENT_ID" \
    --concurrency 50 \
    --total 500 \
    --rate-limit-bypass
```

Results are printed to the terminal and written to `results.json`.

---

## Quick Start (Docker Compose)

Use the provided overlay file to start the entire stack (Postgres + app +
Stripe simulator) with a single command:

```bash
docker compose -f docker-compose.yml -f docker-compose.load-test.yml up -d

# Apply the schema
docker compose exec app node dist/migrate.js   # or psql directly

# Create a test event
export FLYTE_EVENT_ID=$(python load_testing/create_test_event.py)

# Run the load test
python load_testing/stress_test.py \
    --url http://localhost:3000 \
    --event-id "$FLYTE_EVENT_ID" \
    --concurrency 20 \
    --total 100
```

---

## Running against a remote / Fly.io deployment

Set the target URL and event ID:

```bash
export FLYTE_URL=https://your-app.fly.dev
export FLYTE_EVENT_ID=<uuid-of-test-event>
```

For remote deployments **the Stripe simulator must be deployed alongside the
app** (or you must use real Stripe test-mode credentials).  To deploy the
simulator to Fly.io as a private service:

```bash
cd load_testing
fly launch --name flyte-stripe-sim --internal-port 12111 --no-public-ips
fly deploy --dockerfile Dockerfile.simulator
# Then set secrets on the main app:
fly secrets set STRIPE_SIMULATOR_HOST=flyte-stripe-sim.internal \
                STRIPE_SIMULATOR_PORT=12111 \
                STRIPE_SIMULATOR_PROTOCOL=http \
                STRIPE_SECRET_KEY=sk_test_sim_only \
                -a <your-main-app>
```

**Do not run the rate-limit-bypass flag against production deployments.**

---

## Stress test options reference

| Option | Default | Description |
|---|---|---|
| `--url` | `http://localhost:3000` | Flyte app base URL (also `FLYTE_URL`) |
| `--event-id` | *(required)* | Event UUID (also `FLYTE_EVENT_ID`) |
| `--concurrency` | 10 | Number of parallel async workers |
| `--total` | 50 | Total registration attempts |
| `--ramp-up` | 0 | Seconds over which workers start (0 = all at once) |
| `--phase` | `1+3` | `1` = initiate only; `1+3` = initiate + confirm |
| `--timeout` | 30 | Per-request timeout in seconds |
| `--output` | `results.json` | JSON results file path |
| `--simulator-url` | *(empty)* | Stripe simulator base URL for browser-confirm step (also `STRIPE_SIMULATOR_URL`) |
| `--rate-limit-bypass` | off | Spoof `X-Forwarded-For` to bypass per-IP rate limits |

---

## Stripe simulator options reference

All options are set via environment variables on the simulator process:

| Variable | Default | Description |
|---|---|---|
| `STRIPE_SIM_CREATE_DELAY_MS` | 0 | Artificial delay for PI create calls (ms) |
| `STRIPE_SIM_CAPTURE_DELAY_MS` | 0 | Artificial delay for capture calls (ms) |
| `STRIPE_SIM_CAPTURE_FAIL_RATE` | 0.0 | Fraction (0–1) of captures to fail permanently |
| `STRIPE_SIM_CAPTURE_TRANSIENT_RATE` | 0.0 | Fraction (0–1) of captures to fail transiently |

Example — simulate a 50 ms Stripe API latency with a 5 % permanent failure rate:

```bash
STRIPE_SIM_CAPTURE_DELAY_MS=50 \
STRIPE_SIM_CAPTURE_FAIL_RATE=0.05 \
uvicorn stripe_simulator:app --host 0.0.0.0 --port 12111
```

---

## Interpreting results

The stress test prints a summary table after each run:

```
═══ Load Test Results ═══
  Total wall-clock time: 4.31s

Phase 1 (initiate)
┏━━━━━━━━━━━━━┳━━━━━━━━━━━┓
┃ Metric      ┃     Value ┃
┡━━━━━━━━━━━━━╇━━━━━━━━━━━┩
│ Requests    │       100 │
│ Throughput  │  23.2 r/s │
│ p50         │  182.3 ms │
│ p90         │  389.4 ms │
│ p95         │  421.7 ms │
│ p99         │  490.1 ms │
│ max         │  512.0 ms │
└─────────────┴───────────┘
Outcome distribution:
  SUCCESS           95  (95.0%)
  ALREADY_REGISTERED 3  (3.0%)
  RATE_LIMITED       2  (2.0%)
```

Key metrics to watch:

- **Throughput (req/s)**: how many Phase 1 initiations the server handles per second.
- **p99 latency**: the worst-case latency experienced by 99 % of users.
- **RATE_LIMITED outcomes**: indicates the IP rate limiter is engaging.  Use
  `--rate-limit-bypass` or spread load across multiple source IPs to test
  server capacity independently of the rate limiter.
- **ERROR / NETWORK_ERROR outcomes**: unexpected failures — check the Flyte
  app logs and the `results.json` file for details.
- **ALREADY_REGISTERED**: harmless; indicates the same email was used twice
  (the test generates per-worker/attempt unique emails, so this should be zero
  unless workers are recycled across runs against the same event).

The full `results.json` contains per-request latency, status code, and outcome
for deeper analysis (e.g. import into Pandas or a Jupyter notebook).

---

## Validating the capacity invariant under load

After a load test run, verify the database invariant directly:

```sql
SELECT
    event_id,
    total_capacity,
    confirmed_count,
    available_slots,
    (confirmed_count + available_slots = total_capacity) AS invariant_ok
FROM events
WHERE event_id = '<your-event-id>';
```

`invariant_ok` must always be `true`.  The `CHECK (available_slots + confirmed_count = total_capacity)` constraint in Postgres will already reject any row that violates this, but the query above makes the check explicit.

Also verify that no registration ended in an ambiguous state:

```sql
SELECT status, count(*)
FROM registrations
WHERE event_id = '<your-event-id>'
GROUP BY status;
```

After a clean run you should see only `CONFIRMED`, `PAYMENT_FAILED`, and
`EXPIRED` rows.  `PENDING_PAYMENT` or `PENDING_CAPTURE` rows that survive past
the reconciliation TTL indicate a bug in the two-phase flow.
