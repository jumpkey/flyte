import { sql } from '../../services/db.js';
import type { StripeClient, IReconciliationService, IRegistrationService, INotificationService } from '../interfaces.js';
import type { ReconciliationResult } from '../types.js';

function isTransientStripeError(err: unknown): boolean {
  const e = err as Record<string, unknown>;
  return e['type'] === 'api_error' || e['code'] === 'rate_limit' || e['code'] === 'api_connection_error';
}

export class ReconciliationService implements IReconciliationService {
  constructor(
    private stripe: StripeClient,
    private registrationService: IRegistrationService,
    private notificationService: INotificationService,
    private options: { captureMaxRetries: number }
  ) {}

  async reconcilePendingRegistrations(ttlMinutes = 30): Promise<ReconciliationResult> {
    const result: ReconciliationResult = {
      expiredCount: 0,
      captureRetriedCount: 0,
      captureRestoredCount: 0,
      webhookRecoveredCount: 0,
      emailResentCount: 0,
      errorCount: 0,
      expiredRegistrationIds: [],
      restoredRegistrationIds: [],
    };

    // SCAN 1: Expired PENDING_PAYMENT registrations
    const expiredRows = await sql<Array<{
      registration_id: string;
      payment_intent_id: string | null;
      gross_amount_cents: number;
      created_at: Date;
    }>>`
      SELECT registration_id, payment_intent_id, gross_amount_cents, created_at
      FROM registrations
      WHERE status = 'PENDING_PAYMENT'
        AND created_at < now() - (${ttlMinutes} || ' minutes')::INTERVAL
      FOR UPDATE SKIP LOCKED
    `;

    for (const row of expiredRows) {
      try {
        if (row.payment_intent_id) {
          let piStatus: string;
          try {
            const pi = await this.stripe.paymentIntents.retrieve(row.payment_intent_id);
            piStatus = pi.status;
          } catch (_) {
            result.errorCount++;
            continue;
          }

          if (piStatus === 'requires_capture') {
            const res = await this.registrationService.handlePaymentAuthorized(
              row.payment_intent_id,
              row.gross_amount_cents
            );
            if (res.outcome === 'SUCCESS' || res.outcome === 'IDEMPOTENT_REPLAY') {
              result.webhookRecoveredCount++;
            } else {
              result.errorCount++;
            }
            continue;
          }

          if (!['canceled', 'succeeded'].includes(piStatus)) {
            try { await this.stripe.paymentIntents.cancel(row.payment_intent_id); } catch (_) { /* best effort */ }
          }
        }

        const expireRows = await sql<Array<{result_code: string}>>`
          SELECT * FROM sp_expire_registration(${row.registration_id}::UUID)
        `;
        if (expireRows[0].result_code === 'SUCCESS') {
          result.expiredCount++;
          result.expiredRegistrationIds.push(row.registration_id);
        }
      } catch (err) {
        console.error('[ReconciliationService] Error in scan 1:', err);
        result.errorCount++;
      }
    }

    // SCAN 2: PENDING_CAPTURE registrations
    const pendingCaptureRows = await sql<Array<{
      registration_id: string;
      payment_intent_id: string | null;
      gross_amount_cents: number;
      capture_attempt_count: number;
      last_capture_attempt_at: Date | null;
      created_at: Date;
    }>>`
      SELECT registration_id, payment_intent_id, gross_amount_cents,
             capture_attempt_count, last_capture_attempt_at, created_at
      FROM registrations
      WHERE status = 'PENDING_CAPTURE'
      FOR UPDATE SKIP LOCKED
    `;

    const now = new Date();
    for (const row of pendingCaptureRows) {
      try {
        const ageMs = now.getTime() - new Date(row.created_at).getTime();
        const ageDays = ageMs / (1000 * 60 * 60 * 24);

        if (ageDays > 6) {
          await sql`SELECT * FROM sp_restore_slot_on_capture_failure(${row.payment_intent_id})`;
          result.captureRestoredCount++;
          if (row.registration_id) result.restoredRegistrationIds.push(row.registration_id);
          continue;
        }

        if (row.capture_attempt_count >= this.options.captureMaxRetries) {
          await sql`SELECT * FROM sp_restore_slot_on_capture_failure(${row.payment_intent_id})`;
          result.captureRestoredCount++;
          if (row.registration_id) result.restoredRegistrationIds.push(row.registration_id);
          continue;
        }

        if (row.last_capture_attempt_at) {
          const backoffMs = Math.pow(2, row.capture_attempt_count) * 60 * 1000;
          const timeSinceLast = now.getTime() - new Date(row.last_capture_attempt_at).getTime();
          if (timeSinceLast < backoffMs) {
            continue;
          }
        }

        if (!row.payment_intent_id) {
          result.errorCount++;
          continue;
        }

        await sql`SELECT sp_increment_capture_attempt(${row.registration_id}::UUID)`;

        try {
          const captured = await this.stripe.paymentIntents.capture(row.payment_intent_id);
          const netAmount = captured.latest_charge?.amount_captured ?? captured.amount_received ?? row.gross_amount_cents;

          const finalRows = await sql<Array<{result_code: string; registration_id: string | null}>>`
            SELECT * FROM sp_finalize_registration(${row.payment_intent_id}, ${netAmount})
          `;

          if (finalRows[0].result_code === 'SUCCESS' && finalRows[0].registration_id) {
            result.captureRetriedCount++;
            try {
              const reg = await this.registrationService.getRegistration(row.registration_id);
              if (reg) {
                const eventRows = await sql<Array<{name: string}>>`SELECT name FROM events WHERE event_id = ${reg.eventId}::UUID`;
                const eventName = eventRows.length > 0 ? eventRows[0].name : 'Event';
                await this.notificationService.sendRegistrationConfirmation(reg, eventName);
                await sql`SELECT sp_mark_confirmation_email_sent(${row.registration_id}::UUID)`;
              }
            } catch (_) { /* best effort */ }
          } else {
            result.captureRetriedCount++;
          }
        } catch (captureErr: unknown) {
          if (isTransientStripeError(captureErr)) {
            result.captureRetriedCount++;
          } else {
            await sql`SELECT * FROM sp_restore_slot_on_capture_failure(${row.payment_intent_id})`;
            result.captureRestoredCount++;
            result.restoredRegistrationIds.push(row.registration_id);
          }
        }
      } catch (err) {
        console.error('[ReconciliationService] Error in scan 2:', err);
        result.errorCount++;
      }
    }

    // SCAN 3: CONFIRMED registrations with unsent confirmation emails
    const emailRows = await sql<Array<{
      registration_id: string;
      event_id: string;
    }>>`
      SELECT registration_id, event_id
      FROM registrations
      WHERE status = 'CONFIRMED'
        AND confirmation_email_sent_at IS NULL
    `;

    for (const row of emailRows) {
      try {
        const reg = await this.registrationService.getRegistration(row.registration_id);
        if (!reg) continue;

        const eventRows = await sql<Array<{name: string}>>`SELECT name FROM events WHERE event_id = ${reg.eventId}::UUID`;
        const eventName = eventRows.length > 0 ? eventRows[0].name : 'Event';

        await this.notificationService.sendRegistrationConfirmation(reg, eventName);
        await sql`SELECT sp_mark_confirmation_email_sent(${row.registration_id}::UUID)`;
        result.emailResentCount++;
      } catch (err) {
        result.errorCount++;
        console.error('[ReconciliationService] Error in scan 3:', err);
      }
    }

    return result;
  }
}
