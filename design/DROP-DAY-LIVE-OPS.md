# Flyte — Drop-Day Live Ops & Telemetry

**Suite:** UI Elaboration v1 · Document 6 — **PENCILLED, TBD horizon**
**Companions:** [`SITE-MAP-AND-STORYBOARD.md`](SITE-MAP-AND-STORYBOARD.md) · [`WIREFRAMES.md`](WIREFRAMES.md) · [`WEBKIT-STANDARDS.md`](WEBKIT-STANDARDS.md) · [`UI-IMPLEMENTATION-PLAN.md`](UI-IMPLEMENTATION-PLAN.md) · [`VIEWS-AND-ANALYTICS-ADDENDUM.md`](VIEWS-AND-ANALYTICS-ADDENDUM.md)

**Status:** This document is a *pin*, not a plan. The capability described
here is explicitly **outside increments I1–I11** and outside Gate 0's question
backlog. It exists so that (a) the shape is agreed while it's cheap to agree,
(b) the handful of build-now rules in §7 get honored during the main build,
and (c) when the time comes it can be executed as **one focused swing**
("Increment T") instead of a re-instrumentation of a finished site. Revisit
trigger: after I10 ships, before the first mass-mail drop.

---

## 1. The scenario: the drop

A certain kind of event sells out at mail speed. The blast goes out via
**Postmark** at T0; recipients book immediately because they correctly expect
a sellout; the interesting part of the event's sales life is over in minutes
to a couple of hours. During that window the admin has two anxieties that the
A2 booking curve (daily resolution, retrospective posture) cannot answer:

1. **Commerce:** is it selling *right now*, how fast, when does it sell out,
   and are people failing to get through?
2. **Mechanics:** is the *site* keeping up — are checkouts slow, is Stripe
   slow, is the database straining, are we rate-limiting real customers?

Two things are pinned: **T1**, the live drop console (the view), and **T2**,
the telemetry capture cross-cut that feeds its performance half. They are
separable, and the decomposition in §3 is the most important design fact in
this document.

## 2. Driving questions, minute by minute

| Minute | Question | Console answer |
|---|---|---|
| T−5 | Is everything green before I press send? | health row all-clear, capacity confirmed |
| T0 | (blast sent) | T0 marker lands on every chart |
| T+2 | Are bookings arriving? At what rate? | bookings/min bars, instantaneous + sliding rates |
| T+5 | When will it sell out? Should I do anything? | minute-resolution sellout countdown |
| T+5 | Is anyone *failing* to buy? | failed/min, declines vs errors split |
| T+8 | Is the site slowing under load? | latency strip: registration POST, Stripe, DB |
| T+10 | Are we throttling real buyers? | rate-limit rejection counter |
| T+15 | Did the email actually perform? | Postmark overlay: delivered/opened/clicked vs bookings |
| T+40 | It's sold out — is the waitlist catching overflow? | waitlist/min after sellout |

## 3. The decomposition (what's cheap vs what's the tax)

**Phase A — the commerce half is nearly free.** Booking rate, sliding-window
curves, per-minute funnel counts, sellout countdown, and the T0 marker all
derive from **timestamps the engine already persists** (`registrations.
created_at` / `confirmed_at` at full resolution, status columns). No capture
tax, no new tables; it's the I10 chart machinery pointed at minute buckets
with an HTMX auto-refresh. Phase A could ship with or shortly after I10 if a
drop happens early.

**Phase B — the performance half is the cross-cut.** Latency percentiles and
health signals need a telemetry layer (T2). This is the "logging and data
capture tax all over the site" — which is why it's pinned as one swing and
why §7's build-now rules exist: they keep the eventual touch-surface small.

## 4. T1 — The drop console · `GET /admin/events/:id/live` *(WF-19)*

Auto-refreshing (HTMX poll, 5s default; SSE is a §8 decision), adminGuard,
mobile-tolerable but desktop-first. Panels:

- **Hero strip:** remaining inventory (the countdown number), bookings in
  last 5 min, **instantaneous rate** (1-min) with 5-min and 15-min sliding
  rates, projected sellout time at current 5-min velocity ("~11:42 · 18 min")
  with the §3.1-style honesty qualifier.
- **Rate chart:** bookings/min bars over the trailing hour, 5-min and 15-min
  sliding-average lines, **T0 blast marker(s)**, sellout moment marked when
  it happens. After sellout the series continues with waitlist joins/min.
- **Live funnel (per minute):** initiated / authorized / captured / confirmed
  rates side by side; a gap opening between initiated and confirmed is the
  earliest failure signal. Failed/min split into *declines* (customer
  problem) vs *errors/timeouts* (our problem).
- **Latency strip (Phase B):** sparkline cards with current p95 +
  threshold state (OK/WARN words + color): registration POST end-to-end ·
  Stripe PI create · Stripe capture · DB slot-reserve function · confirm
  endpoint end-to-end.
- **Health row (Phase B):** 5xx rate, **rate-limit rejections** (RL(60) on
  the register POST is per-IP, but office networks/NAT exist — this counter
  answers "tune it before the next drop"), Stripe webhook lag (event
  timestamp → processed), email send queue depth/latency.
- **Postmark overlay (§6):** delivered / opened / clicked counters and an
  opens-vs-bookings overlay curve — the conversion lag made visible.
- **Acting, not just watching:** quick links to edit capacity and view the
  waitlist — the two actions a hot drop actually prompts.

## 5. T2 — The telemetry cross-cut

### 5.1 What exists already (verified against the code)

- `requestLoggerMiddleware` **already times every request** (method, path,
  status, duration → pino). Per-route latency exists in log form today; T2
  aggregates it rather than instrumenting from scratch.
- Every Stripe call flows through the `getStripe()` factory behind the
  `StripeClient` interface — **one seam**; T2 wraps it with a timing
  decorator (per-method duration + outcome).
- Slot reservation is a single SQL function call site; confirm/capture are
  single service methods — the hot DB paths are already chokepointed.
- The **Stripe simulator** hook (`STRIPE_SIMULATOR_HOST`) already exists for
  load testing — see §5.4.

### 5.2 Capture & aggregation model (pencil)

In-process aggregation, no external infra: timing points emit into a ring
buffer; a flusher writes **1-minute rollups** to Postgres. The console reads
rollups (and the current in-memory minute for liveness). Raw per-request
rows are *not* stored — rollups only.

```sql
CREATE TABLE metrics_minute (
  minute   TIMESTAMPTZ NOT NULL,
  metric   TEXT        NOT NULL,   -- e.g. http.register_post, stripe.pi_create, db.reserve_slot
  count    INTEGER     NOT NULL,
  error_count INTEGER  NOT NULL DEFAULT 0,
  sum_ms   BIGINT      NOT NULL,
  max_ms   INTEGER     NOT NULL,
  buckets  JSONB       NOT NULL,   -- fixed log-spaced histogram → p50/p95/p99 approximations
  PRIMARY KEY (minute, metric)
);
-- retention: prune > 30 days (same daily job posture as session cleanup)
```

Percentiles come from fixed log-spaced histogram buckets (10ms…30s) — exact
enough for a dashboard, trivial to merge, no t-digest dependency.
**Known caveat, deliberately deferred:** in-process aggregation assumes the
current single-instance fly.io deployment; going multi-instance moves
aggregation into the DB upsert path or external infra (§8).

### 5.3 Instrumented points (the whole tax, enumerated)

| Point | Mechanism | New code touch |
|---|---|---|
| HTTP routes (all) | extend existing request logger to also emit to the aggregator, route-classed | one middleware |
| Stripe calls | decorator around the `StripeClient` factory return | one wrapper |
| DB hot paths | explicit timers in reserve / confirm / refund service methods | ~5 call sites |
| Email sends | timer in the mailer service | 1 call site |
| Webhook lag | Stripe event `created` vs processing time | 1 call site |
| Rate-limit rejections | counter in the rate-limit middleware's deny branch | 1 line |

That table *is* the swing. Everything else (rollup flusher, console queries,
charts) is additive new code, not touches to existing code.

### 5.4 The rehearsal (why the simulator matters)

The drop scenario is load-testable today: a script that fires N concurrent
register→pay→confirm flows against the Stripe simulator. T2's acceptance
test is to **watch a rehearsal drop through the console** — same glass for
the load test and the real morning. This also pressure-tests the engine's
atomic slot reservation under the exact contention pattern that matters
(should hold by design — migration 005's row-locked function — but "watched
it not oversell at 50 req/s" is evidence, not hope).

## 6. Postmark overlay (sub-pin, two tiers)

- **Tier 0 (manual, no integration):** a "blast sent" button on the console
  stamps T0 (or admin enters the time) → markers on charts. Zero
  dependencies; ships with Phase A.
- **Tier 1 (webhook ingest):** `POST /webhooks/postmark` (signature-verified,
  registered before CSRF like the Stripe webhook) consuming Delivery / Open /
  Click events into per-minute counters (`metrics_minute` with
  `email.delivered|opened|clicked` metrics, or a small dedicated table keyed
  by campaign tag). Console overlays opens/min and clicks/min against
  bookings/min — the open→book conversion lag, and whether a second blast is
  worth it. Depends on Postmark message-stream webhook configuration —
  decisions live in §8.

## 7. Build-now rules (the only part of this document that binds I1–I11)

1. **Never bypass the Stripe factory** — new payment-adjacent code calls
   through `getStripe()` so the one-seam decorator stays true. (I5's refund
   route, mind this.)
2. **Every new route goes through the standard middleware stack** — no
   bespoke handlers that skip the request logger. (Already the default;
   stated so it survives.)
3. **Keep the hot paths chokepointed** — slot reserve, capture, confirm stay
   single-call-site service methods; don't inline SQL into controllers.
4. **Reserve the namespace:** `/admin/events/:id/live` and
   `/webhooks/postmark` belong to this document; nothing else claims them.
5. **No per-request DB writes for metrics** during the main build — the
   aggregation model above is the only sanctioned approach when T2 lands.
6. Phase A needs nothing beyond what I1/I10 already record. Resist adding
   "just a little" telemetry early; the tax is paid once, in the swing.

## 8. Decisions deferred to the swing (this document's own backlog — not Gate 0)

| # | Decision | Leaning |
|---|---|---|
| T-1 | Poll (HTMX, 5s) vs SSE for console refresh | Poll first; SSE only if 5s feels dead during rehearsal |
| T-2 | Multi-instance aggregation (if fly.io scales out) | DB-upsert rollups; revisit only when scaling is real |
| T-3 | Postmark Tier 1 now or Tier 0 first | Tier 0 with Phase A; Tier 1 in the swing |
| T-4 | Alert thresholds (p95 ceilings, 5xx %) and whether the console emails/pages anyone | Visual thresholds only v1; no paging |
| T-5 | Rate-limit tuning protocol for drop days (raise RL(60)? per-route?) | Decide from rehearsal data, not guesswork |
| T-6 | Retention & rollup granularity beyond 1-min/30-day | Defaults until proven wrong |

## 9. Non-goals (even for the swing)

External APM / OpenTelemetry / Grafana stack (the site is one process and one
database; a `metrics_minute` table is proportionate) · WebSockets ·
autoscaling automation · public status page · distributed tracing.
