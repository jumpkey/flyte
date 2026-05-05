import 'dotenv/config';
import { truncateTables, createTestEvent, testSql, TEST_EVENT_ID, assert, assertEqual } from './test-helpers.js';
import { ReconciliationService } from '../services/ReconciliationService.js';
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

  console.log('\n=== Increment 11: ReconciliationService Tests ===\n');

  await test('11-1: expires old PENDING_PAYMENT registrations', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });

    // Insert an old PENDING_PAYMENT registration
    await testSql.unsafe(`
      INSERT INTO registrations (event_id, email, first_name, last_name, gross_amount_cents, payment_intent_id, status, created_at)
      VALUES ('${TEST_EVENT_ID}', 'old@example.com', 'Old', 'Reg', 10000, 'pi_old_pending_01',
              'PENDING_PAYMENT', now() - interval '35 minutes')
    `);

    const stripe = new MockStripeClient({ retrieveStatus: 'requires_payment_method' });
    const notif = new NoopNotificationService();
    const regSvc = new RegistrationService(stripe as any, notif as any);
    const svc = new ReconciliationService(stripe as any, regSvc, notif as any, { captureMaxRetries: 5 });

    const result = await svc.reconcilePendingRegistrations(30);
    assert(result.expiredCount >= 1, `Expected at least 1 expired, got ${result.expiredCount}`);
    assert(result.expiredRegistrationIds.length >= 1, 'expiredRegistrationIds populated');

    const rows = await testSql.unsafe(`SELECT status FROM registrations WHERE payment_intent_id = 'pi_old_pending_01'`);
    assertEqual(rows[0].status, 'EXPIRED', 'status should be EXPIRED');
  });

  await test('11-2: recovers missed webhook (requires_capture)', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });

    await testSql.unsafe(`
      INSERT INTO registrations (event_id, email, first_name, last_name, gross_amount_cents, payment_intent_id, status, created_at)
      VALUES ('${TEST_EVENT_ID}', 'recover@example.com', 'Rec', 'Over', 10000, 'pi_recover_01',
              'PENDING_PAYMENT', now() - interval '35 minutes')
    `);

    const stripe = new MockStripeClient({ retrieveStatus: 'requires_capture' });
    const notif = new NoopNotificationService();
    const regSvc = new RegistrationService(stripe as any, notif as any);
    const svc = new ReconciliationService(stripe as any, regSvc, notif as any, { captureMaxRetries: 5 });

    const result = await svc.reconcilePendingRegistrations(30);
    assert(result.webhookRecoveredCount >= 1, `Expected webhook recovery, got ${result.webhookRecoveredCount}`);
  });

  await test('11-3: retries PENDING_CAPTURE registrations', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });

    // Create registration in PENDING_CAPTURE
    await testSql.unsafe(`
      INSERT INTO registrations (event_id, email, first_name, last_name, gross_amount_cents,
                                  payment_intent_id, status, capture_attempt_count)
      VALUES ('${TEST_EVENT_ID}', 'capture@example.com', 'Cap', 'Ture', 10000,
              'pi_capture_01', 'PENDING_CAPTURE', 0)
    `);
    await testSql.unsafe(`
      UPDATE events SET available_slots = available_slots - 1, confirmed_count = confirmed_count + 1
      WHERE event_id = '${TEST_EVENT_ID}'
    `);

    const stripe = new MockStripeClient({ captureNetAmountCents: 9700 });
    const notif = new NoopNotificationService();
    const regSvc = new RegistrationService(stripe as any, notif as any);
    const svc = new ReconciliationService(stripe as any, regSvc, notif as any, { captureMaxRetries: 5 });

    const result = await svc.reconcilePendingRegistrations(30);
    assert(result.captureRetriedCount >= 1, `Expected capture retry, got ${result.captureRetriedCount}`);
  });

  await test('11-4: restores slot when max retries exceeded', async () => {
    await truncateTables();
    await createTestEvent({ totalCapacity: 5, availableSlots: 4, confirmedCount: 1, registrationFeeCents: 10000 });

    await testSql.unsafe(`
      INSERT INTO registrations (event_id, email, first_name, last_name, gross_amount_cents,
                                  payment_intent_id, status, capture_attempt_count)
      VALUES ('${TEST_EVENT_ID}', 'maxretry@example.com', 'Max', 'Retry', 10000,
              'pi_maxretry_01', 'PENDING_CAPTURE', 5)
    `);

    const stripe = new MockStripeClient();
    const notif = new NoopNotificationService();
    const regSvc = new RegistrationService(stripe as any, notif as any);
    const svc = new ReconciliationService(stripe as any, regSvc, notif as any, { captureMaxRetries: 5 });

    const result = await svc.reconcilePendingRegistrations(30);
    assert(result.captureRestoredCount >= 1, `Expected slot restore, got ${result.captureRestoredCount}`);

    const rows = await testSql.unsafe(`SELECT status FROM registrations WHERE payment_intent_id = 'pi_maxretry_01'`);
    assertEqual(rows[0].status, 'PAYMENT_FAILED', 'status should be PAYMENT_FAILED');
  });

  await test('11-5: does not expire recent PENDING_PAYMENT', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });

    await testSql.unsafe(`
      INSERT INTO registrations (event_id, email, first_name, last_name, gross_amount_cents, payment_intent_id, status, created_at)
      VALUES ('${TEST_EVENT_ID}', 'recent@example.com', 'Recent', 'Reg', 10000, 'pi_recent_01',
              'PENDING_PAYMENT', now() - interval '5 minutes')
    `);

    const stripe = new MockStripeClient({ retrieveStatus: 'requires_payment_method' });
    const notif = new NoopNotificationService();
    const regSvc = new RegistrationService(stripe as any, notif as any);
    const svc = new ReconciliationService(stripe as any, regSvc, notif as any, { captureMaxRetries: 5 });

    const result = await svc.reconcilePendingRegistrations(30);
    assertEqual(result.expiredCount, 0, 'should not expire recent registrations');
  });

  await test('11-6: resends confirmation emails for CONFIRMED without email sent', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });

    await testSql.unsafe(`
      INSERT INTO registrations (event_id, email, first_name, last_name, gross_amount_cents,
                                  payment_intent_id, status, confirmed_at, net_amount_cents)
      VALUES ('${TEST_EVENT_ID}', 'noemail@example.com', 'No', 'Email', 10000,
              'pi_noemail_01', 'CONFIRMED', now(), 9700)
    `);
    await testSql.unsafe(`
      UPDATE events SET available_slots = available_slots - 1, confirmed_count = confirmed_count + 1
      WHERE event_id = '${TEST_EVENT_ID}'
    `);

    const stripe = new MockStripeClient();
    const notif = new NoopNotificationService();
    const regSvc = new RegistrationService(stripe as any, notif as any);
    const svc = new ReconciliationService(stripe as any, regSvc, notif as any, { captureMaxRetries: 5 });

    const result = await svc.reconcilePendingRegistrations(30);
    assert(result.emailResentCount >= 1, `Expected email resent, got ${result.emailResentCount}`);
  });

  await test('11-7: result has correct shape', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });

    const stripe = new MockStripeClient();
    const notif = new NoopNotificationService();
    const regSvc = new RegistrationService(stripe as any, notif as any);
    const svc = new ReconciliationService(stripe as any, regSvc, notif as any, { captureMaxRetries: 5 });

    const result = await svc.reconcilePendingRegistrations(30);
    assert('expiredCount' in result, 'expiredCount');
    assert('captureRetriedCount' in result, 'captureRetriedCount');
    assert('captureRestoredCount' in result, 'captureRestoredCount');
    assert('webhookRecoveredCount' in result, 'webhookRecoveredCount');
    assert('emailResentCount' in result, 'emailResentCount');
    assert('errorCount' in result, 'errorCount');
    assert(Array.isArray(result.expiredRegistrationIds), 'expiredRegistrationIds is array');
    assert(Array.isArray(result.restoredRegistrationIds), 'restoredRegistrationIds is array');
  });

  await test('11-8: empty DB produces all zeros', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 10000 });

    const stripe = new MockStripeClient();
    const notif = new NoopNotificationService();
    const regSvc = new RegistrationService(stripe as any, notif as any);
    const svc = new ReconciliationService(stripe as any, regSvc, notif as any, { captureMaxRetries: 5 });

    const result = await svc.reconcilePendingRegistrations(30);
    assertEqual(result.expiredCount, 0, 'expiredCount');
    assertEqual(result.errorCount, 0, 'errorCount');
  });

  await testSql.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
