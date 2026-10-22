import 'dotenv/config';
import crypto from 'node:crypto';
import Stripe from 'stripe';
import { config } from '../src/config.js';
import { sql } from '../src/services/db.js';
import { getStripe } from '../src/registration/stripe-factory.js';
import { RegistrationService } from '../src/registration/services/RegistrationService.js';
import { RefundService } from '../src/registration/services/RefundService.js';
import type { INotificationService } from '../src/registration/interfaces.js';
import type { RegistrationId } from '../src/registration/types.js';

class SmokeCheckError extends Error {}

function requireCheck(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SmokeCheckError(`Smoke check failed: ${message}`);
}

function noOpNotifications(): INotificationService {
  return {
    async sendRegistrationConfirmation() {},
    async sendWaitlistAcknowledgement() {},
    async sendRefundConfirmation() {},
  };
}

async function main(): Promise<void> {
  requireCheck(process.env['FLYTE_TESTBED_SMOKE'] === 'YES', 'set FLYTE_TESTBED_SMOKE=YES to acknowledge testbed writes');
  requireCheck(process.env['DATABASE_URL'], 'DATABASE_URL must be explicitly configured');
  requireCheck(config.stripe.secretKey.startsWith('sk_test_'), 'a Stripe test secret key (sk_test_) is required');
  requireCheck(!process.env['STRIPE_SIMULATOR_HOST'], 'Stripe simulator redirects are not allowed for this smoke');
  requireCheck(process.env['SMOKE_TEST_WEBHOOK'] !== '1' || Boolean(config.stripe.webhookSecret),
    'SMOKE_TEST_WEBHOOK=1 requires STRIPE_WEBHOOK_SECRET');

  const database = await sql<{ name: string }[]>`SELECT current_database() AS name`;
  requireCheck(database[0]?.name === 'flyte', 'DATABASE_URL must point to the flyte testbed database');

  const runId = crypto.randomUUID();
  const events: string[] = [];
  const registrations: RegistrationId[] = [];
  const stripe = new Stripe(config.stripe.secretKey, {
    apiVersion: '2026-04-22.dahlia' as const,
    timeout: config.stripe.apiTimeoutMs,
  });
  const adapter = await getStripe();
  const notifications = noOpNotifications();
  const registrationsService = new RegistrationService(adapter, notifications);
  const refundsService = new RefundService(adapter, notifications);

  const createEvent = async (name: string, status: 'DRAFT' | 'OPEN'): Promise<string> => {
    const rows = await sql<{ event_id: string }[]>`
      INSERT INTO events (name, event_date, total_capacity, confirmed_count, available_slots,
        registration_fee_cents, status)
      VALUES (${name}, now() + interval '30 days', 5, 0, 5, 1200, ${status})
      RETURNING event_id
    `;
    events.push(rows[0].event_id);
    return rows[0].event_id;
  };

  const register = async (eventId: string, label: string) => {
    const result = await registrationsService.initiateRegistration({
      eventId,
      email: `smoke-${runId}-${label}@example.invalid`,
      firstName: 'Stabilization',
      lastName: label,
      grossAmountCents: 1200,
    });
    requireCheck(result.outcome === 'SUCCESS' && result.registrationId && result.paymentIntentId,
      `create payment registration (${label}), got ${result.outcome}`);
    registrations.push(result.registrationId);
    return { registrationId: result.registrationId, paymentIntentId: result.paymentIntentId };
  };

  try {
    const draftEvent = await createEvent(`Stabilization ${runId} lifecycle`, 'DRAFT');
    const rejected = await registrationsService.initiateRegistration({
      eventId: draftEvent,
      email: `smoke-${runId}-draft@example.invalid`,
      firstName: 'Stabilization',
      lastName: 'Draft',
      grossAmountCents: 1200,
    });
    requireCheck(rejected.outcome === 'INVALID_STATE', `draft lifecycle rejection, got ${rejected.outcome}`);

    const partialEvent = await createEvent(`Stabilization ${runId} partial refund`, 'OPEN');
    const partialCase = await register(partialEvent, 'partial');
    const partialAuthorization = await stripe.paymentIntents.confirm(partialCase.paymentIntentId, {
      payment_method: 'pm_card_visa',
    });
    requireCheck(partialAuthorization.status === 'requires_capture', 'test card authorization is capturable');
    const captured = await registrationsService.confirmRegistrationFromClient(partialCase.paymentIntentId);
    requireCheck(captured.outcome === 'SUCCESS', `capture and confirm, got ${captured.outcome}`);
    const duplicate = await registrationsService.confirmRegistrationFromClient(partialCase.paymentIntentId);
    requireCheck(duplicate.outcome === 'IDEMPOTENT_REPLAY', `duplicate confirmation, got ${duplicate.outcome}`);

    if (process.env['SMOKE_TEST_WEBHOOK'] === '1') {
      const payload = JSON.stringify({
        id: `evt_smoke_${runId.replaceAll('-', '')}`,
        object: 'event',
        api_version: '2026-04-22.dahlia',
        created: Math.floor(Date.now() / 1000),
        type: 'payment_intent.amount_capturable_updated',
        data: { object: { id: partialCase.paymentIntentId, object: 'payment_intent', status: 'succeeded' } },
      });
      const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: config.stripe.webhookSecret });
      const { app } = await import('../src/web/app.js');
      const response = await app.request('http://localhost/webhooks/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': signature },
        body: payload,
      });
      requireCheck(response.status === 200, `locally signed webhook handler returned HTTP ${response.status}`);
    }

    const partial = await refundsService.refundRegistration({
      registrationId: partialCase.registrationId,
      refundType: 'PARTIAL',
      partialAmountCents: 200,
      reason: 'Stabilization test-mode smoke',
      operationId: `stabilization-${runId}-partial`,
    });
    requireCheck(partial.outcome === 'PARTIAL_REFUND_ISSUED', `partial refund, got ${partial.outcome}`);
    const full = await refundsService.refundRegistration({
      registrationId: partialCase.registrationId,
      refundType: 'FULL',
      reason: 'Stabilization test-mode smoke',
      operationId: `stabilization-${runId}-full`,
    });
    requireCheck(full.outcome === 'REFUND_ISSUED', `remaining full refund, got ${full.outcome}`);

    const cancellationEvent = await createEvent(`Stabilization ${runId} event cancellation`, 'OPEN');
    const cancellationCase = await register(cancellationEvent, 'cancel');
    const cancellationAuthorization = await stripe.paymentIntents.confirm(cancellationCase.paymentIntentId, {
      payment_method: 'pm_card_visa',
    });
    requireCheck(cancellationAuthorization.status === 'requires_capture', 'cancellation case authorization is capturable');
    const cancellationCapture = await registrationsService.confirmRegistrationFromClient(cancellationCase.paymentIntentId);
    requireCheck(cancellationCapture.outcome === 'SUCCESS', `cancellation case capture, got ${cancellationCapture.outcome}`);
    const cancelled = await refundsService.refundEvent({
      eventId: cancellationEvent,
      refundType: 'FULL',
      reason: 'Stabilization test-mode event cancellation',
    });
    requireCheck(cancelled.totalFailed === 0 && cancelled.totalSucceeded === 1,
      `event cancellation completed (succeeded ${cancelled.totalSucceeded}, unresolved ${cancelled.totalFailed})`);
    const cancelledState = await sql<{ status: string }[]>`SELECT status FROM events WHERE event_id = ${cancellationEvent}::uuid`;
    requireCheck(cancelledState[0]?.status === 'CANCELLED', 'event reached CANCELLED state');

    // Delete only fixture rows created by this run, and only after all assertions pass.
    await sql.begin(async tx => {
      await tx`DELETE FROM refund_requests WHERE registration_id = ANY(${tx.array(registrations, 2950)})`;
      await tx`DELETE FROM refund_log WHERE registration_id = ANY(${tx.array(registrations, 2950)})`;
      await tx`DELETE FROM registrations WHERE registration_id = ANY(${tx.array(registrations, 2950)})`;
      await tx`DELETE FROM events WHERE event_id = ANY(${tx.array(events, 2950)})`;
    });
    console.log(`Stabilization smoke passed (run ${runId}); database fixtures removed. Stripe test objects remain for inspection.`);
    if (process.env['SMOKE_TEST_WEBHOOK'] === '1') {
      console.log('Local signed webhook handler check passed; this does not verify delivery to the configured public webhook endpoint.');
    }
  } catch (error) {
    console.error(`Stabilization smoke failed (run ${runId}); created fixtures were retained for diagnosis.`);
    throw error;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  if (error instanceof SmokeCheckError) console.error(error.message);
  process.exitCode = 1;
});
