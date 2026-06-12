import 'dotenv/config';
import { truncateTables, createTestEvent, testSql, TEST_EVENT_ID, assert, assertEqual } from './test-helpers.js';
import { RegistrationService } from '../services/RegistrationService.js';
import { MockStripeClient } from './MockStripeClient.js';

class NoopNotificationService {
  async sendRegistrationConfirmation() {}
  async sendWaitlistAcknowledgement() {}
  async sendRefundConfirmation() {}
}

async function createPendingPaymentReg(piId: string): Promise<string> {
  const rows = await testSql.unsafe(`
    SELECT * FROM sp_initiate_registration(
      '${TEST_EVENT_ID}'::UUID,
      'user_${piId}@example.com',
      'Test', 'User', NULL, '{}'::JSONB, 10000, '${piId}'
    )
  `);
  return rows[0].registration_id;
}

async function runTests() {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => Promise<void>) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}:`, e instanceof Error ? e.message : e); failed++; }
  }

  console.log('\n=== Increment 5: handlePaymentAuthorized Tests ===\n');

  await test('5-1: happy path acquires slot, captures, finalizes', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });
    const piId = 'pi_auth_test_01';
    await createPendingPaymentReg(piId);

    const stripe = new MockStripeClient({ captureNetAmountCents: 9700 });
    const svc = new RegistrationService(stripe as any, new NoopNotificationService() as any);

    const result = await svc.handlePaymentAuthorized(piId, 10000);
    assertEqual(result.outcome, 'SUCCESS', 'outcome');
    assert(result.registrationId != null, 'registrationId set');

    stripe.assertCalled('paymentIntents.capture');

    // Verify DB state
    const rows = await testSql.unsafe(`SELECT status, net_amount_cents FROM registrations WHERE payment_intent_id = '${piId}'`);
    assertEqual(rows[0].status, 'CONFIRMED', 'status');
    assertEqual(rows[0].net_amount_cents, 9700, 'net_amount_cents');
  });

  await test('5-2: AVAILABILITY_EXHAUSTED cancels PI', async () => {
    await truncateTables();
    await createTestEvent({ totalCapacity: 1, availableSlots: 0, confirmedCount: 1, registrationFeeCents: 10000 });
    // Insert a registration in PENDING_PAYMENT (bypass sp which checks available)
    const piId = 'pi_auth_test_02';
    await testSql.unsafe(`
      INSERT INTO registrations (event_id, email, first_name, last_name, gross_amount_cents, payment_intent_id, status)
      VALUES ('${TEST_EVENT_ID}', 'full@example.com', 'Full', 'Event', 10000, '${piId}', 'PENDING_PAYMENT')
    `);

    const stripe = new MockStripeClient();
    const svc = new RegistrationService(stripe as any, new NoopNotificationService() as any);

    const result = await svc.handlePaymentAuthorized(piId, 10000);
    assertEqual(result.outcome, 'AVAILABILITY_EXHAUSTED', 'outcome');
    stripe.assertCalled('paymentIntents.cancel');
  });

  await test('5-3: PENDING_CAPTURE idempotent replay', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });
    const piId = 'pi_auth_test_03';
    await createPendingPaymentReg(piId);
    // Stage capture first
    await testSql.unsafe(`SELECT * FROM sp_acquire_slot_and_stage_capture('${piId}')`);

    const stripe = new MockStripeClient();
    const svc = new RegistrationService(stripe as any, new NoopNotificationService() as any);

    const result = await svc.handlePaymentAuthorized(piId, 10000);
    // IDEMPOTENT_REPLAY or SUCCESS depending on captured state
    assert(['IDEMPOTENT_REPLAY', 'SUCCESS'].includes(result.outcome), `Expected idempotent or success, got ${result.outcome}`);
  });

  await test('5-4: NOT_FOUND for unknown PI', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });

    const stripe = new MockStripeClient();
    const svc = new RegistrationService(stripe as any, new NoopNotificationService() as any);

    const result = await svc.handlePaymentAuthorized('pi_nonexistent', 10000);
    assertEqual(result.outcome, 'NOT_FOUND', 'outcome');
  });

  await test('5-5: transient capture failure increments attempt count', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });
    const piId = 'pi_auth_test_05';
    await createPendingPaymentReg(piId);

    const stripe = new MockStripeClient({ captureErrorType: 'transient' });
    const svc = new RegistrationService(stripe as any, new NoopNotificationService() as any);

    const result = await svc.handlePaymentAuthorized(piId, 10000);
    assertEqual(result.outcome, 'CAPTURE_FAILED', 'outcome');

    const rows = await testSql.unsafe(`SELECT capture_attempt_count, status FROM registrations WHERE payment_intent_id = '${piId}'`);
    assertEqual(rows[0].status, 'PENDING_CAPTURE', 'status should still be PENDING_CAPTURE');
    assert(rows[0].capture_attempt_count >= 1, 'attempt count incremented');
  });

  await test('5-6: permanent capture failure restores slot', async () => {
    await truncateTables();
    await createTestEvent({ totalCapacity: 5, registrationFeeCents: 10000 });
    const piId = 'pi_auth_test_06';
    await createPendingPaymentReg(piId);

    const stripe = new MockStripeClient({ captureErrorType: 'permanent' });
    const svc = new RegistrationService(stripe as any, new NoopNotificationService() as any);

    const result = await svc.handlePaymentAuthorized(piId, 10000);
    assertEqual(result.outcome, 'CAPTURE_FAILED', 'outcome');

    const regRows = await testSql.unsafe(`SELECT status FROM registrations WHERE payment_intent_id = '${piId}'`);
    assertEqual(regRows[0].status, 'PAYMENT_FAILED', 'status');

    // Slot should be restored
    const evRows = await testSql.unsafe(`SELECT available_slots, confirmed_count FROM events WHERE event_id = '${TEST_EVENT_ID}'`);
    assertEqual(evRows[0].available_slots, 5, 'slot restored');
  });

  await testSql.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
