# Isolated stabilization stress tests

Use a disposable **local** database named `flyte_load_*`. Never point this
workflow at the Fly testbed or at real Stripe credentials. The Node preload
rejects non-loopback socket connections, and the scenario runner rejects remote
URLs/database hosts. This is a local capacity experiment, not a Fly sizing test.

Install the Python dependencies in a virtual environment, build the application,
and apply **all** migrations to that dedicated database. Do not copy over your
normal `.env`. In each application/recovery terminal, explicitly set:

```sh
export DATABASE_URL=postgres://flyte@127.0.0.1:55432/flyte_load_example
export TEST_DATABASE_URL="$DATABASE_URL"
export SESSION_SECRET=local-load-test-only-secret
export NODE_ENV=test PORT=53010 APP_DOMAIN=http://127.0.0.1:53010
export STRIPE_SECRET_KEY=sk_test_loadtest_simulator
export STRIPE_PUBLISHABLE_KEY=pk_test_loadtest_simulator
export STRIPE_WEBHOOK_SECRET=whsec_loadtest_simulator
export STRIPE_SIMULATOR_HOST=127.0.0.1 STRIPE_SIMULATOR_PORT=12121 STRIPE_SIMULATOR_PROTOCOL=http
export SMTP_HOST=127.0.0.1 SMTP_PORT=55998 SMTP_USER= SMTP_PASS=
npm run migrate
npm run build
```

Start these three processes in separate terminals from the repository root:

```sh
python -m uvicorn simulator_instrumented:app --app-dir load_testing --host 127.0.0.1 --port 12121 --no-access-log
node load_testing/smtp_sink.mjs
node --max-old-space-size=256 --import ./load_testing/loopback_only.mjs dist/index.js
```

The app startup log includes its PID. Use it for resource sampling:

```sh
python -m unittest discover -s load_testing -p test_stress_test.py
python load_testing/run_stabilization_stress.py \
  --dsn "$DATABASE_URL" --app-pid APP_PID --output /tmp/flyte-stress-results
```

`--scenario baseline-c50` selects one scenario. The default sequence includes
1/10/50/100/250-worker baselines, simulated processor latency, sell-out,
single-IP rate limiting, capture outage, duplicate submissions, definite card
declines, and 30,000 registrations at 100 workers with 50/150 ms processor delays.
Unique forwarded IPs exercise server capacity independently of the limiter in
this loopback-only deployment. The single-IP scenario keeps normal limiting.
This is **not** evidence that a public Fly client can spoof its trusted edge IP.

The runner pre-acquires independent sessions and CSRF tokens and keeps exactly
one in-flight attempt per worker. It checks actual business states, payment
amounts in the simulator, and SQL seat/row counts. HTTP 200 alone does not count
as a successful registration. Measurements exclude session bootstrap; phase
latencies cover initiation and client confirmation separately, while throughput
includes the complete registration/authorization/confirmation cycle.

The simulator instrumentation provides `/__load__/config` for deterministic
latency/failure settings and `/__load__/state` for independent validation. It
is a **local test service**, not an authenticated production API. The underlying
simulator does not fully model Stripe idempotency, refunds, SCA, wallets or
webhook delivery. Do not infer correctness of those features from these runs.
Card declines must use HTTP 402: modern Stripe SDKs classify HTTP 400 as an
invalid request regardless of a `card_error` body.

The outage scenario deliberately leaves reservations pending. Fault settings
are cleared at normal completion. Once the retry backoff has elapsed, run the
real recovery entry point in the same guarded environment:

```sh
node --import ./load_testing/loopback_only.mjs dist/registration/reconciliation-runner.js
```

For a deterministic recovery test, test-only rows' `last_capture_attempt_at`
may be advanced backward in this disposable database; record that clock
adjustment in results. Keep the simulator running: its intents are in memory.
If interrupted during fault injection, clear all four simulator settings before
recovery. Do not run recovery against a restarted, empty simulator and treat
missing intents as real processor failures.

Report the local hardware, Node/PostgreSQL versions, DB connection-pool size,
CPU/memory limits, request mix, data size and simulator delays with any numbers.
A short closed-loop test is not an arrival-rate capacity guarantee or a
multi-hour memory-leak test. Keep diagnostic and invalid preflight runs separate
from the final metrics. Stop only the test processes you created afterward.
