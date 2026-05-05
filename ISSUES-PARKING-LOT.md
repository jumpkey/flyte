# Issues Parking Lot

Deferred issues identified during pre-deployment review of the Stripe registration flow.
These are not blocking deployment to a test container but should be addressed before
production release.

---

## Testing

### B1 — SQL injection patterns in test helpers (Low)
Several test files use `testSql.unsafe()` with template literal interpolation to call
stored procedures. While this only runs against a test database and is not a production
risk, switching to parameterised queries would make the test code a better reference for
contributors.

**Files:** `increment-6.test.ts`, `review-fixes.test.ts`

### B3 — NotificationService tests only assert "no throw" (Low)
`increment-8.test.ts` validates that email-sending methods do not throw, but does not
inspect the email content, subject, or recipient. Consider adding assertions on the
rendered email body once the notification service is integrated with a mail trap in CI.

### B6 — Rate limiting not tested (Low)
The server-side retry-with-backoff behaviour added to the rate limiter should be
validated. A unit test that demonstrates a burst of requests getting absorbed (delayed)
rather than rejected would be valuable. This is non-trivial because the retry introduces
real sleeps; a test would need to mock `setTimeout` or use a fake clock.

---

## Load Testing

### C2 — Ramp-up delay only applies to first batch of tasks (Very Low)
`stress_test.py` only applies `await asyncio.sleep(ramp_up / concurrency)` for the
first `concurrency` tasks. Subsequent batches start immediately. For most realistic
load patterns this is fine, but if a true linear ramp is desired, the delay should be
distributed across all tasks.

### C3 — Stripe simulator doesn't validate PI status before capture (Low)
The FastAPI stripe simulator (`stripe_simulator.py`) accepts a capture request for a
PI in any state. In real Stripe, capturing a PI that is not in `requires_capture` returns
an error. Add a status check to make the simulator a more faithful test double.

### C4 — Simulator ignores API version header (Very Low)
The simulator does not validate the `Stripe-Version` header. This is unlikely to cause
issues but could be added for completeness.

---

## Documentation

### D1 — DEPLOY.md references non-existent `dist/scripts/migrate.js` (Low)
Line 262 of `load_testing/DEPLOY.md` references `dist/scripts/migrate.js` as a migration
entry point. Verify this path exists in the Docker build output or update the reference.

### D2 — Fly.io secrets retrieval example (Low)
`DEPLOY.md` line 470 uses `fly secrets list` to retrieve secret values, but `fly secrets list`
only shows names, not values. Update with the correct retrieval method or note the limitation.

### D3 — STRIPE-INTEGRATION.md error code precision (Low)
Some HTTP status code descriptions in `STRIPE-INTEGRATION.md` are approximate. Consider
adding the exact codes returned by each endpoint for troubleshooting reference.

### D4 — REVIEW-FIXES-TEST-PLAN.md branch name (Cosmetic)
The document references branch `claude/review-payment-processing-VXPz4` which was the
review-fixes branch. This is accurate historically but may cause confusion if read in
isolation. Consider noting that fixes were merged into the main feature branch.

---

## Security

### E1 — Public registration endpoints (By Design)
Registration and waitlist endpoints are intentionally unauthenticated. Rate limiting
and CSRF protection provide the abuse mitigation layer. No action needed unless the
threat model changes.

### E3 — CSP allows `unsafe-inline` for styles (Low)
The Content Security Policy includes `'unsafe-inline'` in `style-src` to support Pico CSS
and inline styling. This is a common trade-off but could be tightened with nonce-based
CSP if inline styles are refactored to external stylesheets.

---

## Architecture

### Webhook / reconciliation race condition (Low, documented)
Both the webhook handler and the reconciliation sweep can process the same registration
concurrently. The stored procedures handle this correctly via `FOR UPDATE SKIP LOCKED`
and idempotent result codes (`IDEMPOTENT_REPLAY`), so no data corruption can occur.
However, a transient duplicate Stripe capture call is possible (the second call will
fail gracefully). This is a known and acceptable trade-off.

### Bulk refund `restore_availability` flag (Low)
`RefundService.refundEvent()` passes `restore_availability = FALSE` to `sp_cancel_registration`.
This means `available_slots` is not restored after a bulk refund. This may be intentional
(a cancelled event shouldn't show slots as available) but should be explicitly documented
in STRIPE-INTEGRATION.md.
