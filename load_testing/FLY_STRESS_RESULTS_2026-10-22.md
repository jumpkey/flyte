# Flyte: optimization and existing-testbed load test

22 October 2026 · Application revision `49fe12a` · https://flyte.fly.dev

**The analytics optimization is deployed. Payment and capacity reconciliation passed, but the existing shared-CPU deployment showed a substantial sustained-performance limit. One heavy analytics request returned HTTP 502. This is not an all-green capacity certification.**

## Scope and unchanged deployment

The tests used the existing `flyte` app, its existing PostgreSQL database, two configured web machines and two configured worker machines. Flyte retained shared 1-vCPU/512-MB machines, a five-connection application DB pool, the five-minute recovery schedule, minimum one running web machine, and the existing request concurrency thresholds of soft 150 / hard 200. Web machines remained in `iad`; the existing database remained in `ewr`.

Only payment/email destinations changed temporarily. A separate private Fly app, `flyte-stripe-sim-20261022`, provided the repository simulator and an SMTP discard sink. Flyte used unmistakably dummy credentials. Application configuration now rejects a simulator host paired with ordinary Stripe credentials, and rejects dummy credentials without a simulator host. No load was directed at Stripe, and generated email was discarded. A database volume snapshot and original-data hashes were taken first.

The simulator initially used a shared CPU. For the final comparison it alone was upgraded to one performance CPU and 2 GB RAM; Flyte was not resized. Simulator state was exported and reconciled before that restart, then merged by unique PaymentIntent ID for the final audit.

## Analytics optimization

The daily report now aggregates registrations once within the requested date bounds and joins the result to the calendar, replacing one repeated registration scan per day. Buyer totals are computed in SQL instead of transferring every buyer group to Node. Empty days, timezone boundaries, excluded future dates, refund cohorts, repeat buyers, and all range options have regression coverage.

On the same local dataset of approximately 36,000 registrations, 200 authenticated analytics requests at concurrency 10 improved from **3.6 to 24.33 requests/second**, with p95 falling from **5,187.56 to 596.63 ms** and p99 from **22,086.94 to 714.36 ms**. All 200 optimized requests returned HTTP 200. This is a local before/after comparison, not a Fly capacity estimate.

Validation passed: 20 analytics cases, the migration test, all 16 registration test files and 16 web test files, TypeScript checking, and the application build. The final simulator/harness suite passed 16 Python tests, including idempotency, authentication, fault injection, refund limits, dual-stack networking, and visible bounded simulator-transport retries.

## Live checkout performance

Each worker completes one registration before beginning another. Confirmation latency below measures the final Flyte HTTP request, not total checkout. Batch throughput includes session initialization, simulator authorization, and waiting for outstanding page probes. Integrity collection introduces additional gaps between batches. These are bounded, closed-loop runs, not controlled arrival-rate tests.

| Scenario | Concurrent workers | Attempts | Confirmed / batch second | Confirm p95 | Confirm p99 |
|---|---:|---:|---:|---:|---:|
| Short baseline | 20 | 300 | 31.44 | 320 ms | 476 ms |
| Short baseline | 50 | 1,000 | 61.29 | 452 ms | 504 ms |
| Short baseline | 100 | 2,000 | 84.98 | 753 ms | 853 ms |
| Short overload | 250 | 2,000 | 91.45 | 1,369 ms | 1,622 ms |
| Final soak, opening batch | 50 | 1,000 | 68.51 | 468 ms | 577 ms |
| Final soak, second batch | 50 | 1,000 | 9.53 | 6,000 ms | 6,533 ms |
| Final soak, third batch | 50 | 1,000 | 7.39 | 5,848 ms | 6,641 ms |
| Final soak, fourth batch | 50 | 1,000 | 7.39 | 5,603 ms | 6,160 ms |

The final soak used the performance-CPU simulator. All **4,000 registrations confirmed**. The complete run took about **402 seconds**, including provisioning and validation gaps; its four batches totaled about 390 seconds. Earlier corrected sustained testing with the shared-CPU simulator also confirmed 3,000/3,000, but slowed to roughly 8 registrations/second. An earlier pilot with event creation between batches is preserved as a pilot, not presented as steady-load evidence.

The short 250-worker burst started the second existing web machine automatically. Later, with 50 workers, one web machine was active. CPU samples on that web machine showed a median **83.6% steal time after 15:36 UTC**. The sampled Node memory high-water mark was **126.7 MiB**, well below the 512-MB allocation. Database samples showed no deadlocks or temporary-file bytes and commonly seven idle connections plus the monitoring connection. These observations point more strongly to available web CPU than memory or database lock contention.

Fly documents a shared CPU baseline of 6.25%, with accumulated burst allowance; steal time can reflect quota enforcement or host contention. The burst-then-slow pattern and unchanged slowdown with the faster simulator are consistent with a web CPU constraint. They do not prove the exact split between quota exhaustion and host contention. The Prometheus query was unauthorized, so quota-specific metrics were unavailable. [Fly CPU documentation](https://docs.fly.io/machines/cpu-performance).

## Fault handling and financial correctness

| Test | Observed result |
|---|---|
| Stochastic processor, 2,000 attempts / 100 workers | Initially 1,910 confirmed, 39 declined, 51 pending capture. The actual scheduled worker recovered all 51: final 1,961 confirmed and 39 definitive declines. |
| Complete capture outage, 40 attempts | All 40 retained reserved seats while pending; all recovered after faults were cleared. |
| Error after successful capture, 40 attempts | All 40 confirmed with consistent captured amounts; idempotency prevented duplicate financial effects. |
| 50 buyers racing for 10 seats | Exactly 10 confirmed; the other 40 failed and their intents were canceled. No overselling. |
| Same-IP, single-event limit, 200 attempts | 60 accepted and confirmed; 140 returned HTTP 429 on the active web process. This is not a global multi-process limit. |
| 100 duplicate signed webhooks | All returned HTTP 200; zero additional capture calls while other checkout traffic was idle. |
| Concurrent refund submissions | 20 duplicate partial-$5 submissions caused one $5 refund; 10 subsequent full-remainder submissions brought that registration to $12 refunded. On another registration, 20 full-$12 submissions caused one refund. DB logs, simulator totals, and released seats agreed. |

The stochastic distribution was deliberately synthetic: creation delay 50 ms + uniform 0–100 ms; capture delay 150 ms + uniform 0–200 ms; each with a 2% chance of an extra 1.5 seconds. Capture checks applied conditional draws in order: 2% decline, 5% pre-execution HTTP 500, 2% HTTP 429, then 2% post-commit HTTP 500. Seed `20261022` fixed the random stream, although concurrent scheduling changes request assignments. No recovery timestamps were accelerated and no worker was invoked manually. Recovery took up to roughly seven minutes under the existing schedule and backoff.

Final cross-check covered **19,610 registrations and 19,610 simulator intents**: 19,528 confirmed, 79 payment failures, two fully refunded/canceled registrations, and one expired unpaid registration. There were **zero capacity, captured-amount, refund-amount, missing-intent, or unresolved-payment discrepancies**. The SMTP sink discarded 19,602 messages, including recovery traffic.

## Failures and test limitations retained in the evidence

After sustained checkout, read tests ran with about 491 synthetic events and 14,600 synthetic registrations still present:

| Page | Concurrent readers | Requests | p95 | HTTP results |
|---|---:|---:|---:|---|
| Catalog | 20 | 300 | 7,171 ms | 300 × 200 |
| Default 90-day analytics | 10 | 100 | 3,841 ms | 100 × 200 |
| Ten-year analytics | 5 | 50 | 18,806 ms | 49 × 200; **1 × 502** |

That 502 is a real observed application/deployment failure under the tested workload. Its precise cause was not isolated. Low-rate mixed catalog/detail/analytics probes during checkout returned HTTP 200, but those probes do not establish good interactive latency under heavy reporting.

The first performance-simulator soak stopped after 999 of 1,000 confirmations because the load generator's connection through the Fly proxy to the simulator disconnected. This was outside Flyte's application HTTP path. Its unpaid intent was canceled and its exact synthetic registration expired. The corrected driver retries only this simulator browser-confirm step, with at most three retries after the initial attempt, preserving every retry in raw results. The completed rerun logged **22 simulator transport retries**, zero exhausted retries, and no retried Flyte application requests. The failed run remains in the evidence rather than being discarded.

Normal load was spread across many event routes to preserve the existing per-IP/per-event limiter without spoofing client IPs. The campaign accumulated 892 synthetic events in total, so event volume also affects catalog cost. This measures a portfolio workload, not an unlimited single-event flash sale. There was no hours-long endurance test, open-loop overload test, real Stripe/Stripe.js/SCA test, actual processor network timeout beyond ten seconds, geographic failover test, or durable simulator-restart recovery test. Simulator state is deliberately in memory.

## Cleanup, reproducibility, and next decision

The campaign exported test records before targeted cleanup. It removed all 892 synthetic events, 19,610 synthetic registrations, 19,244 synthetic users, three refund operations/logs, and 495 identified anonymous sessions. All 14 original events and 290 original registrations matched their pre-test row hashes; all 87 original users remained. One original administrator row changed through normal login activity. Administrative audit records were retained; anonymous sessions not captured by early harness versions expire normally.

Original secret names and digests match the pre-test snapshot, all four machines use the restored release, and active web/worker environments match the original payment, mail, and database settings. Health and authenticated admin login passed. The simulator machine is stopped. Restoration verification is recorded in the accompanying structured results. The deployed application retains the optimization. Reproduction instructions are in `load_testing/FLY_STRESS_RUNBOOK.md`; the campaign driver is `load_testing/run_fly_stress.py`, with the private simulator configuration in `load_testing/fly.simulator.toml`.

**Focused next experiment:** repeat the same sustained workload with a performance CPU for Flyte's web process while holding the database, processor, and workload fixed. Separately test a lower request scaling threshold or two continuously running web machines. Change one factor per comparison. For the ten-year report, measure bounded report concurrency or short-lived caching against the observed 502 and checkout latency before adopting either. The current evidence does not justify a numerical sustained-capacity promise or an unmeasured configuration change.

Structured results: `FLY_STRESS_RESULTS_2026-10-22.json`. Sanitized raw evidence is retained with the Codex task deliverables.
