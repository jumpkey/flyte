import 'dotenv/config';
import Stripe from 'stripe';
import { truncateTables, createTestEvent, testSql, TEST_EVENT_ID, assert, assertEqual } from './test-helpers.js';
import { RegistrationService } from '../services/RegistrationService.js';
import { ReconciliationService } from '../services/ReconciliationService.js';
import { MockStripeClient } from './MockStripeClient.js';

class NoopNotifications {
  async sendRegistrationConfirmation() {}
  async sendWaitlistAcknowledgement() {}
  async sendRefundConfirmation() {}
}

async function run() {
  let passed = 0;
  let failed = 0;
  const test = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}:`, err); failed++; }
  };

  await test('same-email retry preserves the durable pending attempt without exposing its client secret', async () => {
    await truncateTables();
    await createTestEvent();
    const stripe = new MockStripeClient();
    const pi = await stripe.paymentIntents.create({ amount: 10000, currency: 'usd', capture_method: 'manual' });
    const piId = String(pi.id);
    await testSql`INSERT INTO registrations(event_id,email,first_name,last_name,gross_amount_cents,payment_intent_id,status)
      VALUES (${TEST_EVENT_ID},'retry@example.com','Retry','Buyer',10000,${piId},'PENDING_PAYMENT')`;
    const service = new RegistrationService(stripe as any, new NoopNotifications() as any);
    const first = await service.initiateRegistration({ eventId: TEST_EVENT_ID, email: 'retry@example.com', firstName: 'Retry', lastName: 'Buyer', grossAmountCents: 10000 });
    assertEqual(first.outcome, 'ALREADY_REGISTERED', 'retry does not start a second checkout');
    assertEqual(first.paymentIntentId, undefined, 'guest email alone cannot disclose the intent');
    stripe.assertNotCalled('paymentIntents.cancel');
    stripe.assertNotCalled('paymentIntents.retrieve');
    const liveIntent = await stripe.paymentIntents.retrieve(piId);
    assertEqual(liveIntent.status, 'requires_payment_method', 'the original intent remains usable');
    const count = await testSql`SELECT count(*)::int AS count FROM registrations WHERE event_id=${TEST_EVENT_ID} AND email='retry@example.com'`;
    assertEqual(count[0].count, 1, 'only one registration exists');
  });

  await test('free registration confirms atomically without creating a Stripe intent', async () => {
    await truncateTables();
    await createTestEvent({ registrationFeeCents: 0, totalCapacity: 3 });
    const stripe = new MockStripeClient();
    const service = new RegistrationService(stripe as any, new NoopNotifications() as any);
    const result = await service.initiateRegistration({ eventId: TEST_EVENT_ID, email: 'free@example.com', firstName: 'Free', lastName: 'Guest', grossAmountCents: 0 });
    assertEqual(result.outcome, 'SUCCESS', 'free registration succeeds');
    assert(!result.paymentIntentId && !result.stripeClientSecret, 'free path has no processor intent');
    stripe.assertNotCalled('paymentIntents.create');
    const rows = await testSql`SELECT r.status, r.net_amount_cents, e.available_slots FROM registrations r JOIN events e USING(event_id) WHERE r.registration_id=${result.registrationId!}::UUID`;
    assertEqual(rows[0].status, 'CONFIRMED', 'free registration is confirmed');
    assertEqual(rows[0].net_amount_cents, 0, 'free registration has zero net');
    assertEqual(rows[0].available_slots, 2, 'one slot is reserved');
  });

  await test('closed and past events are rejected by service and SQL initiation gates', async () => {
    await truncateTables();
    await createTestEvent();
    const stripe = new MockStripeClient();
    const service = new RegistrationService(stripe as any, new NoopNotifications() as any);
    await testSql`UPDATE events SET status='CLOSED' WHERE event_id=${TEST_EVENT_ID}`;
    const closed = await service.initiateRegistration({ eventId: TEST_EVENT_ID, email: 'closed@example.com', firstName: 'Closed', lastName: 'Buyer', grossAmountCents: 10000 });
    assertEqual(closed.outcome, 'INVALID_STATE', 'closed event rejected');
    stripe.assertNotCalled('paymentIntents.create');
    const closedSql = await testSql`SELECT result_code FROM sp_initiate_registration(${TEST_EVENT_ID}::UUID,'direct@example.com','Direct','Buyer',NULL,'{}'::JSONB,10000,'pi_closed_direct')`;
    assertEqual(closedSql[0].result_code, 'EVENT_CLOSED', 'SQL rejects direct call');
    await testSql`UPDATE events SET status='OPEN', event_date=now()-interval '1 minute' WHERE event_id=${TEST_EVENT_ID}`;
    const pastSql = await testSql`SELECT result_code FROM sp_initiate_registration(${TEST_EVENT_ID}::UUID,'past@example.com','Past','Buyer',NULL,'{}'::JSONB,10000,'pi_past_direct')`;
    assertEqual(pastSql[0].result_code, 'EVENT_CLOSED', 'past event rejected by SQL');
  });

  await test('capture response loss with the Stripe SDK connection error finalizes the succeeded intent', async () => {
    await truncateTables();
    await createTestEvent({ totalCapacity: 2 });
    const stripe = new MockStripeClient();
    const service = new RegistrationService(stripe as any, new NoopNotifications() as any);
    const init = await service.initiateRegistration({ eventId: TEST_EVENT_ID, email: 'lost-response@example.com', firstName: 'Lost', lastName: 'Response', grossAmountCents: 10000 });
    let state = 'requires_capture';
    stripe.paymentIntents.retrieve = async (id: string) => ({ id, status: state as any, latest_charge: { amount_captured: 9850 }, amount_received: 9850 });
    stripe.paymentIntents.capture = async () => {
      state = 'succeeded';
      const err = Object.create(Stripe.errors.StripeConnectionError.prototype);
      err.message = 'response lost after capture';
      throw err;
    };
    const result = await service.handlePaymentAuthorized(init.paymentIntentId!, 10000);
    assertEqual(result.outcome, 'SUCCESS', 'succeeded processor state is finalized');
    const rows = await testSql`SELECT status, net_amount_cents FROM registrations WHERE registration_id=${init.registrationId!}::UUID`;
    assertEqual(rows[0].status, 'CONFIRMED', 'registration is confirmed');
    assertEqual(rows[0].net_amount_cents, 9850, 'processor captured amount is recorded');
    const event = await testSql`SELECT confirmed_count, available_slots FROM events WHERE event_id=${TEST_EVENT_ID}`;
    assertEqual(event[0].confirmed_count, 1, 'one capacity slot remains held');
    assertEqual(event[0].available_slots, 1, 'capacity was decremented once');
  });

  await test('database finalization failure keeps the paid reservation pending and retryable', async () => {
    await truncateTables();
    await createTestEvent({ totalCapacity: 2 });
    const stripe = new MockStripeClient();
    const service = new RegistrationService(stripe as any, new NoopNotifications() as any);
    const init = await service.initiateRegistration({ eventId: TEST_EVENT_ID, email: 'db-failure@example.com', firstName: 'DB', lastName: 'Failure', grossAmountCents: 10000 });
    await testSql.unsafe(`CREATE FUNCTION fail_registration_finalization() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='CONFIRMED' AND OLD.status='PENDING_CAPTURE' THEN RAISE EXCEPTION 'injected finalization failure'; END IF; RETURN NEW; END $$`);
    await testSql.unsafe(`CREATE TRIGGER fail_registration_finalization BEFORE UPDATE ON registrations FOR EACH ROW EXECUTE FUNCTION fail_registration_finalization()`);
    try {
      const first = await service.handlePaymentAuthorized(init.paymentIntentId!, 10000);
      assertEqual(first.outcome, 'CAPTURE_FAILED', 'database failure is reported as pending');
      const pending = await testSql`SELECT status FROM registrations WHERE registration_id=${init.registrationId!}::UUID`;
      assertEqual(pending[0].status, 'PENDING_CAPTURE', 'registration does not become failed');
      const capacity = await testSql`SELECT confirmed_count, available_slots FROM events WHERE event_id=${TEST_EVENT_ID}`;
      assertEqual(capacity[0].confirmed_count, 1, 'slot remains reserved');
      assertEqual(capacity[0].available_slots, 1, 'slot is not released while charge state is known');
    } finally {
      await testSql.unsafe('DROP TRIGGER IF EXISTS fail_registration_finalization ON registrations');
      await testSql.unsafe('DROP FUNCTION IF EXISTS fail_registration_finalization()');
    }
    const retry = await service.handlePaymentAuthorized(init.paymentIntentId!, 10000, true);
    assertEqual(retry.outcome, 'SUCCESS', 'known captured intent can be finalized on retry');
    const confirmed = await testSql`SELECT status FROM registrations WHERE registration_id=${init.registrationId!}::UUID`;
    assertEqual(confirmed[0].status, 'CONFIRMED', 'retry completes registration');
  });

  await test('reconciliation finalizes an already-succeeded capture without capturing again', async () => {
    await truncateTables();
    await createTestEvent({ totalCapacity: 2, availableSlots: 1, confirmedCount: 1 });
    const piId = 'pi_reconcile_succeeded';
    const rows = await testSql`INSERT INTO registrations(event_id,email,first_name,last_name,gross_amount_cents,payment_intent_id,status)
      VALUES (${TEST_EVENT_ID},'reconcile@example.com','Reconcile','Guest',10000,${piId},'PENDING_CAPTURE') RETURNING registration_id`;
    const stripe = new MockStripeClient({ retrieveStatus: 'succeeded', retrieveNetAmountCents: 9800 });
    const notifications = new NoopNotifications();
    const service = new RegistrationService(stripe as any, notifications as any);
    const reconciliation = new ReconciliationService(stripe as any, service, notifications as any, { captureMaxRetries: 5 });
    const result = await reconciliation.reconcilePendingRegistrations(0);
    assert(result.webhookRecoveredCount >= 1, 'succeeded PI is recovered');
    stripe.assertNotCalled('paymentIntents.capture');
    const reg = await testSql`SELECT status, net_amount_cents FROM registrations WHERE registration_id=${rows[0].registration_id}`;
    assertEqual(reg[0].status, 'CONFIRMED', 'registration finalized');
    assertEqual(reg[0].net_amount_cents, 9800, 'actual captured amount recorded');
    const event = await testSql`SELECT confirmed_count, available_slots FROM events WHERE event_id=${TEST_EVENT_ID}`;
    assertEqual(event[0].confirmed_count, 1, 'existing reserved slot counted once');
    assertEqual(event[0].available_slots, 1, 'no capacity released');
  });

  await testSql.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run().catch((err) => { console.error(err); process.exit(1); });
