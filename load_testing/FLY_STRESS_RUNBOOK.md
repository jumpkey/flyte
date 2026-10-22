# Load testing the existing Fly testbed

This campaign uses **flyte.fly.dev**, its existing `fly.toml`, database,
512 MB shared-CPU web machines, pool size, and five-minute reconciliation worker.
It changes payment and mail destinations temporarily; it does not bypass the
application's rate limiter, resize machines, or substitute a local database.
Run only during an agreed test window: interactive checkout cannot use Stripe.js
while the server has dummy simulator credentials.

## Preparation and restoration

1. Verify the target app, deployed revision, machine configuration, and database.
   Snapshot the database volume. Save the original Stripe and SMTP environment
   values privately, including which variable names were originally absent.
   Never log credentials or put them in Git. Check for pre-existing pending
   payments, pending refunds, and cancelling events before switching processors.
2. Deploy the simulator from this directory:
   `fly deploy -c fly.simulator.toml --remote-only --ha=false`.
   Create the app first if necessary. Set a random `STRIPE_SIM_API_KEY` beginning
   `sk_test_simulator_` as an app secret before deployment. The simulator has no
   public service; it listens on IPv6 inside Fly's private network. Use a performance CPU for the simulator when measuring sustained application
   capacity, and monitor it independently: a shared-CPU simulator can itself
   exhaust burst capacity and become the bottleneck. Run exactly
   one machine and one Uvicorn worker: its payment/idempotency state is in memory.
3. Stage these testbed secrets together, then deploy them to **all** web/worker
   machines: `STRIPE_SECRET_KEY` equal to that dummy simulator key;
   `STRIPE_SIMULATOR_HOST=<simulator-app>.internal`, port `12111`, protocol `http`;
   dummy publishable key; a unique simulator webhook secret; SMTP host pointing
   at the simulator, port `1025`, empty SMTP user/password. Keep the existing
   database, session secret, API timeout, worker schedule and Fly machine settings.
   The application rejects a simulator host paired with a real-format credential,
   and rejects dummy simulator credentials without a simulator host.
4. Verify every machine has the intended revision and payment/mail destinations
   without printing credentials. Verify simulator authentication rejects missing
   credentials. Its SMTP listener discards messages; it never sends mail onward.
5. Open separate local Fly proxies to the existing database (e.g. `55433:5432`)
   and simulator (`12122:12111`). The generator runs outside the target machines.
   Use the actual database credentials with the proxy address; do not use a local
   PostgreSQL database that merely has the same name.
6. Set `FLY_LOAD_DATABASE_URL`, `STRIPE_SIMULATOR_URL`, `STRIPE_SIM_API_KEY`,
   `FLY_LOAD_ADMIN_EMAIL`, and `FLY_LOAD_ADMIN_PASSWORD` in the generator's private
   environment. Use an authenticated administrator for analytics probes.

## Campaign

Run `run_fly_stress.py --url https://flyte.fly.dev --allow-app flyte` with a separate
`--output` directory for each profile. Install `requirements.txt` in a virtualenv.

| Profile | Arguments | Purpose |
|---|---|---|
| Preflight | `--profile baseline --concurrency 5 --total 10` | Verify CSRF, payment routing, mail sink and independent reconciliation |
| Baseline | `--profile baseline --matrix` | Bounded ramp from 5 through 250 clients |
| Single event | `--profile rate-limit --concurrency 20 --total 200` | Observe actual per-machine, per-IP route throttling |
| Sellout | `--profile sellout --concurrency 50 --total 50` | Race for 10 seats |
| Outage | `--profile outage --concurrency 20 --total 40` | Preserve reservations during processor failure |
| Stochastic | `--profile stochastic --concurrency 100 --total 2000` | Jitter, long tails, declines, retryable errors and ambiguous capture responses |
| Post-commit | `--profile post-commit --concurrency 20 --total 40` | Return an error after each initial capture succeeds; verify safe retries |
| Soak | `--profile soak --concurrency 50 --total 1000 --duration-s 300` | Repeat full batches for at least five minutes with mixed admin/catalog reads |

Normal capacity profiles use multiple event routes, at most 40 attempts per
event. This keeps the **unchanged** per-IP/per-route limiter from dominating a
portfolio workload. It is not a high-rate single-event flash-sale benchmark.
The single-event profile tests the limiter separately. With multiple web
processes its in-memory counters are independent; do not assume a global limit
of exactly 60 accepted requests/minute. No Fly-Client-IP headers are spoofed.

The soak pre-provisions a reusable 200-event pool, then checks cumulative totals
after each batch. This avoids repeated event creation during the timed window.
The generator is closed-loop: each worker waits for one registration attempt
before beginning the next. A soak finishes its current batch after the duration
expires. Batch elapsed time includes session bootstrap and waiting for outstanding probes.
Integrity collection creates additional gaps between batches. Report batch
throughput separately from whole-window throughput; neither is an open-loop
arrival-rate capacity guarantee.

Stochastic settings are synthetic, not a measured Stripe service distribution:
create delay 50 ms + uniform 0–100 ms; capture delay 150 ms + uniform 0–200 ms;
each has a 2% chance of an additional 1.5 seconds. Capture fault draws are checked
in order: 2% definitive decline, 5% pre-execution 500, 2% pre-execution 429, then
2% post-commit 500. Later percentages are conditional on reaching that stage.
The seed is fixed, but concurrent scheduling changes which request receives each
draw. Post-commit failure models an ambiguous/lost response: the successful
idempotent result is retained and retrieval exposes the captured payment.

After clearing faults, let the real scheduled worker recover pending payments
with its normal exponential backoff. Do not alter their retry timestamps to
claim production recovery. Compare final database records with simulator intent
state/amounts, verify capacity, and check for captured-but-unconfirmed payments.
The runner exports pending states; a separate post-recovery check is required.

Supplementary HTTP checks should exercise duplicate signed webhooks and
concurrent full/partial refunds using repeated operation IDs. Check actual
refund logs and simulator refunded totals, not just HTTP redirects. Measure
capture-call deltas only when unrelated checkout traffic is idle; global
counters cannot isolate one webhook's behavior during concurrent checkout.

## Evidence, cleanup and limits

The generator retries only its simulator browser-confirm step on connection
errors, HTTP 429 and HTTP 5xx, up to three retries after the first attempt. Every
retry is retained as `sim_retry` in raw results. Application HTTP requests are
not retried by the generator. Exhausted simulator transport failures retain the
registration/intent IDs, fail validation, and stop the campaign. Cancel any
unpaid orphan intent and expire its exact synthetic registration before
restoring real processor credentials. Preserve failed runs alongside reruns.

Each run writes an incremental manifest, raw per-request results, admin probes,
and independent database/simulator comparisons. Collect Fly machine states,
RSS/high-water memory, CPU, logs, database activity and deadlock counters. Never
restart/redeploy the simulator before exporting state and completing recovery:
its in-memory payment state is not durable.

Export all test records before cleanup. Remove only manifest-listed test events,
their dependent records, and users belonging exclusively to the unique test email
namespace. Never truncate the live testbed. The harness captures session UUIDs for
scoped cleanup; earlier runs may leave anonymous sessions to expire normally.
Retain administrative audit/login records as evidence. Compare pre-existing
registration/event row hashes before and after.

Restore original Stripe and SMTP secret values; unset simulator-only variables
that were absent originally; deploy the staged restoration to every machine.
Verify the normal health/admin login path and configuration without generating
Stripe traffic. Stop the simulator after exporting its state. Confirm there are
no pending synthetic payments/refunds left for the normal worker to send to Stripe.

This is server-side application testing. It does not test Stripe.js, 3-D Secure,
real payment networks, browser rendering, multi-region outages, durable simulator
restarts, or an hours-long endurance period. Those require separate scenarios.
