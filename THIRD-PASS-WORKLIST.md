# Third pass — pilot round-2 findings (2026-06)

Triaged from the deployment-test list. Each item: my read, the files, batch, and
any decision needed. Two items are already done; two need a decision before build.

## R1 — CRITICAL: Stripe Link resurfaces another user's saved card  (list #10, #21)
**Status: root cause found; code hardening landed; needs a Dashboard action.**

Root cause (authoritative, from Stripe docs): **Link is a wallet that
`payment_method_types` cannot exclude**, and its "returning user" recognition is
keyed to a **browser-level Stripe session**, not Flyte's login. So the W1
card-only PI never removed Link, and the browser's remembered Link account
(leb@jumpkey) leaks to any Flyte user on that machine (e.g. Alice Adams). There
is **no client-side Stripe.js switch** for Link in the Payment Element.

Important: item #10's "fine IF AND ONLY IF scoped to this login" is **not
achievable while Link is on** — Link is browser-scoped, never app-user-scoped.
It must be turned off entirely.

Fix (both):
1. **Dashboard → Settings → Payment methods → Link → Off** (test + live). The
   only authoritative switch. **User action — required.**
2. **Code (done):** `STRIPE_PAYMENT_METHOD_CONFIGURATION=pmc_…` (a Link-off
   Payment Method Configuration) is now pinned per PaymentIntent when set;
   falls back to card-only otherwise. See STRIPE-INTEGRATION.md → "Disabling
   Stripe Link". Optional pure-code alternative: migrate Payment Element →
   Card Element (`disableLink: true`) — larger refactor, not yet done.
Files: `src/config.ts`, `src/registration/services/RegistrationService.ts`,
`STRIPE-INTEGRATION.md`.

## Already implemented (inform, no work)
- **Cancel event + refund every participant (list #17)** — exists today:
  admin event page → **Cancel event** → **Refund all & cancel**
  (`POST /admin/events/:id/cancel` → `RefundService.refundEvent` FULL; cancels
  only if every refund succeeds).
- **Searchable full transaction table (list #2 search part)** — `/admin/registrations`
  already has field filters + HTMX pagination + CSV. #2 only needs a **link** to
  it from the dashboard panel (Batch A).

## Batch A — gutters + links (quick CSS/template, no decisions)
- **A1 (list #1,#3,#5,#15-history, +audit):** add column gutters to **every**
  admin/account table — dashboard recent-transactions, transactions +
  failed-payments drilldown, analytics Events, Users, Activity, user login
  history, My Registrations. Roll the existing `.table-roomy` (W8) into the base
  admin table or apply broadly.
- **A2 (list #2):** "View all / search transactions →" link on the dashboard
  recent-transactions panel → `/admin/registrations`.
- **A3 (list #18):** obvious **Browse events** link on the user Dashboard.
- **A4 (list #19):** My Registrations row actions (View / Request a refund) into
  separate columns with gutters, each with a `→` arrow.
- **A5 (list #13):** email CTA link = **orange text on white** (currently orange
  bg / white text). `src/registration/services/email-template.ts`.

## Batch B — small behavior + chart polish
- **B1 (list #9):** waitlist "Join" form prefills First/Last from the logged-in
  account (email already prefilled). `waitlist-form.ejs` (mirror W7).
- **B2 (list #20):** `/find-registration` redirects a **logged-in** user to
  `/account/registrations` (they shouldn't query an arbitrary email).
- **B3 (list #6,#16-charts):** Daily Net Revenue = **bars only** (drop the
  overlaid line); add a y-axis **scale** (right) and an x-axis **"Days"** label;
  give both analytics charts scales/legends and **equal-sized, aligned** boxes.
  `src/web/utils/svg-charts.ts`, `analytics-body.ejs`, `event-performance.ejs`.
- **B4 (list #16):** Analytics **Events** list gets a status filter / checkboxes.
- **B5 (list #11):** refund **approval** amount is **editable** (partial / fee
  deduction), with a **hard cap ≤ amount charged** (server-validated).
  RefundService already does partial; wire it into the approve modal.

## Batch C — scalable tables (cross-cutting framework)
- **C1 (list #4,#7):** reusable **pagination + clickable sortable headers** for
  voluminous tables (Users, Activity, login history). Transactions already
  paginates — add sort.
- **C2 (list #14):** Refund Requests / Resolved become **paginated tables** with
  Approve/Deny → modal; the modal **captures the approver's comment**, stored on
  the refund record and surfaced in the user's interaction history.

## Batch D — features (need a decision)
- **D1 (list #8): image upload** (vs URL) — upload, resize to fit, storefront
  preview, clear, and **delete the file when cleared** (with a warning).
  **DECISION: storage.** Fly's container FS is **ephemeral** (uploads vanish on
  redeploy). Options: a Fly **Volume**, **object storage** (Tigris/S3/R2), or
  **Postgres `bytea`**. Keep the existing URL field as an alternative.
- **D2 (list #15): user timeline / storyboard** — a paginated lifecycle view of
  a user's interactions, purchases, refunds, and logins over time (the login
  history alone isn't the story). New aggregated view.

## Informational / verify
- list #12 (emails to leb@jumpkey work) — noted.
- list #16 (Analytics exports) — both CSV routes exist; will spot-check.
