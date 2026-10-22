# Flyte performance and stress test — 22 October 2026

**Result: registration handled the tested load without payment/capacity inconsistencies; admin analytics is the clear performance weakness. No traffic was sent to Stripe or the Fly testbed by these tests.**

Tested application revision `1b762c1`, matching the deployed stabilization implementation. Only local load-test tooling was changed. The app, PostgreSQL, repository Stripe simulator, SMTP sink and Python load driver ran on this workstation. This is a local benchmark, not a Fly.io capacity guarantee.

## Registration throughput and latency

Latency columns are separate HTTP phases, not complete checkout latency. Throughput counts confirmed registrations per wall-clock second and includes initiation, simulator authorization and client confirmation. Worker session/CSRF bootstrap is excluded. Workers are closed-loop: each waits for its current registration before starting another.

| Scenario | Workers | Attempts | Confirmed/s | Initiate p95 | Confirm p95 | Confirm p99 |
|---|---:|---:|---:|---:|---:|---:|
| baseline-c1 | 1 | 100 | 83.4 | 5.4 ms | 7.6 ms | 8.0 ms |
| baseline-c10 | 10 | 500 | 266.8 | 17.2 ms | 28.3 ms | 32.9 ms |
| baseline-c50 | 50 | 1,000 | 355.2 | 61.6 ms | 103.0 ms | 108.1 ms |
| baseline-c100 | 100 | 1,500 | 367.4 | 116.2 ms | 201.3 ms | 215.5 ms |
| baseline-c250 | 250 | 2,000 | 384.0 | 263.7 ms | 486.4 ms | 507.3 ms |
| latency-c50 | 50 | 500 | 197.6 | 108.3 ms | 222.9 ms | 229.0 ms |
| latency-c100 | 100 | 500 | 257.3 | 158.5 ms | 293.1 ms | 302.1 ms |
| soak-c100 | 100 | 30,000 | 281.1 | 163.7 ms | 292.3 ms | 318.3 ms |

Baseline uses zero injected processor delay. The latency and soak cases inject **50 ms per PaymentIntent creation and 150 ms per capture**. The soak completed **30,000 confirmations in 106.706 seconds**, with no failed requests or inconsistent payment/seat states. Its peak sampled app RSS was **285.28 MiB**. The process memory high-water mark across the broader experiment, including analytics, was **313.21 MiB**; memory subsequently fell to about 145 MiB. This does not establish leak-free behavior over hours.

Throughput flattens: increasing workers from 50 to 250 improved baseline throughput by only about 8%, while confirm p95 rose from 103 to 486 ms. Additional concurrency mostly increases queueing in this setup. The short baseline runs are directional measurements rather than confidence-bounded capacity estimates.

## Correctness and fault tests

Across **36,920 valid registration attempts** (including warmup and intentionally rejected/faulted cases), there were no unexplained HTTP/server/CSRF failures. Expected rejections and pending states are counted separately from successful registrations.

| Scenario | Observed result |
|---|---|
| 500 attempts, 100 workers, 50 seats | Exactly 50 confirmed; 50 in-flight attempts failed without captures; 400 later initiations were rejected. Zero remaining seats and no overselling. |
| 100 concurrent submissions for the same buyer/event | One registration and one confirmed payment; 99 already-registered responses. |
| 100 repeated signed authorization webhooks | All returned 200; zero additional capture API calls and no extra seat/accounting changes. |
| 100 same-IP attempts | 60 accepted and 40 rate-limited, matching the configured per-event limit. |
| 50 simulated capture API failures | All stayed PENDING_CAPTURE with their seats reserved. After clearing the fault and advancing only test retry timestamps, recovery confirmed all 50; processor amounts and DB states matched. |
| 50 definite card declines, corrected HTTP 402 fixture | All became PAYMENT_FAILED, all processor intents were canceled, and all 100 event seats remained available. |

Seat validation checked both the capacity equation and agreement between event counters and registration rows. Financial validation compared every confirmed registration with its simulator PaymentIntent status and captured amount, and checked for captured intents without confirmed registrations. No refund stress claim is made: the simulator does not adequately model refund/idempotency semantics for that purpose.

## Page read performance at about 36,000 registrations

All three profiles used an authenticated administrator session, including the public page routes.

| Page | Concurrent readers | Requests | Requests/s | p95 | p99 | Errors |
|---|---:|---:|---:|---:|---:|---:|
| catalog | 50 | 1000 | 150.91 | 404.0 ms | 444.8 ms | 0 |
| event-detail | 100 | 1000 | 793.59 | 149.3 ms | 486.6 ms | 0 |
| admin-analytics | 10 | 200 | 3.6 | 5187.6 ms | 22086.9 ms | 0 |

## Specific finding: daily analytics repeatedly scans registrations

The default 90-day analytics query uses a lateral aggregate for each date. EXPLAIN ANALYZE showed **90 sequential scans** of the registrations table. The daily series query alone took about **621 ms**, before the remaining analytics queries and rendering. The customer-summary query also returns roughly **36,000 grouped buyer rows** to Node just to compute a few totals.

The relevant code is [analytics-service.ts, daily series](https://github.com/jumpkey/flyte/blob/1b762c19e84de96f8aaa3c7fcd5716cefc066790/src/services/analytics-service.ts#L94) and the buyer summary in the same service. The application has a shared five-connection database pool, so heavy administrative reports can plausibly compete with checkout traffic; a mixed checkout/report workload was not measured.

**Concrete next change:** aggregate registrations once by confirmation day, then join that result to the generated calendar. A read-only SQL prototype produced identical results on this dataset and reduced median query time from **589.6 ms to 23.8 ms** across three runs—about **24.8× faster for that query**. This is not a measured whole-page speedup. The prototype was not installed in the app or deployed.

Also compute buyer-count/returning/activation summaries inside SQL instead of transferring every buyer row to Node. Validate the revised report against refunds, empty dates, timezone boundaries and every range option; then rerun analytics and a mixed checkout/report test. Consider a brief report cache or bounded report concurrency only after those query changes.

## Test-tool corrections and safeguards

- The existing load driver lacked the current guest email-confirmation field. That preflight failed validation and was excluded; the harness now sends both email fields.
- HTTP 200 confirmation responses were previously counted as success regardless of payment state. They are now classified by CONFIRMED/PENDING/payment-failure state; unverified responses fail the run.
- Workers now bootstrap independent sessions before sales begin and keep one attempt in flight per cookie jar. This avoids misleading session races and late CSRF initialization after sell-out.
- The simulator returned HTTP 400 for card declines. Stripe SDK 22.1 classifies that as StripeInvalidRequestError, so Flyte conservatively held the reservation. The simulator now uses HTTP 402. That original 50-row fixture is excluded from the valid decline results; its held rows were subsequently recovered. The recovery log therefore shows 100 recovered rows: 50 intended API-outage rows plus those 50 diagnostic fixture rows.
- Four focused harness regression tests pass, including business-state classification and the simulator decline status. Python compilation and git diff checks pass.
- The load app used dummy Stripe keys, a dedicated `flyte_load_20261022` database, and an outbound socket guard permitting loopback addresses only. A separate guard probe confirmed an attempted `api.stripe.com` connection is rejected before network access. The actual app log contains no blocked external attempts.
- Local SMTP accepted generated messages without delivering them externally. Neither live Fly configuration nor deployment was changed.

## Environment, limits and reproduction

Hardware: AMD Ryzen 7 5800H (8 cores, 16 logical CPUs), about 59 GiB RAM. Node 24.19.0; PostgreSQL 16.15; application DB pool max 5; V8 old-space cap 256 MiB. There was no container CPU or RSS limit. All services shared this workstation, with negligible network latency outside the injected simulator delays. This differs materially from Fly shared CPUs, its network/database placement and real Stripe behavior.

Not measured: open-loop arrival overload, a multi-hour soak, real Stripe rate limits/latency, real SMTP, SCA/wallets, refund stress, geographical traffic, malicious distributed traffic, or a mixed checkout/analytics workload. The synthetic data is concentrated in recent confirmations, especially one large event; real data distribution can change query plans.

Reproduction instructions and guard/simulator/SMTP support are in `load_testing/STRESS_RUNBOOK.md`. Per-scenario checks are in `load_testing/run_stabilization_stress.py`. The original application revision remains deployed; the analytics optimization is a measured recommendation, not an implemented fix.

The full timing evidence is retained in the originating Codex task outputs.
