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

  console.log('\n=== Increment 4: RegistrationService.initiateRegistration Tests ===\n');

  await test('4-1: happy path creates PI and registration', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });

    const stripe = new MockStripeClient();
    const svc = new RegistrationService(stripe as any, new NoopNotificationService() as any);

    const result = await svc.initiateRegistration({
      eventId: TEST_EVENT_ID,
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      grossAmountCents: 10000,
    });

    assertEqual(result.outcome, 'SUCCESS', 'outcome');
    assert(result.registrationId != null, 'registrationId set');
    assert(result.stripeClientSecret != null, 'stripeClientSecret set');
    assert(result.paymentIntentId != null, 'paymentIntentId set');
    stripe.assertCalled('paymentIntents.create');
  });

  await test('4-2: duplicate registration returns ALREADY_REGISTERED', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });

    const stripe = new MockStripeClient();
    const svc = new RegistrationService(stripe as any, new NoopNotificationService() as any);

    await svc.initiateRegistration({
      eventId: TEST_EVENT_ID,
      email: 'dup@example.com',
      firstName: 'Dup',
      lastName: 'User',
      grossAmountCents: 10000,
    });

    stripe.reset();
    const result = await svc.initiateRegistration({
      eventId: TEST_EVENT_ID,
      email: 'dup@example.com',
      firstName: 'Dup',
      lastName: 'User',
      grossAmountCents: 10000,
    });

    assertEqual(result.outcome, 'ALREADY_REGISTERED', 'outcome');
    stripe.assertCalled('paymentIntents.cancel');
  });

  await test('4-3: event not found returns NOT_FOUND', async () => {
    await truncateTables();
    const stripe = new MockStripeClient();
    const svc = new RegistrationService(stripe as any, new NoopNotificationService() as any);

    const result = await svc.initiateRegistration({
      eventId: '00000000-0000-0000-0000-000000000099',
      email: 'x@example.com',
      firstName: 'X',
      lastName: 'Y',
      grossAmountCents: 10000,
    });

    assertEqual(result.outcome, 'NOT_FOUND', 'outcome');
  });

  await test('4-4: Stripe timeout returns STRIPE_TIMEOUT', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });

    const stripe = new MockStripeClient({ createShouldTimeout: true, createDelayMs: 1 });
    const svc = new RegistrationService(stripe as any, new NoopNotificationService() as any);

    const result = await svc.initiateRegistration({
      eventId: TEST_EVENT_ID,
      email: 'timeout@example.com',
      firstName: 'T',
      lastName: 'O',
      grossAmountCents: 10000,
    });

    assertEqual(result.outcome, 'STRIPE_TIMEOUT', 'outcome');
  });

  await test('4-5: Stripe error returns STRIPE_ERROR', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });

    const stripe = new MockStripeClient({ createShouldError: true });
    const svc = new RegistrationService(stripe as any, new NoopNotificationService() as any);

    const result = await svc.initiateRegistration({
      eventId: TEST_EVENT_ID,
      email: 'error@example.com',
      firstName: 'E',
      lastName: 'R',
      grossAmountCents: 10000,
    });

    assertEqual(result.outcome, 'STRIPE_ERROR', 'outcome');
  });

  await testSql.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
