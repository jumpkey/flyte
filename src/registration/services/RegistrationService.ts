import crypto from 'node:crypto';
import Stripe from 'stripe';
import { sql } from '../../services/db.js';
import { config } from '../../config.js';
import type { StripeClient, IRegistrationService, INotificationService } from '../interfaces.js';
import type {
  RegistrationFormData, RegistrationInitResult, AuthorizationProcessResult,
  RegistrationRecord, PaymentIntentId, RegistrationId, EventId, RegistrationStatus
} from '../types.js';

function isTransientStripeError(err: unknown): boolean {
  return err instanceof Stripe.errors.StripeConnectionError ||
    err instanceof Stripe.errors.StripeAPIError ||
    err instanceof Stripe.errors.StripeRateLimitError;
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
    const eventRows = await sql<Array<{registration_fee_cents: number; status: string; event_date: Date; name: string; available_slots: number}>>`
      SELECT registration_fee_cents, status, event_date, name, available_slots FROM events WHERE event_id = ${formData.eventId}
    `;
    if (eventRows.length === 0) {
      return { outcome: 'NOT_FOUND', message: 'Event not found' };
    }
    if (eventRows[0].registration_fee_cents !== formData.grossAmountCents) {
      return { outcome: 'INTERNAL_ERROR', message: 'Amount mismatch' };
    }
    if (formData.grossAmountCents === 0) {
      if (eventRows[0].status === 'FULL' || eventRows[0].available_slots <= 0) return { outcome: 'AVAILABILITY_EXHAUSTED' };
      if (eventRows[0].status !== 'OPEN' || new Date(eventRows[0].event_date).getTime() <= Date.now()) {
        return { outcome: 'INVALID_STATE', message: 'Event is not accepting registrations' };
      }
      const rows = await sql<Array<{result_code: string; registration_id: string | null}>>`
        SELECT * FROM sp_register_free(${formData.eventId}::UUID, ${formData.email},
          ${formData.firstName}, ${formData.lastName}, ${formData.phone ?? null},
          ${JSON.stringify(formData.attributes ?? {})}::JSONB)
      `;
      const row = rows[0];
      if (row.result_code === 'SUCCESS' && row.registration_id) {
        const reg = await this.getRegistration(row.registration_id);
        if (reg) {
          try {
            await this.notificationService.sendRegistrationConfirmation(reg, eventRows[0].name);
            await sql`SELECT sp_mark_confirmation_email_sent(${row.registration_id}::UUID)`;
          } catch (_) { /* reconciler can retry */ }
        }
        return { outcome: 'SUCCESS', registrationId: row.registration_id };
      }
      if (row.result_code === 'ALREADY_REGISTERED') return { outcome: 'ALREADY_REGISTERED' };
      if (row.result_code === 'EVENT_NOT_FOUND') return { outcome: 'NOT_FOUND' };
      if (row.result_code === 'EVENT_CLOSED') return { outcome: 'INVALID_STATE' };
      if (row.result_code === 'AVAILABILITY_EXHAUSTED') return { outcome: 'AVAILABILITY_EXHAUSTED' };
      return { outcome: 'INTERNAL_ERROR', message: 'Could not reserve free registration' };
    }

    // Detect a live checkout without disclosing its client secret based on an
    // unverified email address. The browser can resume its own in-memory
    // checkout capability after Back; a lost browser session must not be
    // silently rebound to another guest.
    const existing = await sql<Array<{registration_id: string}>>`
      SELECT registration_id FROM registrations
      WHERE event_id = ${formData.eventId}::UUID AND lower(email) = lower(${formData.email})
        AND status NOT IN ('PAYMENT_FAILED', 'EXPIRED', 'CANCELLED')
      ORDER BY created_at DESC LIMIT 1
    `;
    if (existing.length) {
      // Email is not proof of mailbox ownership. Never return a pending PI's
      // client secret based on a guest-supplied email address.
      return { outcome: 'ALREADY_REGISTERED', registrationId: existing[0].registration_id };
    }

    if (eventRows[0].status === 'FULL' || eventRows[0].available_slots <= 0) return { outcome: 'AVAILABILITY_EXHAUSTED' };
    if (eventRows[0].status !== 'OPEN' || new Date(eventRows[0].event_date).getTime() <= Date.now()) {
      return { outcome: 'INVALID_STATE', message: 'Event is not accepting registrations' };
    }

    let pi: { id: string; client_secret: string };
    try {
      // Keep Stripe Link out of checkout. IMPORTANT: `payment_method_types`
      // does NOT exclude Link — Link is a wallet that, per Stripe's docs, can't
      // be excluded per-transaction by method type, and its "returning user"
      // recognition is keyed to a browser-level Stripe session (NOT our app
      // login). That is why a prior user's Link card resurfaced for a different
      // Flyte user on the same browser. The only reliable controls are the
      // account's Link setting (Dashboard) and a Payment Method Configuration
      // with Link disabled. When a Link-off PMC id is configured we pin it per
      // PI (deterministic); otherwise we fall back to card-only types. See
      // STRIPE-INTEGRATION.md → "Disabling Stripe Link".
      const methodParams: Record<string, unknown> = config.stripe.paymentMethodConfiguration
        ? { payment_method_configuration: config.stripe.paymentMethodConfiguration }
        : { payment_method_types: ['card'] };
      const attemptId = crypto.randomUUID();
      pi = await this.stripe.paymentIntents.create(
        {
          amount: formData.grossAmountCents,
          currency: 'usd',
          capture_method: 'manual',
          metadata: { eventId: formData.eventId, email: formData.email, checkoutAttemptId: attemptId },
          ...methodParams,
        },
        { idempotencyKey: `pi-create-${attemptId}` }
      );
    } catch (err: unknown) {
      const e = err as Record<string, unknown>;
      const msg = (e['message'] as string | undefined) ?? '';
      if (err instanceof Stripe.errors.StripeConnectionError || err instanceof Stripe.errors.StripeRateLimitError || msg.toLowerCase().includes('timeout')) {
        return { outcome: 'STRIPE_TIMEOUT', message: 'Stripe API timed out' };
      }
      return { outcome: 'STRIPE_ERROR', message: 'Stripe API error' };
    }

    let spRows: Array<{result_code: string; registration_id: string | null}>;
    try {
      spRows = await sql<Array<{result_code: string; registration_id: string | null}>>`
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
    } catch (dbError) {
      // A DB error may have happened after commit. Only cancel if we can prove
      // the intent has no durable registration reference.
      try {
        const refs = await sql`SELECT 1 FROM registrations WHERE payment_intent_id = ${pi.id}`;
        if (refs.length === 0) await this.stripe.paymentIntents.cancel(pi.id);
      } catch (_) { /* unknown state: retain PI for safe reconciliation */ }
      throw dbError;
    }

    const spResult = spRows[0];

    if (spResult.result_code === 'ALREADY_REGISTERED') {
      const refs = await sql`SELECT 1 FROM registrations WHERE payment_intent_id = ${pi.id}`;
      if (refs.length === 0) try { await this.stripe.paymentIntents.cancel(pi.id); } catch (_) { /* best effort */ }
      return { outcome: 'ALREADY_REGISTERED' };
    }
    if (spResult.result_code === 'EVENT_CLOSED') {
      try { await this.stripe.paymentIntents.cancel(pi.id); } catch (_) { /* best effort */ }
      return { outcome: 'INVALID_STATE' };
    }
    if (spResult.result_code === 'AVAILABILITY_EXHAUSTED') {
      try { await this.stripe.paymentIntents.cancel(pi.id); } catch (_) { /* best effort */ }
      return { outcome: 'AVAILABILITY_EXHAUSTED' };
    }
    if (spResult.result_code === 'INVALID_AMOUNT') {
      try { await this.stripe.paymentIntents.cancel(pi.id); } catch (_) { /* best effort */ }
      return { outcome: 'INTERNAL_ERROR', message: 'Amount mismatch' };
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

    const rows = await sql<Array<{gross_amount_cents: number}>>`
      SELECT gross_amount_cents FROM registrations WHERE payment_intent_id = ${paymentIntentId}
    `;
    if (rows.length === 0) {
      // pi.latest_charge.amount_captured is null in requires_capture state, so
      // there is no safe fallback. Treat as missing — caller will surface error.
      return { outcome: 'NOT_FOUND' };
    }

    if (pi.status === 'requires_capture') return this.handlePaymentAuthorized(paymentIntentId, rows[0].gross_amount_cents);
    if (pi.status === 'succeeded') return this.handlePaymentAuthorized(paymentIntentId, rows[0].gross_amount_cents, true);
    if (pi.status === 'processing') return { outcome: 'CAPTURE_FAILED', message: 'Payment is still processing' };
    if (pi.status === 'canceled') return this.handlePaymentFailed(paymentIntentId, {});
    return { outcome: 'PAYMENT_FAILED', message: 'Payment was not authorized' };
  }

  async handlePaymentAuthorized(
    paymentIntentId: PaymentIntentId,
    grossAmountCents: number,
    alreadyCaptured = false
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
      if (alreadyCaptured && slotResult.registration_id) {
        const reg = await this.getRegistration(slotResult.registration_id);
        if (reg?.status === 'PENDING_CAPTURE') return this.finalizeCaptured(paymentIntentId, grossAmountCents, grossAmountCents);
      }
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
    if (alreadyCaptured) return this.finalizeCaptured(paymentIntentId, grossAmountCents, grossAmountCents, registrationId);

    let captured: { latest_charge?: { amount_captured: number }; amount_received?: number };
    try {
      captured = await this.stripe.paymentIntents.capture(paymentIntentId);
    } catch (captureErr: unknown) {
      let recovered: Awaited<ReturnType<StripeClient['paymentIntents']['retrieve']>> | null = null;
      try { recovered = await this.stripe.paymentIntents.retrieve(paymentIntentId); } catch (_) { /* uncertain: retain slot */ }
      if (recovered?.status === 'succeeded') {
        return this.finalizeCaptured(paymentIntentId, grossAmountCents,
          recovered.latest_charge?.amount_captured ?? recovered.amount_received ?? grossAmountCents, registrationId);
      }
      if (!recovered || recovered.status !== 'requires_capture' || isTransientStripeError(captureErr) || !(captureErr instanceof Stripe.errors.StripeCardError)) {
        await sql`SELECT sp_increment_capture_attempt(${registrationId}::UUID)`;
        return { outcome: 'CAPTURE_FAILED', registrationId, message: 'Capture outcome is uncertain; the reservation is being reconciled' };
      }
      try {
        const canceled = await this.stripe.paymentIntents.cancel(paymentIntentId);
        if (canceled.status !== 'canceled') return { outcome: 'CAPTURE_FAILED', registrationId, message: 'Payment authorization could not be released yet' };
      } catch (_) {
        return { outcome: 'CAPTURE_FAILED', registrationId, message: 'Payment authorization could not be released yet' };
      }
      await sql`SELECT * FROM sp_restore_slot_on_capture_failure(${paymentIntentId})`;
      return { outcome: 'CAPTURE_FAILED', registrationId, message: 'Capture permanently failed' };
    }
    const netAmountCents = captured.latest_charge?.amount_captured ?? captured.amount_received ?? grossAmountCents;
    return this.finalizeCaptured(paymentIntentId, grossAmountCents, netAmountCents, registrationId);
  }

  private async finalizeCaptured(paymentIntentId: PaymentIntentId, _grossAmountCents: number,
    netAmountCents: number, knownRegistrationId?: RegistrationId): Promise<AuthorizationProcessResult> {
    let finalRows: Array<{result_code: string; registration_id: string | null}>;
    try {
      finalRows = await sql<Array<{result_code: string; registration_id: string | null}>>`
        SELECT * FROM sp_finalize_registration(${paymentIntentId}, ${netAmountCents})
      `;
    } catch (_) {
      return { outcome: 'CAPTURE_FAILED', registrationId: knownRegistrationId, message: 'Capture succeeded; registration finalization will be retried' };
    }
    const finalResult = finalRows[0];
    const registrationId = (finalResult.registration_id ?? knownRegistrationId) as RegistrationId | undefined;
    if (finalResult.result_code === 'SUCCESS') {
      if (registrationId) {
        try {
          const reg = await this.getRegistration(registrationId);
          if (reg) {
            const eventRows = await sql<Array<{name: string}>>`SELECT name FROM events WHERE event_id = ${reg.eventId}`;
            await this.notificationService.sendRegistrationConfirmation(reg, eventRows[0]?.name ?? 'Event');
            await sql`SELECT sp_mark_confirmation_email_sent(${registrationId}::UUID)`;
          }
        } catch (emailErr) { console.error('[RegistrationService] Email notification failed:', emailErr); }
      }
      return { outcome: 'SUCCESS', registrationId };
    }
    if (finalResult.result_code === 'IDEMPOTENT_REPLAY') return { outcome: 'IDEMPOTENT_REPLAY', registrationId };
    return { outcome: 'CAPTURE_FAILED', registrationId, message: `Capture recorded; finalization pending (${finalResult.result_code})` };
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
