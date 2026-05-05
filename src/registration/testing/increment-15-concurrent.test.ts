/**
 * Increment 15: Concurrent registration tests.
 * Validates that the capacity invariant holds under concurrent
 * registration attempts at the service layer.
 *
 * Run: npx tsx src/registration/testing/increment-15-concurrent.test.ts
 */
import 'dotenv/config';
import { truncateTables, createTestEvent, testSql, TEST_EVENT_ID, assert, assertEqual } from './test-helpers.js';
import { RegistrationService } from '../services/RegistrationService.js';
import { EventAvailabilityService } from '../services/EventAvailabilityService.js';
import { MockStripeClient } from './MockStripeClient.js';

class NoopNotificationService {
  async sendRegistrationConfirmation() {}
  async sendWaitlistAcknowledgement() {}
  async sendRefundConfirmation() {}
}

async function runTests() {
  let passed = 0;
  let failed = 0;
  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`  \u2713 ${name}`);
      passed++;
    } catch (e) {
      console.error(`  \u2717 ${name}:`, e instanceof Error ? e.message : String(e));
      failed++;
    }
  }

  console.log('\n=== Increment 15: Concurrent Registration Tests ===\n');

  // ── Test: concurrent registrations respect capacity ──
  await test('15-1: 20 concurrent registrations for 5-slot event yield exactly 5 confirmed', async () => {
    await truncateTables();
    const capacity = 5;
    await createTestEvent({ totalCapacity: capacity, registrationFeeCents: 10000 });

    const stripe = new MockStripeClient({ captureNetAmountCents: 9700 });
    const notif = new NoopNotificationService();

    // Create 20 registration services sharing the same mock Stripe
    const attempts = 20;
    const promises: Promise<{ initOutcome: string; authOutcome: string | null }>[] = [];

    for (let i = 0; i < attempts; i++) {
      const svc = new RegistrationService(stripe as any, notif as any);
      promises.push(
        (async () => {
          const initResult = await svc.initiateRegistration({
            eventId: TEST_EVENT_ID,
            email: `concurrent_${i}@example.com`,
            firstName: 'User',
            lastName: `Num${i}`,
            grossAmountCents: 10000,
          });

          if (initResult.outcome !== 'SUCCESS') {
            return { initOutcome: initResult.outcome, authOutcome: null };
          }

          const authResult = await svc.handlePaymentAuthorized(
            initResult.paymentIntentId!,
            10000
          );
          return { initOutcome: initResult.outcome, authOutcome: authResult.outcome };
        })()
      );
    }

    const results = await Promise.all(promises);

    const successfulAuths = results.filter(
      (r) => r.authOutcome === 'SUCCESS' || r.authOutcome === 'IDEMPOTENT_REPLAY'
    );
    const exhausted = results.filter(
      (r) => r.authOutcome === 'AVAILABILITY_EXHAUSTED'
    );

    assertEqual(successfulAuths.length, capacity, `exactly ${capacity} should succeed`);
    assertEqual(
      exhausted.length,
      attempts - capacity,
      `${attempts - capacity} should be AVAILABILITY_EXHAUSTED`
    );

    // Verify DB state
    const availSvc = new EventAvailabilityService();
    const avail = await availSvc.getAvailability(TEST_EVENT_ID);
    assertEqual(avail!.availableSlots, 0, 'no slots remaining');
    assertEqual(avail!.confirmedCount, capacity, 'confirmed count matches capacity');
  });

  // ── Test: concurrent registrations for same email are deduplicated ──
  await test('15-2: concurrent duplicate email registrations are rejected', async () => {
    await truncateTables();
    await createTestEvent({ totalCapacity: 10, registrationFeeCents: 10000 });

    const stripe = new MockStripeClient();
    const notif = new NoopNotificationService();

    const duplicateAttempts = 5;
    const promises: Promise<string>[] = [];

    for (let i = 0; i < duplicateAttempts; i++) {
      const svc = new RegistrationService(stripe as any, notif as any);
      promises.push(
        svc
          .initiateRegistration({
            eventId: TEST_EVENT_ID,
            email: 'same_email@example.com',
            firstName: 'Same',
            lastName: 'User',
            grossAmountCents: 10000,
          })
          .then((r) => r.outcome)
      );
    }

    const outcomes = await Promise.all(promises);
    const successes = outcomes.filter((o) => o === 'SUCCESS');
    const duplicates = outcomes.filter((o) => o === 'ALREADY_REGISTERED');

    assertEqual(successes.length, 1, 'exactly 1 should succeed');
    assertEqual(duplicates.length, duplicateAttempts - 1, 'rest should be ALREADY_REGISTERED');
  });

  // ── Test: capacity invariant CHECK constraint holds ──
  await test('15-3: confirmed_count never exceeds total_capacity in DB', async () => {
    // After the concurrent test above, verify the CHECK constraint
    await truncateTables();
    await createTestEvent({ totalCapacity: 3, registrationFeeCents: 10000 });

    const stripe = new MockStripeClient({ captureNetAmountCents: 9700 });
    const notif = new NoopNotificationService();

    const attempts = 10;
    const promises: Promise<void>[] = [];

    for (let i = 0; i < attempts; i++) {
      const svc = new RegistrationService(stripe as any, notif as any);
      promises.push(
        (async () => {
          const init = await svc.initiateRegistration({
            eventId: TEST_EVENT_ID,
            email: `cap_${i}@example.com`,
            firstName: 'Cap',
            lastName: `User${i}`,
            grossAmountCents: 10000,
          });
          if (init.outcome === 'SUCCESS') {
            await svc.handlePaymentAuthorized(init.paymentIntentId!, 10000);
          }
        })()
      );
    }

    await Promise.all(promises);

    // Verify constraint
    const rows = await testSql`
      SELECT confirmed_count, total_capacity, available_slots
      FROM events WHERE event_id = ${TEST_EVENT_ID}
    `;
    const event = rows[0];
    assert(
      event.confirmed_count <= event.total_capacity,
      `confirmed_count (${event.confirmed_count}) must not exceed total_capacity (${event.total_capacity})`
    );
    assertEqual(
      event.available_slots,
      event.total_capacity - event.confirmed_count,
      'available_slots = total_capacity - confirmed_count'
    );
  });

  await testSql.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
