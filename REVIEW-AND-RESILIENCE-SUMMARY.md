# Flyte review, stabilization, and resilience assessment

22 October 2026 · Human-readable handoff · Status at completion of this work

## What was accomplished

Flyte's unmerged `ui-elaboration` implementation received an independent review of security, payments, application behavior, operations, and visual design. The resulting stabilization was implemented, tested, and deployed to the existing Fly testbed. We then measured local performance, optimized analytics, and exercised that same Fly deployment under load and simulated processor failures.

**The principal result is confidence in the tested payment and seat-accounting behavior under contention and uncertain processor responses.** The system continued to reconcile correctly as the deployment became CPU-constrained. Availability and customer experience degraded before financial correctness did. One heavy analytics request returned HTTP 502; large recovery backlogs and continuously increasing arrival rates remain unvalidated.

The existing architecture and visual identity remain appropriate. This work does not establish a need for a framework rewrite or a broader deployment redesign.

| Item | Handoff state |
|---|---|
| Repository | `jumpkey/flyte`, checked out at `~/projects/flyte` |
| Working branch | `stabilization/ui-elaboration` |
| Review | [Draft PR #30](https://github.com/jumpkey/flyte/pull/30), targeting `ui-elaboration`; not merged into `main` |
| Live testbed | [flyte.fly.dev](https://flyte.fly.dev); sign in through [/login](https://flyte.fly.dev/login) |
| Deployed application | Revision `49fe12a`, verified after restoring ordinary testbed settings |
| Test tooling/results | Commit `ec15873`; this document adds the consolidated interpretation |
| Other repository | `~/projects/mahjracks.com`; unchanged by this Flyte work |

An anonymous request to `/admin` intentionally returns 404. Use `/login` before entering administration. Credentials and temporary secret backups are not included in this handoff.

## Review and stabilization

The initial review identified important failures around account suspension and state transitions shared by PostgreSQL, Stripe, and the browser. Existing tests passed but did not sufficiently exercise retries, ambiguous responses, or overlapping financial operations. The [original review](docs/reviews/2026-10-22/initial-review.md) is retained as historical evidence: its defects describe the pre-stabilization revision, not the current disposition.

| Area | Completed changes |
|---|---|
| Account security | Administrative suspension is distinct from failed-login lockout. Suspension revokes sessions and reset/verification tokens; reset completion rechecks suspension. Password changes revoke other sessions and rotate the current one. |
| Input/export safety | Explicit POST fallback for the password form, neutralization of spreadsheet-formula text in CSV exports, and request limits before parsing, including uploads and webhooks. |
| Registration | SQL enforces event lifecycle, dates, price, and capacity. Free registration is atomic and works without Stripe JavaScript. Paid checkout preserves an attempt across Back/Continue within the current page. |
| Payment uncertainty | Processor state is consulted before finalization or failure. Ambiguous outcomes remain recoverable; confirmation pages reflect actual registration state. |
| Refunds and cancellation | Durable refund operations, processor-ID uniqueness, and transactional accounting prevent duplicate effects. Full refund after a partial refunds the remainder. CANCELLING freezes new activity and remains recoverable. |
| Operations | Five-minute recovery worker, recovery-health visibility, serialized transactional migrations, database readiness checks, and consistent deployment of built assets/templates. |
| Visual and interaction repairs | Responsive tables, mobile navigation, image fallback/preview behavior, explicit event time zones, signed chart scales, readable chart text, accessible chart data, and clearer refund/waitlist presentation. |
| Runtime | Node 24 aligned across runtime/CI, dependency updates, production build in CI, and a deterministic SMTP-sink test replacing a platform-dependent error-text assertion. |

The visual assessment favored retaining the navy/orange palette, Inter typography, neutral backgrounds, restrained borders, and consistent public/admin panels. Server-rendered pages with small HTMX enhancements fit the product. The work corrected specific usability and accessibility defects; it did not replace the design. Responsive checks covered 320, 375, 768, and 1440 pixels. Full assistive-technology auditing and optional fallback-card density polish remain deferred.

Earlier deployment smoke checks used **real Stripe test mode** for authorization/capture, duplicate confirmation, partial/full refunds, cancellation, and public webhook delivery. Missing PaymentIntent webhook subscriptions were added. Free checkout completed in the deployed browser; paid Payment Element rendering and Back/Continue were exercised. No real-money rollout was performed. These limited smoke checks are distinct from the later load campaign, which sent **no load to Stripe**.

## Analytics optimization

The original daily analytics query scanned registrations once for every day in the requested range. The buyer-summary query also transferred every grouped buyer row to Node to calculate totals.

Revision `49fe12a` replaces the repeated daily scans with one bounded aggregation joined to the calendar, and computes buyer totals in SQL. Regression coverage includes empty days, timezone boundaries, future-date exclusion, refunds, repeat buyers, and all report ranges.

On the same local dataset of about 36,000 registrations, 200 authenticated report requests at concurrency 10 changed as follows:

| Metric | Before | After |
|---|---:|---:|
| Requests/second | 3.60 | 24.33 |
| p95 latency | 5,188 ms | 597 ms |
| p99 latency | 22,087 ms | 714 ms |

This is a measured local improvement of about 6.8× in throughput. It is not a promise of equivalent Fly capacity.

## What the load tests exercised

Local testing used isolated PostgreSQL, dummy credentials, a loopback-only outbound guard, the repository Stripe simulator, and an SMTP sink. The live campaign used the **existing** Fly app and database, preserving shared 1-vCPU/512-MB machines, the five-connection application pool, five-minute worker schedule, and existing scaling thresholds. The web app was in `iad`, with its existing database in `ewr`.

A separate private Fly simulator app temporarily received the testbed's payment and mail traffic. Configuration rejects ordinary Stripe credentials paired with a simulator destination, and rejects dummy simulator credentials without a simulator destination. Email was discarded. The simulator was initially on a shared CPU, then upgraded alone to a performance CPU for a comparison. Flyte itself was not resized.

The campaign covered baseline bursts, longer batches, low-rate mixed page reads, random processor delays/errors, a complete capture outage, errors after successful capture, sellout contention, rate limiting, duplicate signed webhooks, and concurrent refunds. Test-driver results distinguish HTTP success from confirmed business state; HTTP 200 alone is not counted as a successful payment.

Stochastic behavior was synthetic rather than a claimed model of Stripe: creation delay 50 ms plus 0–100 ms jitter; capture delay 150 ms plus 0–200 ms jitter; 2% additional 1.5-second tails; conditional capture faults comprising declines, pre-execution HTTP 500, HTTP 429, and post-commit HTTP 500. Exact settings are in the [runbook](load_testing/FLY_STRESS_RUNBOOK.md).

## Bursts, sustained measurements, and CPU allocation

Throughput below counts confirmed registrations. Confirmation latency measures the final application HTTP request, not complete checkout. The local longest run used 100 concurrent buyers; Fly sustained runs used 50. Fly batch timing includes session bootstrap and waiting for outstanding page probes, but excludes between-batch reconciliation. Local timing excludes bootstrap.

| Measurement | Local | Fly |
|---|---:|---:|
| Short 250-buyer burst | 384 confirmations/sec | 91 confirmations/sec |
| Burst confirmation p95 | 486 ms | 1,369 ms |
| Longer run, opening Fly burst excluded | 281 confirmations/sec | About 8 confirmations/sec |
| Longer-run confirmation p95 | 292 ms | About 5,600–6,000 ms with the performance-CPU simulator |

The local longer run confirmed 30,000 registrations in **107 seconds**. It is insufficient evidence for an hours-long or even a matched six-minute local endurance claim. The final Fly run confirmed 4,000 registrations across four batches over about 402 seconds including setup/validation. Its batch rates were **68.5, 9.5, 7.4, and 7.4 confirmations/sec**. Excluding the opening burst, 3,000 confirmations took 375.5 summed batch seconds, or 7.99/sec. The prior sustained run with a shared-CPU simulator also settled near 8/sec.

Fly documents shared CPUs at **5 ms per 80 ms**, or **6.25% / one-sixteenth of a CPU**, versus 100% for a performance CPU. Accumulated unused quota permits temporary bursts above baseline. These figures are provider policy and may change. [Fly CPU documentation, checked 22 October 2026](https://docs.fly.io/machines/cpu-performance).

Local application samples averaged about **1.10 CPU equivalents**. A simple allocation-normalized estimate is therefore:

`281.2 registrations/sec × 0.0625 / 1.10 ≈ 16 registrations/sec`

Against the observed 8/sec, the approximately 35× local/Fly difference separates into about **17.6× less CPU allocation/usage and a remaining factor of 2×**. That residual is not isolated experimentally. Network latency, processor hardware, event distribution, concurrent reads, concurrency, and measurement boundaries differ. The generator ran on a hotel WiFi connection with limited and unpredictable bandwidth; absolute throughput/latency comparisons must retain that qualification.

Server-side samples nevertheless show substantial CPU waiting, with low execution percentages near the documented fractional baseline. Fly warns that steal can indicate quota throttling or host contention. Quota-specific Prometheus access was unavailable, so neither cause was conclusively isolated. A short burst, which also started a second existing web machine, should not be substituted for sustained capacity.

## Resilience findings: what held up

| Challenge | Observed result |
|---|---|
| Complete capture outage | All 40 registrations remained pending with reserved seats, then recovered through the real scheduled worker. |
| 2,000 stochastic attempts | Initially 1,910 confirmed, 39 definitive declines, and 51 pending; all 51 recovered, leaving 1,961 confirmed and 39 declines. |
| Error after capture succeeded | All 40 confirmed with consistent financial state. |
| Fifty buyers competing for ten seats | Exactly ten confirmed; the other forty intents were canceled. No overselling. |
| Duplicate signed webhooks | 100 HTTP 200 responses, with no additional capture calls during otherwise idle checkout. |
| Concurrent duplicate refunds | One partial refund, one remaining-balance refund, and one separate full refund; repeated submissions produced no duplicate ledger or processor effects. |
| Sustained resource pressure | Final 4,000-registration run fully confirmed; sampled Node memory high-water mark about 127 MiB, no sampled database deadlocks. |

Final reconciliation covered **19,610 registrations and simulator intents**, with zero capacity, capture-amount, refund-amount, missing-intent, or unresolved-payment discrepancies. Final states were 19,528 confirmed, 79 payment failures, two refunded/canceled registrations, and one expired unpaid fixture.

Recovery ran on the normal schedule and backoff; retry timestamps were not advanced. Some recoveries took roughly seven minutes. A generator-to-simulator disconnect interrupted an earlier run; its unpaid fixture was explicitly canceled/expired. The corrected generator retained **22 simulator transport retries** in the completed rerun. It did not retry Flyte application requests. These connection failures cannot be assigned to the application, particularly given the hotel network.

## Visible issues and deliberately limited conclusions

**Heavy reporting:** one of 50 ten-year analytics requests returned HTTP 502, with p95 about 19 seconds. This is an observed end-to-end failure; its exact application/proxy/network cause was not isolated. Catalog and ordinary analytics requests also slowed but completed. Reproduce with request correlation and server timings before assigning a cause. A brief cache or bounded report concurrency is a possible focused response if contention is confirmed.

**Recovery backlog:** successful recovery of 40/51 items does not establish large-backlog capacity. Pending captures are processed serially; processor calls occur while each registration's transaction/row lock is held, and an advisory lock serializes sweeps. One thousand items at one second each imply roughly 17 minutes before extra calls/retries. This is a source-supported risk, not an observed backlog failure. Test a much larger backlog under continuing processor delays, measuring oldest-pending age and drain rate before considering bounded parallelism or shorter lock duration.

**Shared-IP limits:** the single-event profile accepted 60 and rejected 140 requests with HTTP 429, matching the per-IP/per-event/per-process rule. Legitimate users behind a hotel, conference, office, or other shared public IP compete for this allowance. Process-local counters also mean acceptance depends on routing between machines. Review the threshold against expected bursts and provide an actionable retry response, including `Retry-After`. This is not a deployment-wide admission-control mechanism.

**Pending-state experience:** the page truthfully says registration is not yet confirmed and provides a status-check button. Several-minute recovery delays justify clearer waiting guidance, advice against starting another purchase, and bounded progressively slower status polling. Those are proposed improvements, not changes included in this work.

The tests were closed-loop: slow responses reduce new arrivals. They do not prove stability when arrivals keep increasing beyond capacity. The strongest random faults and deepest CPU saturation were not sustained together for an extended interval. Many-event sharding preserved the existing limiter but did not represent an unlimited single-event flash sale. No hours-long endurance run, real Stripe/SCA/wallet load, long processor network-timeout campaign, geographic failover, or durable simulator-restart recovery was performed.

## Decisions and next work

The owner's intended workload is expected to fit mainly within Fly's burst allowances. **Broader deployment architecture changes are deferred.** The preferred simple capacity adjustment is performance CPUs across the deployment's containers. That preference is recorded here; **it has not been applied**, and no performance-CPU Flyte throughput claim is made. Only the temporary simulator was upgraded during testing.

Near-term application follow-up should remain bounded: investigate the analytics 502, review shared-IP burst handling, and improve pending-state guidance. A large-backlog fault test and an arrival-driven overload test would extend the evidence without requiring a redesign. A future repeat should use a stable load-generator network and identical workload/duration when comparing environments.

Other retained limits: fresh-page paid-checkout resumption, full account-enumeration resistance, automated waitlist promotion, real inbox delivery/bounce handling, comprehensive keyboard/screen-reader coverage, and automated browser layout CI remain incomplete. Unknown refund operations stop automatic retry after 23 hours and require processor investigation. The [stabilization runbook](STABILIZATION.md) describes these policies and coordinated rollback requirements.

## Validation, cleanup, and evidence

The migration checks, all 16 registration and 16 web test files, typechecking, and production build passed. Analytics has 20 focused cases; the simulator/harness suite passed 16 Python tests. [GitHub CI passed on `ec15873`](https://github.com/jumpkey/flyte/actions/runs/39811070651). This records the tested implementation, not an assertion that every later documentation commit received a separate completed CI run.

Before the live load campaign, a database volume snapshot and original-data hashes were recorded. After reconciliation, targeted cleanup removed 892 synthetic events, 19,610 registrations, 19,244 users, three refund operations/logs, and 495 identified anonymous sessions. All 14 original events and 290 original registrations were unchanged; all 87 original users remained. One administrator row changed through normal login activity. Audit records were retained; unidentified early anonymous sessions expire normally.

Original Stripe/SMTP secret names and digests were restored and verified. All four machines received the restored release; active web/worker environments matched the original settings. Health and authenticated admin login passed. The simulator was stopped, task-owned load processes/proxies were stopped, and temporary credential backup files were removed. Nothing was merged into `main`. The legacy automatic Fly deployment workflow remains disabled; explicit deployment ownership matters for this branch testbed.

For detail and reproduction:

- [Historical independent review and screenshots](docs/reviews/2026-10-22/initial-review.md)
- [Deployment, operational safeguards, and rollback](STABILIZATION.md)
- [Local measurements](load_testing/PERFORMANCE_2026-10-22.md) and [local test runbook](load_testing/STRESS_RUNBOOK.md)
- [Fly measurements](load_testing/FLY_STRESS_RESULTS_2026-10-22.md), [structured results](load_testing/FLY_STRESS_RESULTS_2026-10-22.json), and [Fly test runbook](load_testing/FLY_STRESS_RUNBOOK.md)
- [Sanitized Fly raw evidence](load_testing/evidence/2026-10-22-fly.zip) and [local raw evidence](load_testing/evidence/2026-10-22-local.zip)

Future work should preserve the distinction between observed failures, implementation risks, and untested scenarios. Payment correctness under tested degradation is the strongest conclusion of this campaign; sustainable capacity and worst-case backlog recovery are narrower claims requiring additional measurements.
