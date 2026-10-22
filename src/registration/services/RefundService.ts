import { sql } from '../../services/db.js';
import type { StripeClient, IRefundService, INotificationService } from '../interfaces.js';
import type { IndividualRefundRequest, BulkRefundRequest, RefundResult, BulkRefundResult, RegistrationRecord, RegistrationStatus } from '../types.js';

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

/** Refund operations persist before contacting Stripe, so retries span both systems. */
export class RefundService implements IRefundService {
  constructor(private stripe: StripeClient, private notificationService: INotificationService) {}

  async refundRegistration(request: IndividualRefundRequest): Promise<RefundResult> {
    const operation = await sql.begin(async tx => {
      const rows = await tx`SELECT * FROM registrations WHERE registration_id = ${request.registrationId}::uuid FOR UPDATE`;
      if (!rows[0]) return { error: 'NOT_FOUND' as const };
      const reg = mapDbRow(rows[0]);
      const key = request.operationId ?? `refund-${reg.registrationId}-${reg.refundedAmountCents}-${request.refundType}-${request.partialAmountCents ?? 'remaining'}`;
      const existing = await tx`SELECT * FROM refund_operations WHERE operation_id = ${key}`;
      if (existing[0]) {
        const op = existing[0];
        if (op.registration_id !== reg.registrationId || op.refund_type !== request.refundType ||
            (request.partialAmountCents != null && op.amount_cents !== request.partialAmountCents)) return { error: 'INVALID_STATE' as const };
        return { op, reg };
      }
      if (reg.status === 'CANCELLED') return { error: 'ALREADY_REFUNDED' as const };
      if (reg.status !== 'CONFIRMED') return { error: 'INVALID_STATE' as const };
      // Resume an uncertain operation instead of permitting a second refund.
      const pending = await tx`SELECT * FROM refund_operations WHERE registration_id = ${reg.registrationId}::uuid AND status = 'PENDING'`;
      if (pending[0]) return { error: 'INTERNAL_ERROR' as const };
      const remaining = (reg.netAmountCents ?? reg.grossAmountCents) - reg.refundedAmountCents;
      const amount = request.partialAmountCents ?? (request.refundType === 'FULL' ? remaining : -1);
      if (!Number.isSafeInteger(amount) || amount < 0 || (request.refundType === 'PARTIAL' && amount === 0)) return { error: 'INVALID_STATE' as const };
      if (amount > remaining) return { error: 'AMOUNT_EXCEEDS_BALANCE' as const };
      if (amount > 0 && !reg.paymentIntentId) return { error: 'INVALID_STATE' as const };
      const inserted = await tx`INSERT INTO refund_operations (operation_id, registration_id, refund_type, amount_cents, reason)
        VALUES (${key}, ${reg.registrationId}::uuid, ${request.refundType}, ${amount}, ${request.reason}) RETURNING *`;
      return { op: inserted[0], reg };
    });
    if ('error' in operation) return { outcome: operation.error!, registrationId: request.registrationId };
    const { op, reg } = operation;
    const success = (): RefundResult => ({ outcome: op.refund_type === 'FULL' ? 'REFUND_ISSUED' : 'PARTIAL_REFUND_ISSUED',
      registrationId: reg.registrationId, stripeRefundId: op.stripe_refund_id ?? undefined, refundedAmountCents: op.amount_cents });
    if (op.status === 'COMPLETED') return success();
    let refundId: string | null = op.stripe_refund_id ?? null;
    let amount = op.amount_cents as number;
    if (amount > 0) {
      // Stripe may prune idempotency keys after 24 hours. Never create a new
      // refund blindly once an unresolved request crosses that boundary.
      if (!refundId && Date.now() - new Date(op.created_at).getTime() > 23 * 60 * 60 * 1000) return { outcome: 'INTERNAL_ERROR', registrationId: reg.registrationId };
      try {
        const refund = refundId && this.stripe.refunds.retrieve
          ? await this.stripe.refunds.retrieve(refundId)
          : await this.stripe.refunds.create({ payment_intent: reg.paymentIntentId, amount }, { idempotencyKey: op.operation_id });
        refundId = refund.id;
        if (typeof refund.amount !== 'number' || refund.amount !== amount) return { outcome: 'INTERNAL_ERROR', registrationId: reg.registrationId };
        await sql`UPDATE refund_operations SET stripe_refund_id = ${refundId}, updated_at = now() WHERE operation_id = ${op.operation_id}`;
        if (refund.status !== 'succeeded') return { outcome: 'STRIPE_ERROR', registrationId: reg.registrationId };
      } catch (_) {
        // Preserve the operation: the processor may have accepted the refund.
        return { outcome: 'STRIPE_ERROR', registrationId: reg.registrationId };
      }
    }
    const applied = await sql.begin(async tx => {
      const code = op.refund_type === 'FULL'
        ? await tx`SELECT * FROM sp_cancel_registration(${reg.registrationId}::uuid, ${refundId ?? op.operation_id}, ${amount}, ${op.reason}, TRUE)`
        : await tx`SELECT * FROM sp_partial_refund_registration(${reg.registrationId}::uuid, ${refundId}, ${amount}, ${op.reason})`;
      if (!['SUCCESS', 'IDEMPOTENT_REPLAY', 'ALREADY_CANCELLED'].includes(code[0].result_code)) return false;
      await tx`UPDATE refund_operations SET status = 'COMPLETED', stripe_refund_id = ${refundId}, updated_at = now() WHERE operation_id = ${op.operation_id}`;
      return true;
    });
    if (!applied) return { outcome: 'INTERNAL_ERROR', registrationId: reg.registrationId };
    op.stripe_refund_id = refundId;
    // A single claim avoids duplicate emails on concurrent delivery. Mail is
    // advisory; financial completion does not depend on delivery.
    const claimed = await sql`UPDATE refund_operations SET notification_claimed = TRUE WHERE operation_id = ${op.operation_id} AND NOT notification_claimed RETURNING operation_id`;
    if (claimed.length) {
      const events = await sql`SELECT name FROM events WHERE event_id = ${reg.eventId}::uuid`;
      try { await this.notificationService.sendRefundConfirmation(reg, amount, events[0]?.name ?? 'Event'); } catch (_) { /* operator can resend */ }
    }
    return success();
  }

  async reconcilePendingRefunds(): Promise<number> {
    const pending = await sql`SELECT * FROM refund_operations WHERE status = 'PENDING' ORDER BY created_at LIMIT 100`;
    let completed = 0;
    for (const op of pending) {
      try {
        const result = await this.refundRegistration({ registrationId: op.registration_id, refundType: op.refund_type,
          partialAmountCents: op.amount_cents, reason: op.reason, operationId: op.operation_id });
        if (['REFUND_ISSUED', 'PARTIAL_REFUND_ISSUED'].includes(result.outcome)) completed++;
        else console.warn('[refund-recovery] unresolved operation', op.operation_id, result.outcome);
      } catch (error) {
        console.error('[refund-recovery] operation failed', op.operation_id, error);
      }
    }
    return completed;
  }

  async refundEvent(request: BulkRefundRequest): Promise<BulkRefundResult> {
    // Commit the admission freeze before inspecting payment state. Captures
    // already in flight may finish, and are refunded on this or the next pass.
    await sql`UPDATE events SET status = 'CANCELLING', updated_at = now() WHERE event_id = ${request.eventId}::uuid AND status <> 'CANCELLED'`;
    const pending = await sql`SELECT registration_id, payment_intent_id FROM registrations WHERE event_id = ${request.eventId}::uuid AND status = 'PENDING_PAYMENT'`;
    for (const row of pending) {
      try {
        if (row.payment_intent_id) await this.stripe.paymentIntents.cancel(row.payment_intent_id);
        await sql`SELECT * FROM sp_fail_registration(${row.payment_intent_id})`;
      } catch (_) { /* reconciliation must resolve the uncertain capture */ }
    }
    const confirmed = await sql`SELECT registration_id FROM registrations WHERE event_id = ${request.eventId}::uuid AND status = 'CONFIRMED'`;
    const results: BulkRefundResult['results'] = [];
    let totalSucceeded = 0;
    for (const reg of confirmed) {
      const result = await this.refundRegistration({ registrationId: reg.registration_id, refundType: 'FULL', reason: request.reason,
        operationId: `event-cancel-${request.eventId}-${reg.registration_id}` });
      results.push({ registrationId: reg.registration_id, result });
      if (['REFUND_ISSUED', 'ALREADY_REFUNDED'].includes(result.outcome)) totalSucceeded++;
    }
    const unresolved = await sql`SELECT count(*)::int AS n FROM registrations WHERE event_id = ${request.eventId}::uuid AND status IN ('PENDING_PAYMENT','PENDING_CAPTURE','CONFIRMED')`;
    const totalFailed = unresolved[0].n as number;
    if (totalFailed === 0) await sql`UPDATE events SET status = 'CANCELLED', updated_at = now() WHERE event_id = ${request.eventId}::uuid AND status = 'CANCELLING'`;
    return { eventId: request.eventId, totalProcessed: totalSucceeded + totalFailed, totalSucceeded, totalFailed, results };
  }
}
