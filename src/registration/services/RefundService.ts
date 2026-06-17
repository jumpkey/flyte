import { sql } from '../../services/db.js';
import type { StripeClient, IRefundService, INotificationService } from '../interfaces.js';
import type {
  IndividualRefundRequest, BulkRefundRequest,
  RefundResult, BulkRefundResult, RegistrationRecord, RegistrationStatus
} from '../types.js';

/**
 * Idempotency key for a Stripe refund (W13). Stripe dedups any retry that
 * carries the same key, so a double-submitted modal or a network retry issues
 * the refund at most once. We bind the key to the registration, the amount, and
 * the balance already refunded BEFORE this refund — so a genuine second partial
 * of the same size (a different logical refund) gets a distinct key and still
 * goes through, while an accidental re-send of the same request collapses.
 */
function refundIdempotencyKey(registrationId: string, priorRefundedCents: number, amountCents: number): string {
  return `refund-${registrationId}-${priorRefundedCents}-${amountCents}`;
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

export class RefundService implements IRefundService {
  constructor(
    private stripe: StripeClient,
    private notificationService: INotificationService
  ) {}

  async refundRegistration(request: IndividualRefundRequest): Promise<RefundResult> {
    const rows = await sql`SELECT * FROM registrations WHERE registration_id = ${request.registrationId}::UUID`;
    if (rows.length === 0) return { outcome: 'NOT_FOUND' };
    const reg = mapDbRow(rows[0] as Record<string, unknown>);

    if (reg.status === 'CANCELLED') return { outcome: 'ALREADY_REFUNDED', registrationId: reg.registrationId };
    if (reg.status !== 'CONFIRMED') return { outcome: 'INVALID_STATE', registrationId: reg.registrationId };
    if (!reg.paymentIntentId) return { outcome: 'INVALID_STATE' };

    const eventRows = await sql<Array<{name: string}>>`SELECT name FROM events WHERE event_id = ${reg.eventId}::UUID`;
    const eventName = eventRows.length > 0 ? eventRows[0].name : 'Event';

    if (request.refundType === 'FULL') {
      // A FULL refund cancels the registration and restores the slot. By default
      // it returns the whole captured (net) amount — Stripe refunds the captured
      // total when no `amount` is passed, and we track the same value so
      // refunded_amount_cents never overstates the charge. An approver may also
      // pass an explicit `partialAmountCents` to deduct a service fee (B5): the
      // registration is still cancelled, but only that amount is returned. The
      // amount is hard-capped at the captured balance, so a refund can never
      // exceed what was charged.
      const captured = reg.netAmountCents ?? reg.grossAmountCents;
      const maxRefundable = captured - reg.refundedAmountCents;
      const refundAmount = request.partialAmountCents ?? captured;

      if (request.partialAmountCents == null && reg.refundedAmountCents >= captured) {
        return { outcome: 'ALREADY_REFUNDED', registrationId: reg.registrationId };
      }
      if (refundAmount <= 0) return { outcome: 'INVALID_STATE', registrationId: reg.registrationId };
      if (refundAmount > maxRefundable) return { outcome: 'AMOUNT_EXCEEDS_BALANCE', registrationId: reg.registrationId };

      let refundId: string;
      try {
        // Omit `amount` for a true full refund (returns the exact captured
        // total); pass an explicit amount for a fee-deducted cancellation.
        const params = request.partialAmountCents != null
          ? { payment_intent: reg.paymentIntentId, amount: refundAmount }
          : { payment_intent: reg.paymentIntentId };
        const refund = await this.stripe.refunds.create(
          params,
          { idempotencyKey: refundIdempotencyKey(reg.registrationId, reg.refundedAmountCents, refundAmount) },
        );
        refundId = refund.id;
      } catch (_) {
        return { outcome: 'STRIPE_ERROR', registrationId: reg.registrationId };
      }

      const spRows = await sql<Array<{result_code: string}>>`
        SELECT * FROM sp_cancel_registration(
          ${reg.registrationId}::UUID,
          ${refundId},
          ${refundAmount},
          ${request.reason},
          TRUE
        )
      `;
      if (spRows[0].result_code !== 'SUCCESS') {
        return { outcome: 'INTERNAL_ERROR' };
      }

      try {
        await this.notificationService.sendRefundConfirmation(reg, refundAmount, eventName);
      } catch (_) { /* best effort */ }

      return { outcome: 'REFUND_ISSUED', registrationId: reg.registrationId, stripeRefundId: refundId, refundedAmountCents: refundAmount };
    } else {
      const partialAmount = request.partialAmountCents;
      if (!partialAmount || partialAmount <= 0) return { outcome: 'INVALID_STATE' };
      // Refundable balance is bounded by what was actually captured.
      const captured = reg.netAmountCents ?? reg.grossAmountCents;
      const remaining = captured - reg.refundedAmountCents;
      if (partialAmount > remaining) return { outcome: 'AMOUNT_EXCEEDS_BALANCE' };

      let refundId: string;
      try {
        const refund = await this.stripe.refunds.create(
          { payment_intent: reg.paymentIntentId, amount: partialAmount },
          { idempotencyKey: refundIdempotencyKey(reg.registrationId, reg.refundedAmountCents, partialAmount) },
        );
        refundId = refund.id;
      } catch (_) {
        return { outcome: 'STRIPE_ERROR', registrationId: reg.registrationId };
      }

      const spRows = await sql<Array<{result_code: string}>>`
        SELECT * FROM sp_partial_refund_registration(
          ${reg.registrationId}::UUID,
          ${refundId},
          ${partialAmount},
          ${request.reason}
        )
      `;
      if (spRows[0].result_code === 'AMOUNT_EXCEEDS_BALANCE') return { outcome: 'AMOUNT_EXCEEDS_BALANCE' };
      if (spRows[0].result_code !== 'SUCCESS') return { outcome: 'INTERNAL_ERROR' };

      return { outcome: 'PARTIAL_REFUND_ISSUED', registrationId: reg.registrationId, stripeRefundId: refundId, refundedAmountCents: partialAmount };
    }
  }

  async refundEvent(request: BulkRefundRequest): Promise<BulkRefundResult> {
    const eventRows = await sql<Array<{name: string}>>`SELECT name FROM events WHERE event_id = ${request.eventId}::UUID`;
    const eventName = eventRows.length > 0 ? eventRows[0].name : 'Event';

    const confirmedRows = await sql`
      SELECT * FROM registrations WHERE event_id = ${request.eventId}::UUID AND status = 'CONFIRMED'
    `;
    const registrations = (confirmedRows as Record<string, unknown>[]).map(mapDbRow);

    const results: BulkRefundResult['results'] = [];
    let totalSucceeded = 0;
    let totalFailed = 0;

    for (const reg of registrations) {
      if (!reg.paymentIntentId) {
        results.push({ registrationId: reg.registrationId, result: { outcome: 'INVALID_STATE' } });
        totalFailed++;
        continue;
      }

      const refundAmount = reg.netAmountCents ?? reg.grossAmountCents;

      let refundId: string;
      try {
        const refund = await this.stripe.refunds.create(
          { payment_intent: reg.paymentIntentId },
          { idempotencyKey: refundIdempotencyKey(reg.registrationId, reg.refundedAmountCents, refundAmount) },
        );
        refundId = refund.id;
      } catch (_) {
        results.push({ registrationId: reg.registrationId, result: { outcome: 'STRIPE_ERROR' } });
        totalFailed++;
        continue;
      }

      const spRows = await sql<Array<{result_code: string}>>`
        SELECT * FROM sp_cancel_registration(
          ${reg.registrationId}::UUID,
          ${refundId},
          ${refundAmount},
          ${request.reason},
          FALSE
        )
      `;
      const code = spRows[0].result_code;
      if (code === 'SUCCESS' || code === 'ALREADY_CANCELLED') {
        results.push({ registrationId: reg.registrationId, result: { outcome: 'REFUND_ISSUED', stripeRefundId: refundId } });
        totalSucceeded++;
        try {
          await this.notificationService.sendRefundConfirmation(reg, refundAmount, eventName);
        } catch (_) { /* best effort */ }
      } else {
        results.push({ registrationId: reg.registrationId, result: { outcome: 'INTERNAL_ERROR' } });
        totalFailed++;
      }
    }

    if (totalFailed === 0) {
      await sql`UPDATE events SET status = 'CANCELLED', updated_at = now() WHERE event_id = ${request.eventId}::UUID`;
    } else {
      console.warn(
        `[RefundService] ${totalFailed}/${registrations.length} refunds failed for event ${request.eventId}; ` +
        `event status NOT changed to CANCELLED`
      );
    }

    return {
      eventId: request.eventId,
      totalProcessed: registrations.length,
      totalSucceeded,
      totalFailed,
      results,
    };
  }
}
