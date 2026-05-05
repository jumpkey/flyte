# Issue Log

Tracked issues identified during code review. None of these block deployment or
affect core functionality; they are documented here for later consideration.

Items marked ~~strikethrough~~ have been resolved and are kept for historical reference.

---

## Code Quality

### Multiple pino logger instances (Low)
- **Files**: `src/index.ts`, `src/web/middleware/request-logger.ts`, `src/web/controllers/auth.ts`
- **Issue**: Each file creates its own `pino({ level: 'info' })` instance. Should share
  a single configured logger exported from a `src/logger.ts` module.

### ~~Database pool not configured~~ (Resolved)
- **File**: `src/services/db.ts`
- **Resolution**: Pool is now configured with `max: 5`, `idle_timeout: 10`,
  `max_lifetime: 60`, `connect_timeout: 15`.

### Deprecated docker-compose version key (Very Low)
- **File**: `docker-compose.yml`
- **Issue**: `version: '3.8'` is deprecated in Docker Compose v2+. Remove the line
  to suppress warnings.

### Seed script redundant UPDATE (Very Low)
- **File**: `scripts/seed.ts`
- **Issue**: `INSERT ... ON CONFLICT DO NOTHING` is immediately followed by an
  unconditional `UPDATE` on the same email, making the conflict handling pointless.
  Should use `ON CONFLICT DO UPDATE` or remove the separate `UPDATE`.

---

## Spec Compliance

### Missing action-logger middleware (Low)
- **File**: `src/web/app.ts`
- **Issue**: The spec requires an action-logger middleware that automatically logs
  `user_action_events` for every authenticated request. Currently, action logging is
  done manually in individual controllers, so page views like `GET /dashboard` and
  `GET /profile` are never logged.

### Profile update returns inline HTML instead of EJS partials (Low)
- **File**: `src/web/controllers/profile.ts` (lines 23, 55, 73)
- **Issue**: Returns raw `c.html(...)` strings instead of rendering the
  `profile-feedback.ejs` partial. Should use `renderView` or `ejs.renderFile`
  for consistency with the rest of the application.

---

## Security

### Email enumeration via /api/check-email (Low)
- **File**: `src/web/middleware/csrf.ts`, `src/web/controllers/auth.ts`
- **Issue**: The `/api/check-email` endpoint is CSRF-exempt and reveals whether an
  email is registered. While rate-limited (20 req/min), any cross-origin site can
  probe it. Consider requiring CSRF tokens (pass via HTMX headers) or returning a
  generic response.

### Login failure reason ordering (Very Low)
- **File**: `src/web/controllers/auth.ts` (lines 44–48)
- **Issue**: If the password is invalid AND the user is unverified, `failureReason`
  is set to `not_verified` instead of `invalid_password`. The priority ordering is
  debatable but may mask brute-force attempts against unverified accounts.

### SESSION_SECRET defaults to hardcoded value in development (Very Low)
- **File**: `src/config.ts` (line 11)
- **Issue**: Falls back to `'dev-secret-change-me'` when `SESSION_SECRET` is unset
  and `NODE_ENV` is not `production`. Low risk since production enforces the env var,
  but could be a problem if `NODE_ENV` is misconfigured.

### CSP allows `unsafe-inline` for styles (Low)
- **Issue**: The Content Security Policy includes `'unsafe-inline'` in `style-src` to
  support Pico CSS and inline styling. Could be tightened with nonce-based CSP if
  inline styles are refactored to external stylesheets.

### Public registration endpoints (By Design — no action needed)
- Registration and waitlist endpoints are intentionally unauthenticated. Rate limiting
  and CSRF protection provide the abuse mitigation layer.

---

## Testing

### SQL injection patterns in test helpers (Low)
- **Files**: `src/registration/testing/increment-6.test.ts`, `review-fixes.test.ts`
- **Issue**: Several test files use `testSql.unsafe()` with template literal
  interpolation to call stored procedures. Not a production risk (test-only code),
  but switching to parameterised queries would make the test code a better reference.

### NotificationService tests only assert "no throw" (Low)
- **File**: `src/registration/testing/increment-8.test.ts`
- **Issue**: Validates that email-sending methods do not throw, but does not inspect
  email content, subject, or recipient. Add assertions on the rendered email body once
  a mail trap is integrated in CI.

### Rate limiter retry-with-backoff not tested (Low)
- **Issue**: The server-side retry-with-backoff behaviour should be validated with a
  unit test demonstrating that a burst of requests is absorbed (delayed) rather than
  rejected. Non-trivial because the retry introduces real sleeps — would need a mocked
  clock.

---

## Load Testing

### Ramp-up delay only applies to first batch (Very Low)
- **File**: `load_testing/stress_test.py`
- **Issue**: `await asyncio.sleep(ramp_up / concurrency)` only applies for the first
  `concurrency` tasks. Subsequent batches start immediately. Fine for most realistic
  load patterns, but a true linear ramp would distribute the delay across all tasks.

### Stripe simulator doesn't validate PI status before capture (Low)
- **File**: `load_testing/stripe_simulator.py`
- **Issue**: Accepts a capture request for a PI in any state. Real Stripe returns an
  error when capturing a PI not in `requires_capture`. Add a status check to make the
  simulator a more faithful test double.

### Simulator ignores API version header (Very Low)
- **Issue**: The simulator does not validate the `Stripe-Version` header. Unlikely to
  cause issues but could be added for completeness.

---

## Documentation

### DEPLOY.md references `dist/scripts/migrate.js` (Low)
- **File**: `load_testing/DEPLOY.md`
- **Issue**: References `dist/scripts/migrate.js` as a migration entry point. Verify
  this path exists in the Docker build output or update the reference.

### Fly.io secrets retrieval example (Low)
- **File**: `load_testing/DEPLOY.md`
- **Issue**: Uses `fly secrets list` to retrieve secret values, but that command only
  shows names, not values. Update with the correct retrieval method or note the
  limitation.

### STRIPE-INTEGRATION.md error code precision (Low)
- **Issue**: Some HTTP status code descriptions in `STRIPE-INTEGRATION.md` are
  approximate. Consider adding the exact codes returned by each endpoint.

### REVIEW-FIXES-TEST-PLAN.md branch name (Cosmetic)
- **Issue**: References branch `claude/review-payment-processing-VXPz4` which was the
  review-fixes branch. Accurate historically but may cause confusion in isolation.

---

## Architecture

### Webhook / reconciliation race condition (Low, documented — no action needed)
- Both the webhook handler and the reconciliation sweep can process the same
  registration concurrently. Stored procedures handle this via `FOR UPDATE SKIP LOCKED`
  and `IDEMPOTENT_REPLAY` result codes, so no data corruption can occur. A transient
  duplicate Stripe capture call is possible (fails gracefully). Known and accepted.

### Bulk refund `restore_availability` flag (Low)
- **File**: `src/registration/services/RefundService.ts`
- **Issue**: `refundEvent()` passes `restore_availability = FALSE` to
  `sp_cancel_registration`, so `available_slots` is not restored after a bulk refund.
  May be intentional (a cancelled event shouldn't show available slots) but should be
  explicitly documented in STRIPE-INTEGRATION.md.
