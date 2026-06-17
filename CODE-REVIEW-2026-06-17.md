# Independent Code Review — Flyte UI Elaboration (I1–I10)

**Date:** 2026-06-17 · **Branch:** `ui-elaboration` @ `29afa39` · **Reviewer posture:** adversarial, treating the build as someone else's work.

**Method.** A full read of the I1–I10 surface plus four parallel deep-dive audits
(money/refunds, authorization/IDOR, XSS/escaping/validation, completeness-vs-spec).
Every **material** finding below was re-verified by hand against the source — the
agents found candidates, this document only keeps what the code actually confirms.

**Verdict.** The build is **solid and shippable for a testbed validation pass.**
Core security and product decisions (D1 shadow accounts, D6 waitlist gate, R3
ownership, S1 admin invisibility, S6 login-oracle, S7 lock+session-revocation) are
correctly implemented and tested; SQL is fully parameterized; no XSS was found.
The findings cluster in three places: **(a) one structural decision to make before
real traffic (`page_views`)**, **(b) a handful of correctness/money-safety issues
worth fixing**, and **(c) analytics/A5 completeness gaps that are product calls.**
None are emergencies; none block a testbed deploy.

Severity: **HIGH** = fix before real users/launch · **MED** = should fix · **LOW** =
hardening/polish · **INFO** = note / accepted-by-design.

---

## Findings at a glance

| # | Sev | Area | Summary | File |
|---|-----|------|---------|------|
| R1 | HIGH | Structural | `page_views` table omitted though Q7 was resolved **Yes**; the view→checkout funnel can't be built and no view history accrues. Decide before go-live. | `db/migrations/007_ui_elaboration.sql:8` |
| R2 | MED | Analytics correctness | Net/refund math sums refunds across **all** statuses but gross over **CONFIRMED-only** → net understates, refund-rate can exceed 100%. | `src/services/analytics-service.ts:31,45,52,88` |
| R3 | MED | Money safety | `stripe.refunds.create` has **no idempotency key** and runs **before** the locked SP; a double-clicked refund or the two concurrent refund HTTP paths can move money Stripe-side that the DB then rejects (orphan refund). | `src/registration/services/RefundService.ts:64,98` |
| R4 | MED | Money safety | `sp_partial_refund_registration` bounds the refund on **gross**, not captured **net** — the SP (last line of defense) disagrees with the correct TS check and can over-refund vs the actual charge. | `db/migrations/005_registration_schema.sql` (sp_partial_refund) |
| R5 | MED | Abuse hardening | Rate-limit **and audit IP** come from client-settable `x-forwarded-for.pop()`, not a trusted-proxy/Fly header — spoofable; and the over-limit path **sleeps up to ~6s holding the request**, amplifying load under abuse. | `src/web/middleware/rate-limit.ts:34`, `src/web/utils/get-client-ip.ts` |
| R6 | MED | Analytics completeness | A1 funnel renders **3 stages, no conversion %**; the "daily net revenue" chart actually plots **gross**; prior-period delta only on gross. | `src/services/analytics-service.ts:57,74` |
| R7 | LOW | Completeness | **A5 attention panel** implements ~2 of the 7 spec'd triggers (and uses `PAYMENT_FAILED` not the spec'd `PENDING_CAPTURE>2h`). | `src/services/admin-dashboard-service.ts:34` |
| R8 | LOW | Completeness | **A2 / WF-10**: no per-event funnel, no revenue panel, partial CSV set, and the WF-10 compact "sparkline + projection" strip is missing (the `sparkline()` helper is unused). | `src/web/views/admin/event-detail.ejs:16` |
| R9 | LOW | Completeness | **V3** social cards: `og:type` is `website` not `event`; no fallback `og:image` when an event has no image. | `src/web/controllers/catalog.ts:76` |
| R10 | LOW | Input hardening | Admin **deny-note** and direct-refund **reason** have no server-side length cap (client `maxlength` only) → unbounded stored text. | `src/web/controllers/admin/refunds.ts:111`, `admin/registrations.ts:125` |
| N1–N4 | INFO | Operational | Seed/migration/branch notes — see below. | — |

---

## Detail

### R1 — `page_views` table omitted despite Q7 = Yes  (HIGH — decide before go-live)
Q7 ("first-party page-view counters") is recorded **resolved Yes** in both
`SITE-MAP-AND-STORYBOARD.md:382` and `VIEWS-AND-ANALYTICS-ADDENDUM.md:343`, and the
addendum folds the `page_views` table (§5) into migration 007's I1 scope. The
migration instead **defers it** (`007:8` "deferred until accepted"), reading the
older "optional if Q7 accepted" wording. Consequences: the A1/A2 **view→checkout→paid**
funnel cannot be built (we only have checkout→paid), and — the structural point of
the whole addendum — **page-view history is not being recorded**, which is exactly
the thing you can't backfill later. **Mitigating fact:** the site is pre-launch, so
no real view data is lost *yet*; the window to add it cleanly is still open.
**Recommendation:** either add the `page_views` table + a lightweight view-count
hook on the storefront/detail routes **before** the testbed accrues meaningful
traffic, or formally re-defer Q7 with the trade-off acknowledged in the doc.

### R2 — Analytics net/refund math is inconsistent  (MED)
`periodTotals` (`analytics-service.ts:28-35`) sums `gross`/`net`/`count` with
`FILTER (WHERE status='CONFIRMED')` but sums `refunded_amount_cents` with **no
filter**. A fully-refunded registration becomes `CANCELLED`, so its gross drops out
of `cur.gross` while its refund still counts → `netCents = gross − refunded`
(line 45) understates net and can go **negative**, and `refundRatePct = refunded/
gross` (line 52) can exceed **100%**. The per-event table repeats the pattern
(`:87-88`). This is most visible precisely when refunds exist — and the demo data
seeds 31 of them, so the dashboard will show it. **Recommendation:** decide the
metric definition (e.g. count gross of all registrations that were ever confirmed
in-period, or attribute refunds to the period of the original confirmation) and
make the gross and refund sums use the *same* population.

### R3 — Refund Stripe call is un-keyed and precedes the DB lock  (MED — money safety)
`RefundService.refundRegistration` reads the registration **without `FOR UPDATE`**,
then calls `stripe.refunds.create(...)` (`:64` full / `:98` partial) with **no
idempotency key**, then runs the stored procedure (which *does* `FOR UPDATE` and
re-validate). The DB therefore can't double-apply, but the **Stripe side can**: a
double-clicked "Issue refund" button (the modal's submit isn't disabled on submit),
or the two HTTP paths now exposed in I5/I6 (direct refund on the payment detail +
approve on the refund queue), can each create a Stripe refund before either SP runs.
For partials especially, two refunds within the at-read remaining balance both
succeed at Stripe, then the second SP rejects on the reduced balance → **money moved
that the DB has no `refund_log` row for.** A Stripe-success / SP-failure also leaves
no compensation (`:79-80`). **Recommendation (small, high-value):** pass an
`idempotencyKey` to `stripe.refunds.create` (e.g. `refund-${registrationId}-${amount}`),
mirroring how `paymentIntents.create` is already keyed — Stripe then dedups
double-submits and concurrent calls. Optionally disable the refund modal submit
button on click.

### R4 — Partial-refund SP bounds on gross, not net  (MED — money safety, engine-inherited)
`sp_partial_refund_registration` computes `v_remaining := gross_amount_cents −
refunded_amount_cents` and rejects only `amount > remaining`. The captured charge is
`net_amount_cents`; the TS layer correctly bounds on net (`RefundService.ts:92-93`),
but the SP — the last line of defense, and the only guard if a future caller skips
the TS path — allows refunding up to **gross**, driving `refunded_amount_cents` above
what Stripe actually captured. This lives in the **payment-engine migration (005)**,
predating this work, but the new HTTP refund surfaces make it reachable.
**Recommendation:** align the SP's balance to net (use `COALESCE(net_amount_cents,
gross_amount_cents)`), matching the TS check.

### R5 — Rate-limit / audit IP is client-spoofable; over-limit path sleeps  (MED — hardening)
`getClientIp` and the rate limiter take `x-forwarded-for.split(',').pop()` (or
`x-real-ip`), neither verified against a trusted proxy. On Fly this *happens* to
land on the Fly-appended value, but it's undocumented and fragile; if the app is
ever reachable without the expected proxy, the header is fully attacker-controlled
and every per-IP rate limit (login, register, forgot/reset password,
find-registration, refund-request) becomes a per-request reset. The **audit-log IP**
(`login_events`, `user_action_events`) is equally spoofable, weakening the activity
trail. Separately, the limiter's "absorb spikes by sleeping up to ~6s" actually
**holds a request handler open** per over-limit request — under sustained abuse this
*amplifies* resource pressure rather than shedding it. **Recommendation:** key off
Fly's trusted client-IP header (or a configured trusted-proxy hop count); return
`429` promptly instead of sleeping.

### R6 — A1 sales funnel & revenue chart incomplete  (MED — completeness)
The funnel renders 3 stages (`Initiated → Authorized → Confirmed`) with no
**captured** stage and **no between-stage conversion %** (spec calls for 4 stages +
%). The "daily net revenue" series sums **gross** (`:57-64`, the variable is even
named `net`), and prior-period delta is computed only for gross, not net/AOV/refund-
rate. **Recommendation:** add the captured stage + conversion %, subtract refunds in
the daily series (and rename), and extend deltas — or trim the spec to match.

### R7 — A5 attention panel is a reduced banner  (LOW — completeness/product call)
Only pending-refund-requests and a `PAYMENT_FAILED`-7d count are surfaced
(`admin-dashboard-service.ts:34-39`). The spec's prioritized, deep-linked list (7
triggers incl. unsent receipts, reconciliation overdue, soon-to-open DRAFTs, A2
AT-RISK events, events in 7 days) is not built, and `PAYMENT_FAILED` substitutes for
the spec'd `PENDING_CAPTURE>2h`. Functional but below spec — a scope decision.

### R8 — A2 performance & WF-10 strip gaps  (LOW — completeness)
Projection, booking curve, velocity, and waitlist depth are present and correct. Not
built: the per-event funnel, a gross/net revenue panel, the full CSV button set
(only Roster CSV), and the **WF-10 compact strip** on the admin event-detail page
(it's a plain "Performance" link; the `sparkline()` helper in `svg-charts.ts` is
written but **unused**).

### R9 — V3 Open Graph minor gaps  (LOW)
`og:type` is `'website'` (spec: `event`), and there's no static brand-card
`og:image` fallback for events without an image.

### R10 — Unbounded admin note/reason text  (LOW — hardening)
The deny **note** and direct-refund **reason** are required/trimmed but not
length-capped server-side (the customer-facing reason *is* capped at 500). Client
`maxlength` is bypassable. Not an XSS path (both are escaped on render and in email),
just unbounded stored text. **Recommendation:** cap at ~500 server-side.

---

## Operational / idempotency notes (INFO)

- **N1 — `seed:demo` on the Fly testbed.** The Dockerfile sets `NODE_ENV=production`,
  so on Fly the seeder **refuses unless `SEED_DEMO_FORCE=1`**, and it **TRUNCATEs**
  the event/registration/waitlist/refund tables (RESTART IDENTITY CASCADE). That's
  intended for a scratch testbed but is destructive — don't run it against any DB
  whose data you want to keep.
- **N2 — Migration 007 is not independently re-runnable.** Its `ALTER`s have no
  `IF NOT EXISTS` guards; it's safe only because the migrate runner tracks applied
  files (and swallows duplicate-object errors). A manual partial re-apply would
  error. Fine in practice, worth knowing.
- **N3 — Demo registrations use synthetic `pi_demo_*` PaymentIntents.** Every UI
  surface (browsing, records, refund *records*, analytics, admin) works fully, but
  the live **Stripe refund buttons** can't move real money for seeded rows (no real
  PI). Use a genuinely-checked-out registration to exercise live refunds.
- **N4 — Stale remote branch.** `claude/intelligent-archimedes-rflm8c` still exists
  on the remote (this environment lacks delete permission). Drop it with
  `git push origin --delete claude/intelligent-archimedes-rflm8c`.
- **Pre-existing, tracked, by-design:** the `/api/check-email` enumeration oracle
  (#22) and the root-running container (#21) from `SECURITY-AUDIT-2026-06-12.md`
  remain open. The guest **confirmation / refund-request capability URLs** expose
  name+email+amount to any bearer of the 122-bit UUID — this matches the **accepted**
  bearer-URL decision (security audit, "Guest confirmation page … assessed
  acceptable"; `Referrer-Policy: no-referrer` is set), so it's noted, not flagged.

---

## Positive assurance (verified correct, so coverage is clear)

- **Authorization:** `adminGuard` returns **404** (not 403/redirect) for anonymous,
  non-admin, locked-admin, and unknown-session — on **every** `/admin` route; a
  structural route-enumeration test enforces it. `authGuard` covers all account
  surfaces. **No IDOR** — `/account/registrations/:id` is scoped to the session
  `user_id` (returns 404 otherwise). Self-lock is rejected server-side; lock revokes
  live sessions.
- **Request integrity:** webhook is mounted **before** session/CSRF (raw body, not
  CSRF-gated); CSRF is enforced on every other POST with a constant-time, length-
  checked compare; `onError`/`notFound` render generic styled pages and **never leak
  stack traces**.
- **Injection/XSS:** **no `sql.unsafe`** anywhere in app code — all queries are
  parameterized tagged templates. **No XSS found**: all DB/user data renders through
  escaped `<%= %>`; the only `<%-` sites are trusted includes / layout body / helper
  functions that escape internally; SVG inputs are numeric/literal; every email value
  passes `escapeHtml`; `image_url` is https-only + length-capped.
- **Auth hardening:** the shadow-account **login oracle is closed by shape and
  timing** (dummy bcrypt compare on the NULL-hash *and* the unknown-email branches);
  forgot-password issues to shadow but never locked accounts and keeps its min-time
  pad; reset performs the shadow→active+verified flip.
- **Refund flow (the correct parts):** HTTP-layer amount validation (positive,
  ≤ remaining net, regex-bounded, CONFIRMED-only) is solid; request filing is
  idempotent (partial unique index → friendly "already requested"); approve handles
  `ALREADY_REFUNDED` with **no second charge-back**; cancel-with-zero-confirmed
  short-circuits without Stripe.
- **Gate:** 14 registration + 13 web suites green; typecheck clean; every increment
  was green in CI, validated key-less to match the CI environment.

---

## Suggested disposition

| Do before go-live | Bundle into a post-deploy fix package | Accept / decide |
|---|---|---|
| **R1** (decide `page_views` while the window is open) | **R2, R3, R4** (analytics math + refund idempotency-key + SP net-bound — all small, high-value) · **R5, R10** (IP source + length caps) | **R6–R9** (analytics/A5/A2/V3 completeness — product scope calls) · N1–N4 (operational) |

R3 in particular is a one-line, high-leverage fix (idempotency key on
`stripe.refunds.create`) that closes the only path where money can move without a
record. R2 is the most user-visible (wrong dashboard numbers once refunds exist).
Everything else is safe to schedule.
