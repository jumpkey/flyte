# Pilot branch — what this is and how to deploy it

Implements Document 7 (`design/PILOT-DERISK-SPEC.md` on `ui-elaboration`):
the Bootstrap look-and-feel testbed + the Stripe UX validation harness.
**Spike posture: zero schema changes, zero new product features. Never merge
this branch — salvage happens through the real increments.**

## What changed
- **Theme:** Bootstrap 5.3.3 (pinned) themed via `src/styles/flyte.scss`
  (WK §2 tokens), compiled to `public/css/flyte.css` (25 KB gz). Inter
  self-hosted. HTMX self-hosted. **CSP tightened** — `unpkg.com` and
  `cdn.jsdelivr.net` removed (`src/web/app.ts`).
- **All existing pages restyled**; home gets the WF-01 hero + event-card grid
  (new `eventService.listUpcomingPublic`, the one query added).
- **`/dev/kit`** — full style-guide page; 404s when `NODE_ENV=production`.
  To view it on the fly testbed, temporarily set `NODE_ENV` to anything else
  (`fly secrets set NODE_ENV=pilot`), or judge from the local screenshots.
- **Bug fixed en passant:** the payment-failed page's `onclick="history.back()"`
  was dead under CSP (inline handlers blocked since day one). Now a
  `data-back` handler in `public/js/app.js`.
- **Harness:** `npm run seed:events` (4 protocol-shaped events, idempotent) ·
  `npx tsx scripts/dev-refund.ts <regId> [cents]` (drives the production
  RefundService from the CLI) · `STRIPE-TEST-PROTOCOL.md` (run it top to bottom).

## Build & deploy
```bash
npm install
npm run build          # now includes build:css (sass)
# verify locally if desired: npm run dev → http://localhost:3000

git tag pilot-1        # tagged, clean-tree deploys only (Doc 7 §4)
flyctl deploy --remote-only
npm run seed:events    # against the testbed DB (fly proxy or console)
```
Restore baseline at any time: re-deploy `main`.

## Verified in the dev environment (2026-06-13)
- TypeScript + scripts builds clean; CSS builds at 25 KB gz (budget: 60)
- **Existing registration test suite: 14/14 files green** against a local
  Postgres 16 — the reskin is provably cosmetic
- Playwright screenshots (desktop 1280px + mobile 390px): home, kit, login,
  register, checkout step 1, confirmation, dashboard — no console errors
  (only the sandbox's own external-Stripe block)
- Note: compiled public/css/flyte.css is committed (Dockerfile copies public/ from context); after editing flyte.scss run npm run build:css and commit.
