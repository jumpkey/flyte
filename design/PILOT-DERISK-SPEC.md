# Flyte — Pilot / De-Risking Spike Specification

**Suite:** UI Elaboration v1 · Document 7 — **PROPOSED** (pre-commitment validation)
**Companions:** [`SITE-MAP-AND-STORYBOARD.md`](SITE-MAP-AND-STORYBOARD.md) · [`WEBKIT-STANDARDS.md`](WEBKIT-STANDARDS.md) · [`UI-IMPLEMENTATION-PLAN.md`](UI-IMPLEMENTATION-PLAN.md)

---

## 1. Purpose & posture

A single-pass spike on an isolated branch, run **while the owner deep-reads
the suite**, that de-risks the two foundational bets before any increment is
committed:

- **Bet 1 (look & feel):** the trust-base + vivid-accent direction (D3) and
  the Bootstrap consumption model (D5, WK §11.1) work on *real pages*, not
  just wireframes.
- **Bet 2 (payment UX):** the end-user Stripe experience — Payment Element,
  3DS, declines, mobile feel, receipts — is acceptable to the owner, first
  in sandbox, then with one live-mode proof; and a baseline of Stripe
  behavior tests exists before the build starts on top of it.

**Posture rules (what keeps a spike a spike):**

1. Branch `pilot-derisk`, cut from `main`. Never merged wholesale; §6 defines
   what gets salvaged.
2. **Zero schema changes. Zero new product features.** Existing routes and
   flows only, restyled. No shadow accounts, no admin pages, no migration 007.
3. Throwaway-permitted: the deliverable is *validated decisions and a
   findings list*, not code. Salvage is a bonus.
4. The existing test suite must stay green on the branch — that's the proof
   the reskin was genuinely cosmetic.

## 2. Workstream A — Bootstrap reskin of the existing site

Implements WK §11.1 for real:

- `bootstrap@5.3.x --save-exact` + `sass` devDependency; `src/styles/flyte.scss`
  = WK §2 token overrides (`$primary: #C2410C`, body/ink/muted colors, Inter
  self-hosted with system fallback, 8px-grid spacers, radius 8/12) → curated
  module imports (reboot, grid, forms, buttons, badge, alert, modal, nav,
  tables) → component layer (CSS custom properties, top-nav treatment, event
  card, status pill, availability meter).
- Build: `npm run build:css` (+ watch in dev) → `public/css/flyte.css`.
  **CSP tightens:** Pico's `cdn.jsdelivr.net` and HTMX's `unpkg.com` leave
  the allowlist (HTMX self-hosted to `public/js/`).
- **Pages restyled (all existing, nothing new):** home, login, register,
  verify/forgot/reset, dashboard, profile, registration form (checkout steps
  1+2 with the WF-04 treatment around the Payment Element), confirmation,
  capture-pending, payment-failed, waitlist form + ack, error pages.
- **Home gets the WF-01 treatment** (navy hero + event-card grid over the
  existing events table) so the brand moment is judgeable — this is the one
  page allowed to go beyond utilitarian restyling.
- **`/dev/kit` style-guide page** (404 outside development): every button
  variant/state, form fields incl. error state, all status pills, an event
  card (image + fallback), alerts, a modal, the type scale, the palette —
  the whole WebKit §5 on one screen. This page is how D3/D5 gets judged
  fastest, and it's reusable evidence for I1/I9 compliance later.

## 3. Workstream B — Stripe UX validation harness

The payment flow already works end to end; what's missing is *operability
for a human tester*:

- **`scripts/seed-events.ts`** (dev tooling, not a migration): creates 3–4
  events against the existing schema — cheap ($1, for live tests), normal
  ($25), nearly-full (1 slot, to hit sold-out/waitlist), and closed.
- **`scripts/dev-refund.ts <registrationId> [amountCents]`**: drives the
  existing `RefundService` from the CLI — lets the owner test refunds
  (full + partial) against sandbox and live **without** building the admin
  UI early. Same engine path I5 will expose later.
- **Test protocol** (`design/pilot/STRIPE-TEST-PROTOCOL.md`, checklist with
  an evidence column — screenshots/IDs):
  1. Happy path `4242…4242` — desktop and **phone** (the kinetics/feel
     judgment needs a thumb, not a mouse)
  2. 3DS challenge `4000 0025 0000 3155` — the interrupt experience
  3. Hard decline `4000…0002` and insufficient-funds `4000…9995` — what the
     customer actually sees, and whether the slot is released
  4. Abandon at the Payment Element → verify expiry sweep releases the slot
  5. Sold-out → waitlist path
  6. Refund full + partial via `dev-refund` → customer email + Stripe
     dashboard cross-check
  7. Webhook failure drill: stop the webhook listener mid-payment →
     reconciliation sweep recovers (the engine claims this; watch it once)
  8. **Live mode, once sandbox is clean:** the $1 event with a real card —
     charge, receipt email, dashboard verification, then live refund. Proves
     keys, webhook endpoint + secret, and email deliverability in production
     config.
- **Mode switching** is already env-driven; the protocol documents the exact
  env vars per mode and the Stripe-dashboard webhook setup for live.

## 4. Deployment target (one decision for the owner)

Phone testing and the live-mode proof need a deployed instance. Options:
**(a)** deploy `pilot-derisk` to a separate fly.io staging app
(`flyte-pilot`, throwaway Postgres, sandbox keys; flip to live keys only for
test 8) — *default*; or **(b)** local + Stripe CLI for everything except
test 8, then a brief deploy of the pilot to the real app. (a) is cleaner;
costs a few dollars of fly.io time.

## 5. Outcomes — what "done" means

| # | Outcome | Evidence |
|---|---|---|
| O1 | Look & feel verdict on real pages: adopt as-is / adjust tokens / rethink | annotated screenshots + `/dev/kit`; harvested token changes PR'd into WK §2 **before I1** |
| O2 | Bootstrap pipeline proven: build works, curated bundle size measured (budget: CSS ≤ 60KB gz), CSP tightened, HTMX + modal coexist | build output, size table, CSP diff, existing suite green |
| O3 | Stripe sandbox matrix complete | protocol checklist, all 7 rows evidenced |
| O4 | Live-mode proof: real charge + real refund + real receipt | checklist row 8, dashboard screenshots |
| O5 | Findings list: every UX rough edge seen with owner eyes (copy, error states, mobile sizing) | becomes line items in I2/I3/I9 or WK amendments |
| O6 | Refund engine exercised against live Stripe pre-I5 | dev-refund transcript |

## 6. Salvage policy

**Merges forward into I1** (via the real increment, reviewed + tested, not a
branch merge): package.json pins + build scripts, `flyte.scss` token layer,
self-hosted HTMX/Inter assets, `/dev/kit` page, seed-events script, the CSP
changes. **Stays on the spike / dies with it:** per-page restyling (redone
properly in increments with their ACs), dev-refund script (superseded by I5's
admin UI — or kept as dev tooling if it earns it). **Feeds back into docs:**
any token/WK amendments from O1, protocol findings into increment ACs.

## 7. Size & sequence

Single pass, sized **M** (the reskin is the bulk; the harness is small).
Suggested order: pipeline → `/dev/kit` → reskin pages → seed/refund scripts →
sandbox protocol → owner walkthrough (you) → live proof → findings write-up.
The owner's deep read and this spike converge on the same Gate-0 exit: suite
APPROVED (possibly amended by O1/O5), then I1 starts from proven ground.
