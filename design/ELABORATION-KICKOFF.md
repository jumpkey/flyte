# Elaboration kickoff — context & caveats

Marching orders for the UI elaboration effort on this branch (`ui-elaboration`).
Written 2026-06-16 after the `pilot-derisk` spike was built, deployed to the Fly
testbed, and exercised end to end by the owner.

## Where to build
- **Branch:** `ui-elaboration` (this branch — `main` + the full design suite). It is
  current with `main`, so it already contains the Stripe registration flow and the
  Fly deploy fixes.
- **Plan of record:** execute `design/UI-IMPLEMENTATION-PLAN.md` increments I1…I10.
  `design/SITE-MAP-AND-STORYBOARD.md`, `design/WIREFRAMES.md`, and
  `design/WEBKIT-STANDARDS.md` are the specs; `design/VIEWS-AND-ANALYTICS-ADDENDUM.md`
  and `design/DROP-DAY-LIVE-OPS.md` are addenda.

## The pilot reference (do NOT merge it)
The `pilot-derisk` branch (tag **`pilot-1`**, deployed at https://flyte.fly.dev) is a
throwaway spike that validated the Bootstrap look-and-feel, color scheme, typography,
and layout. Per `design/PILOT-DERISK-SPEC.md` it is **never merged** — salvage happens
through the real increments. Treat it as a visual reference and an asset donor: lift
the validated pieces as the relevant increment needs them —
- `src/styles/flyte.scss` (WEBKIT-STANDARDS tokens, compiled → `public/css/flyte.css`)
- self-hosted Inter fonts (`public/fonts/`) and the `sass` build step in `package.json`
- self-hosted HTMX, the tightened CSP in `src/web/app.ts`, and the restyled `.ejs`
  view patterns
— but re-implement structurally per the plan rather than importing the spike's
throwaway controllers/harness (`dev-kit`, `scripts/dev-refund.ts`, `scripts/seed-events.ts`).

**Owner sign-off (2026-06-16):** the reskin was confirmed provably cosmetic (existing
14/14 registration test files green) and the visual direction — color, type, layout —
was approved on the live testbed. Proceed on that basis.

## Caveats — open issues to address as part of this effort
These were filed against the live pilot or carried over; fold the fixes into the
relevant increments rather than leaving them for later.

**Bugs surfaced on the pilot**
- **#28** — nav renders logged-out (Log in/Sign up) on public pages despite an active
  session: `c.set('user')` only runs in `authGuard`; add a global load-user middleware.
  (Fix early — it undermines every logged-in view.)
- **#25** — Stripe Payment Element panel too narrow; a payment method is clipped.
- **#23** — email send failures are silently swallowed (empty `catch`); no logging even
  on a *paid* registration. Add `logger.error` + consider retry/dead-letter.

**Checkout / registration UX**
- **#26** — Stripe "pay with/without Link" option is unexplained; disable Link or explain it.
- **#24** — require email confirmation (enter twice) for unauthenticated registrants to
  guard against typos (pairs with #23 so a bad address is at least logged).

**Account / portal / admin (core elaboration scope)**
- **#27** — no portal/admin views today; content is DB-only. This is the I5/I7/I10 work.
- **#29** — the account view (My Registrations / dashboard panel, I7) must include
  **waitlisted** events, not just confirmed registrations.

**Pre-existing security follow-ups (still open)**
- **#21** — container runs as root; add a `USER` directive to the Dockerfile.
- **#22** — `/api/check-email` enumeration oracle; `is_admin` never enforced. Enforce
  admin authorization as the admin surfaces (I5+) come online.

## Deploying & verifying from this branch (read before deploying)
- **No auto-deploy here.** The `Fly Deploy` GitHub Action triggers only on push to
  `main` (`.github/workflows/fly-deploy.yml`). `ui-elaboration` will **not** deploy on
  push. To put work on the `flyte` testbed, run a **manual** `flyctl deploy --remote-only`
  (as the pilot did). That needs `FLY_API_TOKEN` in *this* environment — the Action's
  repo secret does not reach an ad-hoc agent run. Restore baseline anytime by deploying `main`.
- **No browser in the Fly container.** The deployed image has no Chromium/Playwright;
  the committed automated suite is HTTP/DB-level (in-process `app.fetch`), not browser-driven.
  For UI self-verification, install a headless browser **in this build/sandbox** per
  `STRIPE-LIVE-SANDBOX-TEST-GUIDE.md` Appendix D.1 (`@playwright/test` +
  `npx playwright install --with-deps chromium`) — do not add it to the production image.
- Seeding test events + DB access on the testbed: use the pilot harness
  (`scripts/seed-events.ts`) in-container via `flyctl ssh console -C
  "node dist/scripts/seed-events.js"` (the interactive `flyctl postgres connect` hangs).

## Already confirmed covered by the design (no action beyond building it)
- Logged-in users seeing their registrations: dashboard "Your upcoming events" panel +
  My Registrations (WF-06, `/account/registrations`), increment I7.
- The current near-empty `/dashboard` is a known interim stub that I7 fleshes out.
