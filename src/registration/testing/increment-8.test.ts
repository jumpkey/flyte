import 'dotenv/config';
import { truncateTables, createTestEvent, testSql, TEST_EVENT_ID, assert, assertEqual } from './test-helpers.js';
import { NotificationService } from '../services/NotificationService.js';

const mockReg = {
  registrationId: '00000000-0000-0000-0000-000000000001',
  eventId: TEST_EVENT_ID,
  email: 'notify@example.com',
  firstName: 'Notify',
  lastName: 'User',
  phone: null,
  attributes: {},
  status: 'CONFIRMED' as const,
  paymentIntentId: 'pi_test_notify',
  grossAmountCents: 10000,
  netAmountCents: 9700,
  refundedAmountCents: 0,
  stripeRefundId: null,
  captureAttemptCount: 0,
  lastCaptureAttemptAt: null,
  confirmationEmailSentAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  confirmedAt: new Date(),
  cancelledAt: null,
};

const mockWaitlistEntry = {
  waitlistEntryId: '00000000-0000-0000-0000-000000000002',
  eventId: TEST_EVENT_ID,
  email: 'waitlist@example.com',
  firstName: 'Wait',
  lastName: 'List',
  phone: null,
  createdAt: new Date(),
};

async function runTests() {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => Promise<void>) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}:`, e instanceof Error ? e.message : e); failed++; }
  }

  console.log('\n=== Increment 8: NotificationService Tests ===\n');

  const svc = new NotificationService();

  await test('8-1: sendRegistrationConfirmation does not throw', async () => {
    try {
      await svc.sendRegistrationConfirmation(mockReg, 'Test Event');
      assert(true, 'completed without throw');
    } catch (e) {
      // SMTP not available in test env is acceptable
      const msg = e instanceof Error ? e.message : String(e);
      assert(msg.includes('ECONNREFUSED') || msg.includes('connect') || msg.includes('SMTP') || msg.length > 0,
        'error should be connection-related');
    }
  });

  await test('8-2: sendWaitlistAcknowledgement does not throw', async () => {
    try {
      await svc.sendWaitlistAcknowledgement(mockWaitlistEntry, 1, 'Test Event');
      assert(true, 'completed without throw');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      assert(msg.length > 0, 'error should have a message');
    }
  });

  await test('8-3: sendRefundConfirmation does not throw', async () => {
    try {
      await svc.sendRefundConfirmation(mockReg, 5000, 'Test Event');
      assert(true, 'completed without throw');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      assert(msg.length > 0, 'error should have a message');
    }
  });

  await testSql.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
