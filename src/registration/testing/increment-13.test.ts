import 'dotenv/config';
import { truncateTables, createTestEvent, testSql, TEST_EVENT_ID, assert, assertEqual } from './test-helpers.js';
import { RegistrationService } from '../services/RegistrationService.js';
import { RefundService } from '../services/RefundService.js';
import { WaitlistService } from '../services/WaitlistService.js';
import { EventAvailabilityService } from '../services/EventAvailabilityService.js';
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

  console.log('\n=== Increment 13: E2E Integration Test ===\n');

  await truncateTables();
  await createTestEvent({ totalCapacity: 3, registrationFeeCents: 10000 });

  const stripe = new MockStripeClient({ captureNetAmountCents: 9700 });
  const notif = new NoopNotificationService();
  const regSvc = new RegistrationService(stripe as any, notif as any);
  const refundSvc = new RefundService(stripe as any, notif as any);
  const waitlistSvc = new WaitlistService();
  const availSvc = new EventAvailabilityService();

  let registrationId1: string;
  let registrationId2: string;
  let registrationId3: string;

  await test('E2E-1: initiate and confirm registration for user 1', async () => {
    const initResult = await regSvc.initiateRegistration({
      eventId: TEST_EVENT_ID,
      email: 'e2e1@example.com',
      firstName: 'E2E',
      lastName: 'One',
      grossAmountCents: 10000,
    });
    assertEqual(initResult.outcome, 'SUCCESS', 'initiate outcome');
    registrationId1 = initResult.registrationId!;

    const authResult = await regSvc.handlePaymentAuthorized(initResult.paymentIntentId!, 10000);
    assertEqual(authResult.outcome, 'SUCCESS', 'auth outcome');
  });

  await test('E2E-2: availability decrements after confirmation', async () => {
    const avail = await availSvc.getAvailability(TEST_EVENT_ID);
    assertEqual(avail!.availableSlots, 2, 'availableSlots after 1 confirmed');
    assertEqual(avail!.confirmedCount, 1, 'confirmedCount');
  });

  await test('E2E-3: initiate and confirm registration for user 2', async () => {
    const initResult = await regSvc.initiateRegistration({
      eventId: TEST_EVENT_ID,
      email: 'e2e2@example.com',
      firstName: 'E2E',
      lastName: 'Two',
      grossAmountCents: 10000,
    });
    registrationId2 = initResult.registrationId!;
    await regSvc.handlePaymentAuthorized(initResult.paymentIntentId!, 10000);
  });

  await test('E2E-4: initiate and confirm registration for user 3 (fills event)', async () => {
    const initResult = await regSvc.initiateRegistration({
      eventId: TEST_EVENT_ID,
      email: 'e2e3@example.com',
      firstName: 'E2E',
      lastName: 'Three',
      grossAmountCents: 10000,
    });
    registrationId3 = initResult.registrationId!;
    await regSvc.handlePaymentAuthorized(initResult.paymentIntentId!, 10000);

    const avail = await availSvc.getAvailability(TEST_EVENT_ID);
    assertEqual(avail!.availableSlots, 0, 'event should be full');
    assertEqual(avail!.status, 'FULL', 'event status should be FULL');
  });

  await test('E2E-5: fourth user joins waitlist', async () => {
    const entry = await waitlistSvc.addToWaitlist({
      eventId: TEST_EVENT_ID,
      email: 'e2e4@example.com',
      firstName: 'E2E',
      lastName: 'Four',
    });
    assert(entry.waitlistEntryId != null, 'waitlist entry created');

    const pos = await waitlistSvc.getWaitlistPosition(TEST_EVENT_ID, 'e2e4@example.com');
    assertEqual(pos, 1, 'position should be 1');
  });

  await test('E2E-6: duplicate registration is rejected', async () => {
    const result = await regSvc.initiateRegistration({
      eventId: TEST_EVENT_ID,
      email: 'e2e1@example.com',
      firstName: 'E2E',
      lastName: 'One',
      grossAmountCents: 10000,
    });
    assertEqual(result.outcome, 'ALREADY_REGISTERED', 'duplicate should be rejected');
  });

  await test('E2E-7: full refund cancels registration and restores slot', async () => {
    const refundResult = await refundSvc.refundRegistration({
      registrationId: registrationId1,
      refundType: 'FULL',
      reason: 'e2e test refund',
    });
    assertEqual(refundResult.outcome, 'REFUND_ISSUED', 'refund outcome');

    const avail = await availSvc.getAvailability(TEST_EVENT_ID);
    assertEqual(avail!.availableSlots, 1, 'slot restored after refund');
    assertEqual(avail!.confirmedCount, 2, 'confirmedCount decremented');
  });

  await test('E2E-8: getConfirmedRegistrations returns correct count', async () => {
    const confirmed = await regSvc.getConfirmedRegistrations(TEST_EVENT_ID);
    assertEqual(confirmed.length, 2, 'should have 2 confirmed registrations');
    assert(confirmed.every(r => r.status === 'CONFIRMED'), 'all should be CONFIRMED');
  });

  await test('E2E-9: getRegistration returns correct record', async () => {
    const reg = await regSvc.getRegistration(registrationId2);
    assert(reg !== null, 'should find registration');
    assertEqual(reg!.email, 'e2e2@example.com', 'email');
    assertEqual(reg!.status, 'CONFIRMED', 'status');
    assertEqual(reg!.netAmountCents, 9700, 'netAmountCents');
  });

  await testSql.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
