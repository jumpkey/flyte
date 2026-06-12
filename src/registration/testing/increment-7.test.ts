import 'dotenv/config';
import { truncateTables, createTestEvent, testSql, TEST_EVENT_ID, assert, assertEqual } from './test-helpers.js';
import { RegistrationService } from '../services/RegistrationService.js';
import { MockStripeClient } from './MockStripeClient.js';

class NoopNotificationService {
  async sendRegistrationConfirmation() {}
  async sendWaitlistAcknowledgement() {}
  async sendRefundConfirmation() {}
}

async function runTests() {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => Promise<void>) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}:`, e instanceof Error ? e.message : e); failed++; }
  }

  console.log('\n=== Increment 7: handlePaymentFailed Tests ===\n');

  await test('7-1: marks registration as PAYMENT_FAILED', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });

    const piId = 'pi_fail_test_01';
    await testSql.unsafe(`
      SELECT * FROM sp_initiate_registration(
        '${TEST_EVENT_ID}'::UUID,
        'fail@example.com', 'Fail', 'User', NULL, '{}'::JSONB, 10000, '${piId}'
      )
    `);

    const stripe = new MockStripeClient();
    const svc = new RegistrationService(stripe as any, new NoopNotificationService() as any);

    const result = await svc.handlePaymentFailed(piId, { type: 'payment_intent.payment_failed' });
    assertEqual(result.outcome, 'PAYMENT_FAILED', 'outcome');
    assert(result.registrationId != null, 'registrationId set');

    const rows = await testSql.unsafe(`SELECT status FROM registrations WHERE payment_intent_id = '${piId}'`);
    assertEqual(rows[0].status, 'PAYMENT_FAILED', 'DB status');
  });

  await test('7-2: idempotent replay on already-failed', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });

    const piId = 'pi_fail_test_02';
    await testSql.unsafe(`
      SELECT * FROM sp_initiate_registration(
        '${TEST_EVENT_ID}'::UUID,
        'fail2@example.com', 'Fail', 'User', NULL, '{}'::JSONB, 10000, '${piId}'
      )
    `);

    const stripe = new MockStripeClient();
    const svc = new RegistrationService(stripe as any, new NoopNotificationService() as any);

    await svc.handlePaymentFailed(piId, {});
    const result2 = await svc.handlePaymentFailed(piId, {});
    assertEqual(result2.outcome, 'IDEMPOTENT_REPLAY', 'outcome');
  });

  await testSql.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
