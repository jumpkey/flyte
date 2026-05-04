import 'dotenv/config';
import { truncateTables, createTestEvent, testSql, TEST_EVENT_ID, assert, assertEqual } from './test-helpers.js';
import { RegistrationService } from '../services/RegistrationService.js';
import { MockStripeClient } from './MockStripeClient.js';

class NoopNotificationService {
  async sendRegistrationConfirmation() {}
  async sendWaitlistAcknowledgement() {}
  async sendRefundConfirmation() {}
}

async function createPendingPaymentReg(piId: string, email?: string): Promise<string> {
  const rows = await testSql.unsafe(`
    SELECT * FROM sp_initiate_registration(
      '${TEST_EVENT_ID}'::UUID,
      '${email ?? `user_${piId}@example.com`}',
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

  console.log('\n=== Increment 6: Webhook and Client-Confirm Tests ===\n');

  await test('6-1: handleAuthorizationWebhook delegates correctly', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });
    const piId = 'pi_wh_test_01';
    await createPendingPaymentReg(piId);

    const stripe = new MockStripeClient();
    const svc = new RegistrationService(stripe as any, new NoopNotificationService() as any);

    const result = await svc.handleAuthorizationWebhook(piId, { type: 'payment_intent.amount_capturable_updated' });
    assertEqual(result.outcome, 'SUCCESS', 'outcome');
  });

  await test('6-2: confirmRegistrationFromClient verifies PI status', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });
    const piId = 'pi_client_test_01';
    await createPendingPaymentReg(piId);

    const stripe = new MockStripeClient({ retrieveStatus: 'requires_capture', retrieveNetAmountCents: 10000 });
    const svc = new RegistrationService(stripe as any, new NoopNotificationService() as any);

    const result = await svc.confirmRegistrationFromClient(piId);
    assertEqual(result.outcome, 'SUCCESS', 'outcome');
    stripe.assertCalled('paymentIntents.retrieve');
  });

  await test('6-3: confirmRegistrationFromClient rejects non-requires_capture status', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });
    const piId = 'pi_client_test_02';
    await createPendingPaymentReg(piId);

    const stripe = new MockStripeClient({ retrieveStatus: 'requires_payment_method' });
    const svc = new RegistrationService(stripe as any, new NoopNotificationService() as any);

    const result = await svc.confirmRegistrationFromClient(piId);
    assertEqual(result.outcome, 'PAYMENT_FAILED', 'outcome');
  });

  await test('6-4: handleAuthorizationWebhook is idempotent', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });
    const piId = 'pi_wh_test_04';
    await createPendingPaymentReg(piId);

    const stripe = new MockStripeClient();
    const svc = new RegistrationService(stripe as any, new NoopNotificationService() as any);

    const r1 = await svc.handleAuthorizationWebhook(piId, {});
    assertEqual(r1.outcome, 'SUCCESS', 'first call outcome');

    const r2 = await svc.handleAuthorizationWebhook(piId, {});
    assert(['IDEMPOTENT_REPLAY', 'SUCCESS'].includes(r2.outcome), `Expected idempotent, got ${r2.outcome}`);
  });

  await testSql.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
