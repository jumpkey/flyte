# Flyte Load-Test Deployment Guide

This document is your end-to-end playbook for deploying the Flyte application
and running the registration stress test against it.  Three deployment targets
are covered:

| Target | When to use |
|--------|-------------|
| [Local (bare-metal)](#1-local-bare-metal) | Day-to-day development; fastest iteration |
| [Local (Docker Compose)](#2-local-docker-compose) | Full-stack smoke test; mirrors production layout |
| [Fly.io (live deployment)](#3-flyio-live-deployment) | Pre-production load testing; real infrastructure scale |

---

## Prerequisites

### Required on your local machine

| Tool | Version | Install |
|------|---------|---------|
| Node.js | ≥ 20 | https://nodejs.org |
| npm | ≥ 10 | bundled with Node |
| PostgreSQL client (`psql`) | ≥ 14 | `brew install postgresql` / `apt install postgresql-client` |
| Python | ≥ 3.11 | https://python.org |
| Docker + Docker Compose | any recent | https://docs.docker.com/get-docker/ |
| `flyctl` | latest | `curl -L https://fly.io/install.sh \| sh` |
| `openssl` | any | pre-installed on macOS/Linux |

### Python virtual environment

Do this once from the repository root:

```bash
python -m venv load_testing/.venv
source load_testing/.venv/bin/activate
pip install -r load_testing/requirements.txt
pip install psycopg2-binary   # only needed for create_test_event.py
```

Activate it before every load-test session:

```bash
source load_testing/.venv/bin/activate
```

---

## 1. Local (Bare-Metal)

Everything runs on `localhost`.  This is the fastest way to iterate on the
testbed itself.

### 1a. Start Postgres

```bash
# macOS (Homebrew)
brew services start postgresql@16

# Linux / WSL
sudo systemctl start postgresql
```

Create the database and role if they don't exist yet:

```bash
psql postgres -c "CREATE ROLE flyte LOGIN PASSWORD 'flyte';"
psql postgres -c "CREATE DATABASE flyte OWNER flyte;"
```

### 1b. Apply the schema

```bash
DATABASE_URL=postgres://flyte:flyte@localhost:5432/flyte npm run migrate
```

### 1c. Start the Stripe simulator

```bash
# Terminal 1 — keep this running throughout the test
source load_testing/.venv/bin/activate
uvicorn stripe_simulator:app \
    --app-dir load_testing \
    --host 127.0.0.1 \
    --port 12111 \
    --workers 4

# Quick smoke-test
curl http://127.0.0.1:12111/health
# → {"status":"ok","service":"stripe-simulator"}
```

### 1d. Configure the app to use the simulator

```bash
# Copy the load-test env template over the project .env
cp load_testing/.env.load-test .env
```

Verify the relevant lines:

```
STRIPE_SIMULATOR_HOST=localhost
STRIPE_SIMULATOR_PORT=12111
STRIPE_SIMULATOR_PROTOCOL=http
STRIPE_SECRET_KEY=sk_test_loadtest_simulator
DATABASE_URL=postgres://flyte:flyte@localhost:5432/flyte
```

### 1e. Build and start the Flyte app

```bash
# Terminal 2
npm run build
npm run dev
# → Server running on http://localhost:3000
```

Or run the compiled output (closer to production):

```bash
npm run build
NODE_ENV=production node dist/index.js
```

### 1f. Seed the admin user (optional)

```bash
npm run seed
# Creates admin@flyte.local / changeme123
```

### 1g. Create a test event

```bash
# Terminal 3 (or any shell with the venv activated)
source load_testing/.venv/bin/activate

export DATABASE_URL=postgres://flyte:flyte@localhost:5432/flyte
export FLYTE_EVENT_ID=$(python load_testing/create_test_event.py \
    --name "Load Test Event" \
    --capacity 2000 \
    --fee-cents 5000)

echo "Event ID: $FLYTE_EVENT_ID"
```

`create_test_event.py` writes the UUID to stdout and prints the `export`
command to stderr, so the subshell trick `$(...)` captures only the UUID.

### 1h. Run the stress test

```bash
# Moderate test — 100 registrations, 20 concurrent, full Phase 1 + Phase 3
python load_testing/stress_test.py \
    --url http://localhost:3000 \
    --event-id "$FLYTE_EVENT_ID" \
    --concurrency 20 \
    --total 100 \
    --phase 1+3 \
    --simulator-url http://localhost:12111

# Phase 1 only (PI creation + DB insert; skips capture)
python load_testing/stress_test.py \
    --event-id "$FLYTE_EVENT_ID" \
    --phase 1 \
    --concurrency 50 \
    --total 500

# Aggressive — bypass per-IP rate limiting (dev only!)
python load_testing/stress_test.py \
    --event-id "$FLYTE_EVENT_ID" \
    --concurrency 100 \
    --total 1000 \
    --rate-limit-bypass \
    --ramp-up 5
```

Results are printed to the terminal and written to `results.json`.

### 1i. Validate the database invariant

```bash
psql postgres://flyte:flyte@localhost:5432/flyte <<SQL
SELECT
    total_capacity,
    confirmed_count,
    available_slots,
    (confirmed_count + available_slots = total_capacity) AS invariant_ok
FROM events
WHERE event_id = '$FLYTE_EVENT_ID';

SELECT status, count(*)
FROM registrations
WHERE event_id = '$FLYTE_EVENT_ID'
GROUP BY status;
SQL
```

`invariant_ok` must be `true`.  The only registration statuses you should see
after a clean run are `CONFIRMED`, `PAYMENT_FAILED`, and `EXPIRED`.

---

## 2. Local (Docker Compose)

Runs the full stack (Postgres + Flyte app + Stripe simulator) in containers.
Useful for testing the production Docker image locally before deploying to
Fly.io.

### 2a. Prerequisites

Ensure a `docker-compose.yml` exists at the repository root.  If it does not,
create a minimal one:

```yaml
# docker-compose.yml (minimal example — adjust to your project)
version: '3.8'
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: flyte
      POSTGRES_PASSWORD: flyte
      POSTGRES_DB: flyte
    ports:
      - "5432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U flyte"]
      interval: 5s
      timeout: 3s
      retries: 5

  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      DATABASE_URL: postgres://flyte:flyte@db:5432/flyte
      SESSION_SECRET: local-dev-secret
      NODE_ENV: production
    depends_on:
      db:
        condition: service_healthy
```

### 2b. Start the stack with the load-test overlay

```bash
docker compose \
    -f docker-compose.yml \
    -f docker-compose.load-test.yml \
    up --build -d
```

The overlay (`docker-compose.load-test.yml`) adds the `stripe-simulator`
service and injects `STRIPE_SIMULATOR_*` environment variables into the `app`
service automatically.

### 2c. Apply the schema

```bash
docker compose exec app node dist/scripts/migrate.js
# Or connect directly:
docker compose exec db psql -U flyte -d flyte -c "\dt"
```

### 2d. Create a test event

```bash
source load_testing/.venv/bin/activate

export DATABASE_URL=postgres://flyte:flyte@localhost:5432/flyte
export FLYTE_EVENT_ID=$(python load_testing/create_test_event.py --capacity 2000)
echo "Event: $FLYTE_EVENT_ID"
```

### 2e. Run the stress test

```bash
python load_testing/stress_test.py \
    --url http://localhost:3000 \
    --event-id "$FLYTE_EVENT_ID" \
    --concurrency 30 \
    --total 300 \
    --phase 1+3 \
    --simulator-url http://localhost:12111
```

### 2f. Tear down

```bash
docker compose -f docker-compose.yml -f docker-compose.load-test.yml down -v
```

---

## 3. Fly.io (Live Deployment)

This section covers deploying both the Flyte application and the Stripe
simulator to Fly.io, then running the stress test from your local machine
against the live deployment.

---

### Step 1 — Authenticate with Fly.io

```bash
fly auth login
fly version update   # ensure flyctl is up to date
```

---

### Step 2 — Create the Flyte app

If this is a brand-new deployment:

```bash
# From the repository root
fly launch --no-deploy
```

- Accept or customise the app name (e.g. `flyte`).
- Choose your primary region (`iad` = Virginia, `lhr` = London, `sin` = Singapore).
- Answer **No** to Postgres — you will provision it separately.
- Answer **No** to deploy now.

This creates (or updates) `fly.toml`.  Commit any changes:

```bash
git add fly.toml && git commit -m "chore: update fly.toml"
```

---

### Step 3 — Provision a Postgres cluster

```bash
fly postgres create \
    --name flyte-db \
    --region iad \
    --initial-cluster-size 1 \
    --vm-size shared-cpu-1x \
    --volume-size 10

# Attach the cluster → sets DATABASE_URL secret automatically
fly postgres attach flyte-db --app flyte
```

The `fly postgres attach` command prints the `DATABASE_URL` it generated and
stores it as a Fly secret.  Note the password for later use.

---

### Step 4 — Set required secrets

```bash
# Generate a strong session secret
fly secrets set \
    SESSION_SECRET=$(openssl rand -hex 32) \
    APP_DOMAIN=https://flyte.fly.dev \
    --app flyte

# SMTP (replace with your provider)
fly secrets set \
    SMTP_HOST=smtp.sendgrid.net \
    SMTP_PORT=587 \
    SMTP_USER=apikey \
    SMTP_PASS=<your-sendgrid-api-key> \
    SMTP_FROM=noreply@flyte.fly.dev \
    --app flyte

# Verify
fly secrets list --app flyte
```

---

### Step 5 — Deploy the Stripe simulator as a private Fly service

The simulator needs to be reachable from the Flyte app machine over Fly's
private WireGuard network (`.internal` DNS).  It does **not** need a public IP.

```bash
# From the load_testing/ directory
cd load_testing

fly launch \
    --name flyte-stripe-sim \
    --region iad \
    --no-deploy \
    --no-public-ips

# fly.toml is created in load_testing/; deploy with the custom Dockerfile
fly deploy \
    --dockerfile Dockerfile.simulator \
    --app flyte-stripe-sim
```

Verify the simulator is running:

```bash
# From another Fly machine or via the Fly proxy
fly proxy 12111:12111 --app flyte-stripe-sim &
curl http://localhost:12111/health
# → {"status":"ok","service":"stripe-simulator"}
```

---

### Step 6 — Configure the Flyte app to use the simulator

Wire the Flyte app to the simulator over Fly's private network:

```bash
fly secrets set \
    STRIPE_SIMULATOR_HOST=flyte-stripe-sim.internal \
    STRIPE_SIMULATOR_PORT=12111 \
    STRIPE_SIMULATOR_PROTOCOL=http \
    STRIPE_SECRET_KEY=sk_test_loadtest_simulator \
    STRIPE_PUBLISHABLE_KEY=pk_test_loadtest_simulator \
    STRIPE_WEBHOOK_SECRET=whsec_loadtest_simulator \
    --app flyte
```

> **Important:** `flyte-stripe-sim.internal` is Fly's private DNS name for the
> simulator app.  It is only resolvable from other machines in the same Fly
> organisation and is never exposed to the public internet.

---

### Step 7 — Deploy the Flyte app

```bash
cd ..   # back to repository root
fly deploy --app flyte
```

Fly.io will:
1. Build the Docker image from the `Dockerfile` in the repo root.
2. Run the release command (`node dist/scripts/migrate.js`) to apply any
   outstanding migrations.
3. Swap the running machine to the new image with zero downtime.

Watch the deploy log live:

```bash
fly logs --app flyte
```

Confirm the app is healthy:

```bash
curl -I https://flyte.fly.dev/
# → HTTP/2 200
```

---

### Step 8 — Create a test event in the live database

Connect to Postgres through the Fly proxy and insert a test event:

```bash
# Open the Fly proxy tunnel in the background
fly proxy 5433:5432 --app flyte-db &
PROXY_PID=$!

# Get the DATABASE_URL (contains password)
FLY_DB_URL=$(fly secrets list --json --app flyte \
    | python3 -c "import json,sys; s=json.load(sys.stdin); print(next(x['Value'] for x in s if x['Name']=='DATABASE_URL'))" 2>/dev/null \
    || echo "")
# Note: fly secrets list --json may not show values in all flyctl versions.
# In that case, use the URL printed during `fly postgres attach` earlier.

# Adjust the connection string (proxy listens on localhost:5433)
LOCAL_DB_URL="postgres://flyte:<PASSWORD>@localhost:5433/flyte"

source load_testing/.venv/bin/activate
export DATABASE_URL="$LOCAL_DB_URL"
export FLYTE_EVENT_ID=$(python load_testing/create_test_event.py \
    --name "Fly.io Load Test" \
    --capacity 5000 \
    --fee-cents 5000)

echo "Event ID: $FLYTE_EVENT_ID"
kill $PROXY_PID
```

Replace `<PASSWORD>` with the password that was printed during
`fly postgres attach` (or retrieve it with `fly postgres connect --app flyte-db`
and query `SELECT current_user, pg_postmaster_start_time();`).

---

### Step 9 — Run the stress test against the live deployment

```bash
source load_testing/.venv/bin/activate

export FLYTE_URL=https://flyte.fly.dev
export STRIPE_SIMULATOR_URL=    # empty — no direct access to simulator from laptop
# The simulator is called server-side by the Flyte app; the stress test does
# NOT need direct access to it for Phase 1.  For Phase 3 (confirm), the test
# calls the Flyte app's /registration/confirm endpoint which in turn captures
# via the internal simulator.  Leave --simulator-url empty or omit it.

# Moderate load test
python load_testing/stress_test.py \
    --url "$FLYTE_URL" \
    --event-id "$FLYTE_EVENT_ID" \
    --concurrency 20 \
    --total 200 \
    --phase 1+3 \
    --timeout 60 \
    --output fly_results_$(date +%Y%m%d_%H%M%S).json

# Heavy load — ramp up over 10 seconds, 50 concurrent workers
python load_testing/stress_test.py \
    --url "$FLYTE_URL" \
    --event-id "$FLYTE_EVENT_ID" \
    --concurrency 50 \
    --total 1000 \
    --ramp-up 10 \
    --phase 1+3 \
    --timeout 60 \
    --output fly_results_heavy_$(date +%Y%m%d_%H%M%S).json
```

> **Do not use `--rate-limit-bypass` against the live deployment** unless you
> have explicitly disabled or adjusted the rate limiter for the test window.

---

### Step 10 — Monitor the deployment during the test

Open a second terminal and tail the Fly logs in real time:

```bash
fly logs --app flyte
```

Watch for:
- `status: 503` — Stripe simulator not reachable from the app machine.
- `status: 429` — rate limiter engaging.
- `status: 500` — application errors; check the log for stack traces.

To see the Fly machine metrics (CPU, memory):

```bash
fly status --app flyte
fly machine status <machine-id>
```

---

### Step 11 — Validate the database invariant after the test

```bash
fly proxy 5433:5432 --app flyte-db &
PROXY_PID=$!

psql "postgres://flyte:<PASSWORD>@localhost:5433/flyte" <<SQL
-- Capacity invariant must hold
SELECT
    total_capacity,
    confirmed_count,
    available_slots,
    (confirmed_count + available_slots = total_capacity) AS invariant_ok
FROM events
WHERE event_id = '$FLYTE_EVENT_ID';

-- Registration status breakdown
SELECT status, count(*)
FROM registrations
WHERE event_id = '$FLYTE_EVENT_ID'
GROUP BY status
ORDER BY count DESC;
SQL

kill $PROXY_PID
```

---

### Step 12 — Cleanup after load testing

Remove the test event (or simply close it) so it doesn't clutter the live app:

```bash
fly proxy 5433:5432 --app flyte-db &
PROXY_PID=$!

psql "postgres://flyte:<PASSWORD>@localhost:5433/flyte" \
    -c "DELETE FROM events WHERE event_id = '$FLYTE_EVENT_ID';"

kill $PROXY_PID
```

If you want to tear down the simulator app completely:

```bash
fly apps destroy flyte-stripe-sim --yes
# And remove the simulator secrets from the main app
fly secrets unset \
    STRIPE_SIMULATOR_HOST STRIPE_SIMULATOR_PORT \
    STRIPE_SIMULATOR_PROTOCOL \
    --app flyte
# Re-set real Stripe credentials
fly secrets set \
    STRIPE_SECRET_KEY=sk_live_... \
    STRIPE_PUBLISHABLE_KEY=pk_live_... \
    STRIPE_WEBHOOK_SECRET=whsec_... \
    --app flyte
fly deploy --app flyte
```

---

## Scaling the deployment for heavy load tests

The default `fly.toml` runs a single shared-CPU-1x machine.  To test higher
concurrency you should scale up before the test and scale back down after.

```bash
# Scale to a dedicated CPU and more memory
fly scale vm performance-1x --memory 1024 --app flyte

# Add a second machine for HA
fly scale count 2 --app flyte

# ... run the load test ...

# Restore to defaults
fly scale vm shared-cpu-1x --memory 512 --app flyte
fly scale count 1 --app flyte
```

The `[http_service.concurrency]` stanza in `fly.toml` controls the Fly-side
request queue:

```toml
[http_service.concurrency]
  type = "requests"
  soft_limit = 150
  hard_limit = 200
```

When the machine is handling ≥ 150 requests simultaneously, Fly marks it as
busy and starts routing new connections to other machines.  At 200 it begins
returning 503.  Adjust these values if you want to test behaviour at the queue
boundary.

---

## Quick-reference: environment variables

### Flyte app (set as Fly secrets or in `.env`)

| Variable | Required | Notes |
|----------|----------|-------|
| `DATABASE_URL` | Yes | Set automatically by `fly postgres attach` |
| `SESSION_SECRET` | Yes | 64+ random hex chars |
| `APP_DOMAIN` | Yes | Full URL, e.g. `https://flyte.fly.dev` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Yes | SMTP relay credentials |
| `STRIPE_SECRET_KEY` | Yes | Real key in production; dummy value with simulator |
| `STRIPE_PUBLISHABLE_KEY` | Yes | Served in the registration page HTML |
| `STRIPE_WEBHOOK_SECRET` | Yes | For Stripe webhook validation |
| `STRIPE_SIMULATOR_HOST` | No | Hostname of the simulator; unset in production |
| `STRIPE_SIMULATOR_PORT` | No | Port of the simulator (default `12111`) |
| `STRIPE_SIMULATOR_PROTOCOL` | No | `http` (simulator is on an internal network) |

### Stripe simulator (set as environment variables on the simulator process)

| Variable | Default | Notes |
|----------|---------|-------|
| `STRIPE_SIM_CREATE_DELAY_MS` | `0` | Artificial latency for PI create |
| `STRIPE_SIM_CAPTURE_DELAY_MS` | `0` | Artificial latency for PI capture |
| `STRIPE_SIM_CAPTURE_FAIL_RATE` | `0.0` | Fraction (0–1) of captures to fail permanently |
| `STRIPE_SIM_CAPTURE_TRANSIENT_RATE` | `0.0` | Fraction of captures to fail transiently (retryable) |

### Stress test (CLI options or environment variables)

| `--option` / `ENV` | Default | Notes |
|--------------------|---------|-------|
| `--url` / `FLYTE_URL` | `http://localhost:3000` | Flyte app base URL |
| `--event-id` / `FLYTE_EVENT_ID` | *(required)* | Event UUID |
| `--concurrency` | `10` | Parallel async workers |
| `--total` | `50` | Total registration attempts |
| `--ramp-up` | `0` | Seconds to spread worker starts |
| `--phase` | `1+3` | `1` = initiate only; `1+3` = full flow |
| `--timeout` | `30` | Per-request timeout (seconds) |
| `--output` | `results.json` | JSON results file |
| `--simulator-url` / `STRIPE_SIMULATOR_URL` | *(empty)* | Direct simulator URL for browser-confirm step |
| `--rate-limit-bypass` | off | Spoof `X-Forwarded-For` (dev/staging only) |
