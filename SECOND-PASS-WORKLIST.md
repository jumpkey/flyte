# Flyte — Second-Pass Worklist (Elaboration)

**Date:** 2026-06-17 · **Branch:** `ui-elaboration` · **Sources merged:** owner test-pass
narrative + `CODE-REVIEW-2026-06-17.md` (R1–R10, N1–N4). This is the agreed bundle
for one focused second pass. Decisions below were taken jointly on 2026-06-17.

## Decisions taken
1. **Grouped / register-for-others → DEFERRED** to a new increment. This pass keeps
   today's one-active-registration-per-(email,event) model and only fixes the UX
   around it (name prefill, you're-registered/waitlisted states). See *Deferred*.
2. **Stripe Link → disable now; saved-cards → spike later.** Disable Link so guest
   checkout is pristine (W1). "Saved cards for logged-in users" gets a written design
   stub, not a build this pass. See *Deferred*.
3. **Account-page actions → build both** Request-a-refund and Remove-from-waitlist
   (W11, W12).
4. **Code-review completeness → all of it** (R1 + R6–R9) in addition to the must-do
   correctness/security fixes (R2–R5, R10).

Small defaults (flag if you disagree): email double-entry stays on register + waitlist
only — recovery flows (forgot-password, find-registration) keep a single field for
anti-enumeration (narrative item 10).

---

## Work items

Legend: **C**=critical · **B**=bug · **H**=hardening/correctness · **F**=feature/completeness.
"Test" = add to the key-less full gate where feasible; browser-only items stay
owner-verified.

### Group 1 — Guest-checkout integrity (CRITICAL)
| ID | Sev | Item | Root cause / files | Acceptance |
|----|-----|------|--------------------|------------|
| **W1** | C | Disable Stripe Link in checkout; guarantee pristine guest checkout | `automatic_payment_methods` on PI create surfaces Link, which remembers email/browser → a prior user's saved card appears. `RegistrationService` (PI create), `public/js/registration-form.js`. Also confirm the guest PI carries no logged-in user/session context. | Logged-out checkout *never* shows a prior user's Link/saved card; only fresh card entry. Verify after logging out of a seeded account. *(narrative 11; kickoff #26)* |

### Group 2 — Admin access
| ID | Sev | Item | Root cause / files | Acceptance |
|----|-----|------|--------------------|------------|
| **W2** | B | Admin navigation | Seed admin *is* `is_admin` (not a seed bug); `partials/nav.ejs` has no Admin link, so admins land on the customer dashboard. Add an "Admin" nav link for `user.isAdmin`; route admins to `/admin` on login. | Seeded `admin@…` sees an Admin link and reaches dashboard/users/analytics/etc. without typing the URL. *(narrative 12)* |

### Group 3 — Waitlist correctness
| ID | Sev | Item | Root cause / files | Acceptance |
|----|-----|------|--------------------|------------|
| **W3** | B | Event detail waitlist-aware | `catalogController.detail` only checks active registration, not waitlist membership → waitlisted user still sees "Join the waitlist." Add `hasWaitlistEntry`/position to `catalog-service`; branch the detail + sticky CTA. | A waitlisted user sees "You're on the waitlist (#N)" and **no** Join button. *(narrative 2, 7)* |
| **W4** | B | Waitlists on the dashboard | `upcomingRegistrations` is CONFIRMED-only. Add a "Your waitlists" view to the dashboard. `dashboard` controller + `account-service`, `dashboard.ejs`. | Waitlisted events appear on the dashboard. *(narrative 1)* |
| **W5** | B | My-Registrations waitlist position | `account-service.listWaitlist` returns no position; view shows "Position →" link only. Compute via `WaitlistService.getWaitlistPosition`. | The actual position number renders (link optional). *(narrative 1, 5)* |

### Group 4 — Checkout/account copy & formatting
| ID | Sev | Item | Files | Acceptance |
|----|-----|------|-------|------------|
| **W6** | B | "No account needed" shown to logged-in users | `event-detail.ejs` (register CTA copy unconditional) | Copy is login-aware. *(narrative 3)* |
| **W7** | B | Prefill First/Last from the logged-in user | `registration-form.ejs` (split `user.displayName`, editable) | Names default for logged-in users, still editable. *(narrative 4)* |
| **W8** | B | My-Registrations headings + table gutters | `account-registrations.ejs` (+ minor SCSS cell padding) | "Registrations" section heading (parity with Waitlists); comfortable column spacing on both tables. *(narrative 5)* |
| **W9** | B | Catalog Month filter → dropdown | `events-list.ejs` (replace `type="month"` with a `<select>`) | Month is chosen from a list, not free-typed. (Partial-location search already works.) *(narrative 9)* |
| **W10** | B | Map link for vague locations | `event-detail.ejs` (suppress for "Online"/empty/too-short); event-form hint for a full address | No broken/pointless map link; admins nudged toward full addresses. *(narrative 8)* |

### Group 5 — Account management actions (decided: build both)
| ID | Sev | Item | Files | Acceptance |
|----|-----|------|-------|------------|
| **W11** | F | "Request a refund" on My-Registrations rows | Reuse `/registration/:id/refund-request`; gate on eligibility (CONFIRMED, no open request). `account-registrations.ejs` + service eligibility flag | Eligible rows expose the action; routes to the existing flow. *(narrative 5)* |
| **W12** | F | "Remove from waitlist" | New `POST /waitlist/:id/remove` (ownership-checked, CSRF) + confirmation dialog; `WaitlistService.removeFromWaitlist` exists. New controller/route/view. | A user can leave a waitlist with a confirm step; ownership enforced; reflected on dashboard + My Registrations. *(narrative 5)* |

### Group 6 — Refund money-safety (code review, must-do)
| ID | Sev | Item | Files | Acceptance |
|----|-----|------|-------|------------|
| **W13** | H | R3 — refund idempotency | `idempotencyKey: refund-${registrationId}-${amount}` on `stripe.refunds.create`; disable the refund-modal submit on click. `RefundService` + the admin refund modal JS | Double-submit / concurrent direct-refund + approve cannot create an unrecorded Stripe refund. |
| **W14** | H | R4 — partial-refund bound on net | `sp_partial_refund_registration` uses `COALESCE(net_amount_cents, gross)`. **New migration 008.** | SP balance matches the captured charge, agreeing with the TS check. |
| **W15** | H | R10 — note/reason length cap | ~500-char server-side cap on admin deny note + direct-refund reason. `admin/refunds.ts`, `admin/registrations.ts` | Oversized input rejected server-side. |

### Group 7 — Abuse hardening (code review, must-do)
| ID | Sev | Item | Files | Acceptance |
|----|-----|------|-------|------------|
| **W16** | H | R5 — IP source + limiter behavior | Prefer Fly's trusted client-IP header (documented fallback to XFF); return **429 immediately** on over-limit (drop the sleep-retry). `get-client-ip.ts`, `rate-limit.ts` | Rate-limit/audit IP isn't trivially client-spoofable; over-limit doesn't hold request handlers open. |

### Group 8 — Analytics correctness + completeness (decided: everything)
| ID | Sev | Item | Files | Acceptance |
|----|-----|------|-------|------------|
| **W17** | H | R2 — net/refund math | Same population for gross and refunds. **Recommended definition:** period gross = gross of registrations confirmed-in-period; period refunds = `refund_log` rows dated in-period; `net = gross − refunds`; `refundRate = refunds / gross`. `analytics-service.ts` | Net can't go spuriously negative; refund-rate can't exceed 100%; per-event table consistent. |
| **W18** | F | R1 — page_views | **New migration 008** `page_views` table + a lightweight view-count hook on storefront/detail routes (no per-request bloat; counter upsert). Do it now while pre-launch. | View counts accrue from now; feeds the funnel's view stage. |
| **W19** | F | R6 — A1 funnel + revenue | 4 stages (Initiated→Authorized→Captured→Confirmed) + between-stage conversion %; daily series truly net (subtract refunds) and relabel. `analytics-service.ts`, `analytics-body.ejs` | Funnel matches spec; the revenue chart is net. |
| **W20** | F | R7 — A5 attention panel | Full trigger set, prioritized + deep-linked: pending refunds, unsent receipts >1h, `PENDING_CAPTURE` >2h, DRAFTs opening soon, A2 AT-RISK events, events in next 7 days. `admin-dashboard-service.ts`, `dashboard.ejs` | Each trigger fires on a fixture; calm when empty. |
| **W21** | F | R8 — A2 + WF-10 strip | Per-event funnel (+ views once W18 lands), revenue panel, full CSV set; wire the **unused `sparkline()`** + projection sentence as the WF-10 compact strip on the admin event-detail page. `event-performance.ejs`, `admin/event-detail.ejs` | A2 complete; event-detail shows the sparkline strip + link. |
| **W22** | F | R9 — V3 OG tags | `og:type=event`; static brand-card `og:image` fallback for image-less events. `catalog.ts`, `layouts/main.ejs` | Card debugger validates; image-less events still unfurl. |

---

## Deferred (with hand-off notes)
- **Grouped / register-for-others** — a new increment (suggest **I11 "Group registrations"**):
  a logged-in user registers multiple people, each a distinct email → shadow account,
  all rolling up under their account, each independently notified. Touches button
  sensitivity (double-register rules), the "you're registered" logic, the account
  rollup, and notifications. Needs its own design doc before build.
- **Saved payment methods for logged-in users** — write a short spike/design first
  (Stripe Customer object per user, SetupIntent / save-on-checkout, near-1-click reuse,
  and how it coexists with the now-disabled Link). Build in a later increment.
- **Email double-entry everywhere** — kept to register + waitlist only for now.

## Operational follow-ups (from code-review N-notes — not feature work)
- `seed:demo` on the Fly testbed needs `SEED_DEMO_FORCE=1` (Dockerfile sets
  `NODE_ENV=production`) and TRUNCATEs domain tables — destructive, testbed-only.
- Seeded registrations use synthetic `pi_demo_*` PIs → live Stripe refund buttons
  won't move real money for seeded rows (use a genuinely-checked-out registration).
- Migration 007 isn't independently re-runnable (no `IF NOT EXISTS` guards) — safe
  under the migrate runner; note for any manual re-apply. Two new migrations (008)
  land in this pass (W14 SP, W18 page_views) — keep them additive.
- Remote `claude/intelligent-archimedes-rflm8c` branch + stale `Baseline-1-0` tag:
  owner cleanup pending (env is 403 on those deletes).

## Suggested sequence
W1 (critical) → W2 (admin access, unblocks analytics testing) → W3–W12 (waitlist +
account UX cluster) → W13–W16 (money-safety + hardening) → W17–W22 (analytics; do W18
`page_views` early since it's a migration + structural). Migrations W14 + W18 fold into
one `008_*.sql`. Full gate green + key-less validation per the I1–I10 discipline.
