import 'dotenv/config';
import { truncateTables, createTestEvent, testSql, TEST_EVENT_ID, assert, assertEqual } from './test-helpers.js';
import { RefundService } from '../services/RefundService.js';
import { MockStripeClient } from './MockStripeClient.js';

class NoopNotificationService {
  async sendRegistrationConfirmation() {}
  async sendWaitlistAcknowledgement() {}
  async sendRefundConfirmation() {}
}

async function createConfirmedRegistration(piId: string, email: string): Promise<string> {
  const rows = await testSql.unsafe(`
    SELECT * FROM sp_initiate_registration(
      '${TEST_EVENT_ID}'::UUID,
      '${email}', 'Test', 'User', NULL, '{}'::JSONB, 10000, '${piId}'
    )
  `);
  const regId = rows[0].registration_id;
  await testSql.unsafe(`SELECT * FROM sp_acquire_slot_and_stage_capture('${piId}')`);
  await testSql.unsafe(`SELECT * FROM sp_finalize_registration('${piId}', 9700)`);
  return regId;
}

async function runTests() {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => Promise<void>) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}:`, e instanceof Error ? e.message : e); failed++; }
  }

  console.log('\n=== Increment 9: RefundService Tests ===\n');

  await test('9-1: full refund on confirmed registration', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });
    const regId = await createConfirmedRegistration('pi_refund_01', 'refund1@example.com');

    const stripe = new MockStripeClient();
    const svc = new RefundService(stripe as any, new NoopNotificationService() as any);

    const result = await svc.refundRegistration({ registrationId: regId, refundType: 'FULL', reason: 'test' });
    assertEqual(result.outcome, 'REFUND_ISSUED', 'outcome');
    assert(result.stripeRefundId != null, 'stripeRefundId set');
    stripe.assertCalled('refunds.create');
  });

  await test('9-2: partial refund on confirmed registration', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });
    const regId = await createConfirmedRegistration('pi_refund_02', 'refund2@example.com');

    const stripe = new MockStripeClient();
    const svc = new RefundService(stripe as any, new NoopNotificationService() as any);

    const result = await svc.refundRegistration({ registrationId: regId, refundType: 'PARTIAL', partialAmountCents: 2500, reason: 'partial test' });
    assertEqual(result.outcome, 'PARTIAL_REFUND_ISSUED', 'outcome');
    assertEqual(result.refundedAmountCents, 2500, 'refundedAmountCents');
  });

  await test('9-3: refund on non-existent registration returns NOT_FOUND', async () => {
    await truncateTables();
    const stripe = new MockStripeClient();
    const svc = new RefundService(stripe as any, new NoopNotificationService() as any);

    const result = await svc.refundRegistration({ registrationId: '00000000-0000-0000-0000-000000000099', refundType: 'FULL', reason: 'test' });
    assertEqual(result.outcome, 'NOT_FOUND', 'outcome');
  });

  await test('9-4: Stripe error returns STRIPE_ERROR', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });
    const regId = await createConfirmedRegistration('pi_refund_04', 'refund4@example.com');

    const stripe = new MockStripeClient({ refundShouldError: true });
    const svc = new RefundService(stripe as any, new NoopNotificationService() as any);

    const result = await svc.refundRegistration({ registrationId: regId, refundType: 'FULL', reason: 'test' });
    assertEqual(result.outcome, 'STRIPE_ERROR', 'outcome');
  });

  await test('9-5: partial refund exceeding balance returns AMOUNT_EXCEEDS_BALANCE', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });
    const regId = await createConfirmedRegistration('pi_refund_05', 'refund5@example.com');

    const stripe = new MockStripeClient();
    const svc = new RefundService(stripe as any, new NoopNotificationService() as any);

    const result = await svc.refundRegistration({ registrationId: regId, refundType: 'PARTIAL', partialAmountCents: 99999, reason: 'test' });
    assertEqual(result.outcome, 'AMOUNT_EXCEEDS_BALANCE', 'outcome');
  });

  await test('9-6: bulk event refund', async () => {
    await truncateTables();
    await createTestEvent({ totalCapacity: 3, registrationFeeCents: 10000 });
    await createConfirmedRegistration('pi_bulk_01', 'bulk1@example.com');
    await createConfirmedRegistration('pi_bulk_02', 'bulk2@example.com');

    const stripe = new MockStripeClient();
    const svc = new RefundService(stripe as any, new NoopNotificationService() as any);

    const result = await svc.refundEvent({ eventId: TEST_EVENT_ID, refundType: 'FULL', reason: 'event cancelled' });
    assertEqual(result.totalProcessed, 2, 'totalProcessed');
    assertEqual(result.totalSucceeded, 2, 'totalSucceeded');
    assertEqual(result.totalFailed, 0, 'totalFailed');

    // Event should be CANCELLED
    const evRows = await testSql.unsafe(`SELECT status FROM events WHERE event_id = '${TEST_EVENT_ID}'`);
    assertEqual(evRows[0].status, 'CANCELLED', 'event status');
  });

  await testSql.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
