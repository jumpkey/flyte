# Load Test Run Results — Pre-PR-Approval Validation

**Run date:** 2026-05-05T22:53:50Z  
**Branch:** `copilot/implement-stripe-registration-flow`  
**Environment:** CI sandbox — Flyte app + Stripe simulator + Postgres all on localhost  
**Purpose:** Final end-to-end validation before PR approval

---

## Regression test suite

All **14** test files passed:

```
✓ increment-1.test.ts
✓ increment-3.test.ts
✓ increment-4.test.ts
✓ increment-5.test.ts
✓ increment-6.test.ts
✓ increment-7.test.ts
✓ increment-8.test.ts
✓ increment-9.test.ts
✓ increment-10.test.ts
✓ increment-11.test.ts
✓ increment-13.test.ts
✓ increment-14-webhook-http.test.ts
✓ increment-15-concurrent.test.ts
✓ review-fixes.test.ts

=== Summary: 14 test files passed, 0 test files failed ===
```

### Fix applied during this session

**Test 15-2 (`concurrent duplicate email registrations are rejected`) was failing.**

Root cause: two independent problems compounded each other.

1. **MockStripeClient did not honour idempotency keys.** `RegistrationService` constructs a deterministic idempotency key from `(eventId, sha256(email))` so that real Stripe returns the **same** PaymentIntent for concurrent requests with the same email (Stripe-side deduplication). MockStripeClient was ignoring `reqOptions.idempotencyKey` and generating a fresh random PI ID on every call, so 5 concurrent duplicate-email requests produced 5 different PI IDs instead of 1.

2. **`sp_initiate_registration` had a TOCTOU race condition.** The stored procedure checked for existing registrations with `SELECT COUNT(*) … WHERE status NOT IN (…)` before doing `INSERT`. With 5 different PI IDs and no per-email serialisation, all 5 concurrent transactions read `count = 0`, then all 5 successfully inserted, giving `SUCCESS` × 5 instead of `SUCCESS` × 1.

**Fixes:**

- `src/registration/testing/MockStripeClient.ts` — added `_idempotencyCache` map; `paymentIntents.create` now returns the cached PI when the same idempotency key is reused, exactly matching real Stripe behaviour. `reset()` clears the cache.

- `db/migrations/006_fix_email_uniqueness.sql` — adds a partial unique index `idx_registrations_active_email ON registrations(event_id, lower(email)) WHERE status NOT IN ('PAYMENT_FAILED', 'EXPIRED', 'CANCELLED')` and replaces `sp_initiate_registration` with a version that attempts the `INSERT` directly and catches `unique_violation` (returning `ALREADY_REGISTERED`). This is fully atomic and eliminates the TOCTOU race for both the mock path (different PI IDs) and any edge case in production.

---

## Load test

### Configuration

| Parameter | Value |
|-----------|-------|
| Target | `http://localhost:3000` |
| Event | `c428fa33-d9b6-4156-88a6-5e86c1baa4fb` ("Pre-PR Load Test Event", capacity 200) |
| Concurrency | 10 workers |
| Total attempts | 50 |
| Phase | `1+3` (full flow: PI create → browser confirm → capture) |
| Stripe simulator | `http://127.0.0.1:12111` (no artificial delays or fault injection) |
| Rate-limit bypass | enabled (`X-Forwarded-For` spoofing — dev only) |

### Results

```
═══ Load Test Results ═══
  Total wall-clock time: 0.33s

Phase 1 (initiate)
┏━━━━━━━━━━━━┳━━━━━━━━━━━━━┓
┃ Metric     ┃       Value ┃
┡━━━━━━━━━━━━╇━━━━━━━━━━━━━┩
│ Requests   │          50 │
│ Throughput │ 149.9 req/s │
│ p50        │     21.3 ms │
│ p90        │     31.4 ms │
│ p95        │     36.6 ms │
│ p99        │     41.2 ms │
│ max        │     45.6 ms │
└────────────┴─────────────┘
Outcomes: SUCCESS × 50 (100.0%)
HTTP 200 × 50

Phase 3 (confirm)
┏━━━━━━━━━━━━┳━━━━━━━━━━━━━┓
┃ Metric     ┃       Value ┃
┡━━━━━━━━━━━━╇━━━━━━━━━━━━━┩
│ Requests   │          50 │
│ Throughput │ 149.9 req/s │
│ p50        │     27.2 ms │
│ p90        │     43.2 ms │
│ p95        │     47.4 ms │
│ p99        │     50.5 ms │
│ max        │     60.8 ms │
└────────────┴─────────────┘
Outcomes: SUCCESS × 50 (100.0%)
HTTP 302 → /confirmed × 50
```

### Database invariant check (post-run)

```sql
SELECT total_capacity, confirmed_count, available_slots,
       (confirmed_count + available_slots = total_capacity) AS invariant_ok
FROM events WHERE event_id = 'c428fa33-d9b6-4156-88a6-5e86c1baa4fb';

 total_capacity | confirmed_count | available_slots | invariant_ok
----------------+-----------------+-----------------+-------------
            200 |              50 |             150 | t

SELECT status, count(*) FROM registrations
WHERE event_id = 'c428fa33-d9b6-4156-88a6-5e86c1baa4fb'
GROUP BY status;

   status   | count
------------+-------
 CONFIRMED  |    50
```

`invariant_ok = true`. All 50 registrations landed in `CONFIRMED` status. No `PENDING_PAYMENT`, `PENDING_CAPTURE`, or `PAYMENT_FAILED` residuals.

### Interpretation

- **149.9 req/s** throughput for both phases on a single shared-CPU sandbox machine. This is the raw server capacity without rate limiting; the production rate limiter caps sustained per-IP throughput to ~10 requests per 60-second window, so real-user throughput is governed by that limit, not the server capacity.
- **p99 < 51 ms** for Phase 3 (which includes PI retrieve + capture + DB slot decrement + confirmed-count increment). This is very fast because the Stripe simulator responds in < 1 ms with no artificial delay.
- **0 errors** across 100 HTTP requests (50 Phase 1 + 50 Phase 3). The full two-phase flow is working correctly end-to-end.

The raw results JSON is in `load_testing/LOAD_TEST_RESULTS.json`.
