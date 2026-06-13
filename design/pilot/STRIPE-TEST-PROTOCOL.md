# Pilot — Stripe UX Test Protocol

**Branch:** `pilot-derisk` · **Spec:** Document 7 (`design/PILOT-DERISK-SPEC.md`, on `ui-elaboration`)
**Posture:** evidence column gets a screenshot, ID, or transcript per row. Run top to bottom.

## Setup per mode

| | Sandbox | Live (row 8 only) |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…` | `sk_live_…` |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_…` | `pk_live_…` |
| `STRIPE_WEBHOOK_SECRET` | from `stripe listen` or test-mode endpoint | from live-mode dashboard endpoint |
| Events | `npm run seed:events` | use **Live-Mode Smoke Test** ($1.00) only |

Deploy guardrails (Document 7 §4): tagged clean-tree deploys (`pilot-N`); main frozen
during the window; restore = re-deploy `main`; **restore sandbox keys immediately after row 8**.

## Rows

| # | Test | Card / action | Expect | Evidence |
|---|---|---|---|---|
| 0 | **Baseline** (before first pilot deploy) | screenshot current pages; one sandbox happy-path on testbed as-is | receipt email arrives (config confirmed working — this evidences it) | ☐ |
| 1 | Happy path, desktop + **phone** | `4242 4242 4242 4242` | confirmation page + receipt email; slot count drops | ☐ |
| 2 | 3DS challenge | `4000 0025 0000 3155` | bank-prompt modal; completes to confirmation | ☐ |
| 3 | Hard decline | `4000 0000 0000 0002` | clear failure UX; **slot released** (count restored) | ☐ |
| 4 | Insufficient funds | `4000 0000 0000 9995` | as row 3 | ☐ |
| 5 | Abandon at payment step | close tab at Payment Element | reservation expires via sweep; slot released | ☐ |
| 6 | Sold-out → waitlist | buy the last **Founders Dinner** seat, then revisit | sold-out card → waitlist form → ack + position email | ☐ |
| 7 | Refund, full + partial | `npx tsx scripts/dev-refund.ts <regId>` then `… <regId> 500` on another | refund email; Stripe dashboard shows refunds; `refunded_amount_cents` correct | ☐ |
| 7b | Webhook failure drill | stop webhook listener mid-payment, complete payment | reconciliation sweep confirms the registration afterward | ☐ |
| 8 | **LIVE**: real card on the $1 event | real card | charge + receipt; then `dev-refund` returns the dollar; dashboard verified | ☐ |
| 9 | **Restore state** | sandbox keys + webhook secret back; re-deploy baseline if done | testbed back to sandbox | ☐ |

## Notes
- Row 5: the expiry sweep is the engine's reconciliation job — note how long release takes.
- Rows 1–6 on the deployed testbed; row 7 can run anywhere with DB access to it.
- Keep the live window (rows 8–9) as short as possible; the testbed URL is public.
