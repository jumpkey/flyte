import crypto from 'crypto';
import { sql } from '../../services/db.js';
import type { StripeClient, IRegistrationService, INotificationService } from '../interfaces.js';
import type {
  RegistrationFormData, RegistrationInitResult, AuthorizationProcessResult,
  RegistrationRecord, PaymentIntentId, RegistrationId, EventId, RegistrationStatus
} from '../types.js';

function isTransientStripeError(err: unknown): boolean {
  const e = err as Record<string, unknown>;
  return (
    e['type'] === 'api_error' ||
    e['code'] === 'rate_limit' ||
    e['code'] === 'api_connection_error'
  );
}

function mapDbRow(row: Record<string, unknown>): RegistrationRecord {
  return {
    registrationId:          row['registration_id'] as string,
    eventId:                 row['event_id'] as string,
    email:                   row['email'] as string,
    firstName:               row['first_name'] as string,
    lastName:                row['last_name'] as string,
    phone:                   row['phone'] as string | null,
    attributes:              (row['attributes'] as Record<string, string>) ?? {},
    status:                  row['status'] as RegistrationStatus,
    paymentIntentId:         row['payment_intent_id'] as string | null,
    grossAmountCents:        row['gross_amount_cents'] as number,
    netAmountCents:          row['net_amount_cents'] as number | null,
    refundedAmountCents:     row['refunded_amount_cents'] as number,
    stripeRefundId:          row['stripe_refund_id'] as string | null,
    captureAttemptCount:     row['capture_attempt_count'] as number,
    lastCaptureAttemptAt:    row['last_capture_attempt_at'] as Date | null,
    confirmationEmailSentAt: row['confirmation_email_sent_at'] as Date | null,
    createdAt:               row['created_at'] as Date,
    updatedAt:               row['updated_at'] as Date,
    confirmedAt:             row['confirmed_at'] as Date | null,
    cancelledAt:             row['cancelled_at'] as Date | null,
  };
}

export class RegistrationService implements IRegistrationService {
  constructor(
    private stripe: StripeClient,
    private notificationService: INotificationService
  ) {}

  async initiateRegistration(formData: RegistrationFormData): Promise<RegistrationInitResult> {
    const eventRows = await sql<Array<{registration_fee_cents: number}>>`
      SELECT registration_fee_cents FROM events WHERE event_id = ${formData.eventId}
    `;
    if (eventRows.length === 0) {
      return { outcome: 'NOT_FOUND', message: 'Event not found' };
    }
    if (eventRows[0].registration_fee_cents !== formData.grossAmountCents) {
      return { outcome: 'INTERNAL_ERROR', message: 'Amount mismatch' };
    }

    let pi: { id: string; client_secret: string };
    try {
      pi = await this.stripe.paymentIntents.create(
        {
          amount: formData.grossAmountCents,
          currency: 'usd',
          capture_method: 'manual',
          metadata: { eventId: formData.eventId, email: formData.email },
          automatic_payment_methods: { enabled: true },
        },
        { idempotencyKey: `pi-create-${crypto.randomUUID()}` }
      );
    } catch (err: unknown) {
      const e = err as Record<string, unknown>;
      const msg = (e['message'] as string | undefined) ?? '';
      if (msg.includes('timeout') || e['code'] === 'api_connection_error') {
        return { outcome: 'STRIPE_TIMEOUT', message: 'Stripe API timed out' };
      }
      return { outcome: 'STRIPE_ERROR', message: 'Stripe API error' };
    }

    const spRows = await sql<Array<{result_code: string; registration_id: string | null}>>`
      SELECT * FROM sp_initiate_registration(
        ${formData.eventId}::UUID,
        ${formData.email},
        ${formData.firstName},
        ${formData.lastName},
        ${formData.phone ?? null},
        ${JSON.stringify(formData.attributes ?? {})}::JSONB,
        ${formData.grossAmountCents},
        ${pi.id}
      )
    `;

    const spResult = spRows[0];

    if (spResult.result_code === 'ALREADY_REGISTERED') {
      try { await this.stripe.paymentIntents.cancel(pi.id); } catch (_) { /* best effort */ }
      return { outcome: 'ALREADY_REGISTERED' };
    }
    if (spResult.result_code === 'EVENT_NOT_FOUND') {
      try { await this.stripe.paymentIntents.cancel(pi.id); } catch (_) { /* best effort */ }
      return { outcome: 'NOT_FOUND' };
    }

    return {
      outcome: 'SUCCESS',
      registrationId: spResult.registration_id!,
      stripeClientSecret: pi.client_secret,
      paymentIntentId: pi.id,
    };
  }

  async handleAuthorizationWebhook(
    paymentIntentId: PaymentIntentId,
    _stripeEventPayload: Record<string, unknown>
  ): Promise<AuthorizationProcessResult> {
    const rows = await sql<Array<{gross_amount_cents: number}>>`
      SELECT gross_amount_cents FROM registrations WHERE payment_intent_id = ${paymentIntentId}
    `;
    if (rows.length === 0) {
      // No registration row for this PI — never default to 0; that would
      // produce a confirmed registration with net_amount_cents = 0.
      return { outcome: 'NOT_FOUND' };
    }
    return this.handlePaymentAuthorized(paymentIntentId, rows[0].gross_amount_cents);
  }

  async confirmRegistrationFromClient(
    paymentIntentId: PaymentIntentId
  ): Promise<AuthorizationProcessResult> {
    let pi: { status: string; latest_charge?: { amount_captured: number } };
    try {
      pi = await this.stripe.paymentIntents.retrieve(paymentIntentId);
    } catch (_) {
      return { outcome: 'INTERNAL_ERROR', message: 'Failed to retrieve payment intent' };
    }

    if (pi.status !== 'requires_capture') {
      return { outcome: 'PAYMENT_FAILED', message: 'Payment not authorized' };
    }

    const rows = await sql<Array<{gross_amount_cents: number}>>`
      SELECT gross_amount_cents FROM registrations WHERE payment_intent_id = ${paymentIntentId}
    `;
    if (rows.length === 0) {
      // pi.latest_charge.amount_captured is null in requires_capture state, so
      // there is no safe fallback. Treat as missing — caller will surface error.
      return { outcome: 'NOT_FOUND' };
    }

    return this.handlePaymentAuthorized(paymentIntentId, rows[0].gross_amount_cents);
  }

  async handlePaymentAuthorized(
    paymentIntentId: PaymentIntentId,
    grossAmountCents: number
  ): Promise<AuthorizationProcessResult> {
    const slotRows = await sql<Array<{
      result_code: string;
      registration_id: string | null;
      event_id: string | null;
      email: string | null;
      first_name: string | null;
      last_name: string | null;
      gross_amount_cents: number | null;
    }>>`
      SELECT * FROM sp_acquire_slot_and_stage_capture(${paymentIntentId})
    `;

    const slotResult = slotRows[0];

    if (slotResult.result_code === 'IDEMPOTENT_REPLAY') {
      return { outcome: 'IDEMPOTENT_REPLAY', registrationId: slotResult.registration_id ?? undefined };
    }

    if (slotResult.result_code === 'NOT_FOUND') {
      return { outcome: 'NOT_FOUND' };
    }

    if (slotResult.result_code === 'INVALID_STATE') {
      try { await this.stripe.paymentIntents.cancel(paymentIntentId); } catch (_) { /* best effort */ }
      return { outcome: 'INVALID_STATE' };
    }

    if (slotResult.result_code === 'AVAILABILITY_EXHAUSTED') {
      try { await this.stripe.paymentIntents.cancel(paymentIntentId); } catch (_) { /* best effort */ }
      return { outcome: 'AVAILABILITY_EXHAUSTED', registrationId: slotResult.registration_id ?? undefined };
    }

    const registrationId = slotResult.registration_id!;
    try {
      const captured = await this.stripe.paymentIntents.capture(paymentIntentId);
      const netAmountCents = captured.latest_charge?.amount_captured ?? captured.amount_received ?? grossAmountCents;

      const finalRows = await sql<Array<{
        result_code: string;
        registration_id: string | null;
        event_id: string | null;
        email: string | null;
        first_name: string | null;
        last_name: string | null;
      }>>`
        SELECT * FROM sp_finalize_registration(${paymentIntentId}, ${netAmountCents})
      `;

      const finalResult = finalRows[0];
      if (finalResult.result_code === 'SUCCESS') {
        try {
          const reg = await this.getRegistration(registrationId);
          if (reg) {
            const eventRows = await sql<Array<{name: string}>>`
              SELECT name FROM events WHERE event_id = ${reg.eventId}
            `;
            const eventName = eventRows.length > 0 ? eventRows[0].name : 'Event';
            await this.notificationService.sendRegistrationConfirmation(reg, eventName);
            await sql`SELECT sp_mark_confirmation_email_sent(${registrationId}::UUID)`;
          }
        } catch (emailErr) {
          console.error('[RegistrationService] Email notification failed:', emailErr);
        }
        return { outcome: 'SUCCESS', registrationId };
      }
      return { outcome: 'IDEMPOTENT_REPLAY', registrationId };
    } catch (captureErr: unknown) {
      if (isTransientStripeError(captureErr)) {
        await sql`SELECT sp_increment_capture_attempt(${registrationId}::UUID)`;
        return { outcome: 'CAPTURE_FAILED', registrationId, message: 'Capture failed transiently; will retry' };
      } else {
        await sql`SELECT * FROM sp_restore_slot_on_capture_failure(${paymentIntentId})`;
        // Release the customer's card authorization. Without this the PI
        // remains in requires_capture and Stripe holds funds for ~7 days.
        try { await this.stripe.paymentIntents.cancel(paymentIntentId); } catch (_) { /* best effort */ }
        return { outcome: 'CAPTURE_FAILED', registrationId, message: 'Capture permanently failed' };
      }
    }
  }

  async handlePaymentFailed(
    paymentIntentId: PaymentIntentId,
    _stripeEventPayload: Record<string, unknown>
  ): Promise<AuthorizationProcessResult> {
    const rows = await sql<Array<{result_code: string; registration_id: string | null}>>`
      SELECT * FROM sp_fail_registration(${paymentIntentId})
    `;
    const r = rows[0];
    if (r.result_code === 'IDEMPOTENT_REPLAY') {
      return { outcome: 'IDEMPOTENT_REPLAY', registrationId: r.registration_id ?? undefined };
    }
    if (r.result_code === 'NOT_FOUND') {
      return { outcome: 'NOT_FOUND' };
    }
    return { outcome: 'PAYMENT_FAILED', registrationId: r.registration_id ?? undefined };
  }

  async getRegistration(registrationId: RegistrationId): Promise<RegistrationRecord | null> {
    const rows = await sql`SELECT * FROM registrations WHERE registration_id = ${registrationId}::UUID`;
    if (rows.length === 0) return null;
    return mapDbRow(rows[0] as Record<string, unknown>);
  }

  async getRegistrationByPaymentIntent(paymentIntentId: PaymentIntentId): Promise<RegistrationRecord | null> {
    const rows = await sql`SELECT * FROM registrations WHERE payment_intent_id = ${paymentIntentId}`;
    if (rows.length === 0) return null;
    return mapDbRow(rows[0] as Record<string, unknown>);
  }

  async getConfirmedRegistrations(eventId: EventId): Promise<RegistrationRecord[]> {
    const rows = await sql`
      SELECT * FROM registrations WHERE event_id = ${eventId}::UUID AND status = 'CONFIRMED'
    `;
    return (rows as Record<string, unknown>[]).map(mapDbRow);
  }
}
