# Issue Log

Remaining issues identified during code review that do not block deployment or core functionality but should be addressed.

## Code Quality

### Multiple pino logger instances
- **Files**: `src/index.ts`, `src/web/middleware/request-logger.ts`, `src/web/controllers/auth.ts`
- **Issue**: Each file creates its own `pino({ level: 'info' })` instance. Should share a single configured logger (e.g., export from a `src/logger.ts` module).

### Database pool not configured
- **File**: `src/services/db.ts`
- **Issue**: `postgres(config.databaseUrl)` uses default pool settings. On a 256MB Fly.io VM, should explicitly set `max`, `idle_timeout`, and `connect_timeout`.

### Deprecated docker-compose version key
- **File**: `docker-compose.yml`
- **Issue**: `version: '3.8'` is deprecated in Docker Compose v2+. Remove the line to suppress warnings.

## Spec Compliance

### Missing action-logger middleware
- **File**: `src/web/app.ts`
- **Issue**: The spec requires an action-logger middleware that automatically logs `user_action_events` for every authenticated request. Currently, action logging is done manually in individual controllers, so page views like `GET /dashboard` and `GET /profile` are never logged.

### Profile update returns inline HTML instead of EJS partials
- **File**: `src/web/controllers/profile.ts` (lines 54, 72)
- **Issue**: Returns raw `c.html(...)` strings instead of rendering the `profile-feedback.ejs` partial. Should use `renderView` or `ejs.renderFile` for consistency.

### Email enumeration via /api/check-email
- **File**: `src/web/middleware/csrf.ts` (line 6), `src/web/controllers/auth.ts` (lines 158-171)
- **Issue**: The `/api/check-email` endpoint is CSRF-exempt and reveals whether an email is registered. While it is rate-limited (20 req/min), any cross-origin site can probe it. Consider requiring CSRF tokens for this endpoint (pass via HTMX headers) or returning a generic response.

## Minor

### Login failure reason ordering
- **File**: `src/web/controllers/auth.ts` (lines 46-48)
- **Issue**: If the password is invalid AND the user is unverified, `failureReason` is set to `not_verified` instead of `invalid_password`. The priority ordering is debatable but may mask brute-force attempts against unverified accounts.

### Seed script redundant UPDATE
- **File**: `scripts/seed.ts` (lines 15-25)
- **Issue**: The `INSERT ... ON CONFLICT DO NOTHING` is immediately followed by an unconditional `UPDATE` on the same email, making the conflict handling pointless. Should use `ON CONFLICT DO UPDATE` or remove the separate UPDATE.

### SESSION_SECRET defaults to hardcoded value in development
- **File**: `src/config.ts` (line 11)
- **Issue**: Falls back to `'dev-secret-change-me'` when `SESSION_SECRET` is unset and `NODE_ENV` is not `production`. Low risk since production enforces the env var, but could be a problem if `NODE_ENV` is misconfigured.
