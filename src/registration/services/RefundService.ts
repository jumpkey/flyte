import { sql } from '../../services/db.js';
import type { StripeClient, IRefundService, INotificationService } from '../interfaces.js';
import type {
  IndividualRefundRequest, BulkRefundRequest,
  RefundResult, BulkRefundResult, RegistrationRecord, RegistrationStatus
} from '../types.js';

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
      if (reg.refundedAmountCents >= reg.grossAmountCents) {
        return { outcome: 'ALREADY_REFUNDED', registrationId: reg.registrationId };
      }

      let refundId: string;
      try {
        const refund = await this.stripe.refunds.create({ payment_intent: reg.paymentIntentId });
        refundId = refund.id;
      } catch (_) {
        return { outcome: 'STRIPE_ERROR', registrationId: reg.registrationId };
      }

      const spRows = await sql<Array<{result_code: string}>>`
        SELECT * FROM sp_cancel_registration(
          ${reg.registrationId}::UUID,
          ${refundId},
          ${reg.grossAmountCents},
          ${request.reason},
          TRUE
        )
      `;
      if (spRows[0].result_code !== 'SUCCESS') {
        return { outcome: 'INTERNAL_ERROR' };
      }

      try {
        await this.notificationService.sendRefundConfirmation(reg, reg.grossAmountCents, eventName);
      } catch (_) { /* best effort */ }

      return { outcome: 'REFUND_ISSUED', registrationId: reg.registrationId, stripeRefundId: refundId, refundedAmountCents: reg.grossAmountCents };
    } else {
      const partialAmount = request.partialAmountCents;
      if (!partialAmount || partialAmount <= 0) return { outcome: 'INVALID_STATE' };
      const remaining = reg.grossAmountCents - reg.refundedAmountCents;
      if (partialAmount > remaining) return { outcome: 'AMOUNT_EXCEEDS_BALANCE' };

      let refundId: string;
      try {
        const refund = await this.stripe.refunds.create({ payment_intent: reg.paymentIntentId, amount: partialAmount });
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

      let refundId: string;
      try {
        const refund = await this.stripe.refunds.create({ payment_intent: reg.paymentIntentId });
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
          ${reg.grossAmountCents},
          ${request.reason},
          FALSE
        )
      `;
      const code = spRows[0].result_code;
      if (code === 'SUCCESS' || code === 'ALREADY_CANCELLED') {
        results.push({ registrationId: reg.registrationId, result: { outcome: 'REFUND_ISSUED', stripeRefundId: refundId } });
        totalSucceeded++;
        try {
          await this.notificationService.sendRefundConfirmation(reg, reg.grossAmountCents, eventName);
        } catch (_) { /* best effort */ }
      } else {
        results.push({ registrationId: reg.registrationId, result: { outcome: 'INTERNAL_ERROR' } });
        totalFailed++;
      }
    }

    await sql`UPDATE events SET status = 'CANCELLED', updated_at = now() WHERE event_id = ${request.eventId}::UUID`;

    return {
      eventId: request.eventId,
      totalProcessed: registrations.length,
      totalSucceeded,
      totalFailed,
      results,
    };
  }
}
