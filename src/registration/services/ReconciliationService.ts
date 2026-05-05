import { sql } from '../../services/db.js';
import type { StripeClient, IReconciliationService, IRegistrationService, INotificationService } from '../interfaces.js';
import type { ReconciliationResult } from '../types.js';

function isTransientStripeError(err: unknown): boolean {
  const e = err as Record<string, unknown>;
  return e['type'] === 'api_error' || e['code'] === 'rate_limit' || e['code'] === 'api_connection_error';
}

// Stable 32-bit hash for use as a postgres advisory lock key. The runner uses
// this to serialize concurrent reconciliation sweeps across multiple Fly
// machines. Value is arbitrary but must be the same on every instance.
const RECONCILIATION_ADVISORY_LOCK_KEY = 0x52454330; // 'REC0'

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

    // Coordinate across multiple Fly machines: only one worker may sweep at a
    // time. pg_try_advisory_lock is session-scoped, so we use sql.reserve() to
    // pin a single connection for the duration of the sweep and release it at
    // the end. If the lock can't be acquired, another instance is sweeping and
    // we exit cleanly.
    const reserved = await sql.reserve();
    try {
      const [{ acquired }] = await reserved<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_lock(${RECONCILIATION_ADVISORY_LOCK_KEY}) AS acquired
      `;
      if (!acquired) {
        console.log('[reconciliation] another worker holds the advisory lock; skipping sweep');
        return result;
      }
      try {
        await this.runScan1(ttlMinutes, result);
        await this.runScan2(result);
        await this.runScan3(result);
      } finally {
        await reserved`SELECT pg_advisory_unlock(${RECONCILIATION_ADVISORY_LOCK_KEY})`;
      }
    } finally {
      reserved.release();
    }

    return result;
  }

  // SCAN 1: Expired PENDING_PAYMENT registrations.
  // Each row is processed in its own transaction so the row lock is held for
  // the full duration of the Stripe API calls plus the SP call. Discovery is
  // done unlocked; per-row work re-locks with SKIP LOCKED to coexist with
  // other workers (defense in depth even with the runner-wide advisory lock).
  private async runScan1(ttlMinutes: number, result: ReconciliationResult): Promise<void> {
    const candidates = await sql<Array<{
      registration_id: string;
      payment_intent_id: string | null;
      gross_amount_cents: number;
    }>>`
      SELECT registration_id, payment_intent_id, gross_amount_cents
      FROM registrations
      WHERE status = 'PENDING_PAYMENT'
        AND created_at < now() - (${ttlMinutes} || ' minutes')::INTERVAL
    `;

    for (const candidate of candidates) {
      try {
        // Capture recovery rows must be processed OUTSIDE the row-lock
        // transaction: handlePaymentAuthorized calls sp_acquire_slot_and_stage_capture
        // which takes its own FOR UPDATE lock on the same registration row.
        // If we held the lock inside sql.begin() while awaiting recovery, we'd
        // deadlock because the inner SP would wait on our lock forever.
        let recoverPiId: string | null = null;
        let recoverAmount = 0;

        await sql.begin(async (tx) => {
          const locked = await tx<Array<{
            registration_id: string;
            payment_intent_id: string | null;
            gross_amount_cents: number;
            status: string;
          }>>`
            SELECT registration_id, payment_intent_id, gross_amount_cents, status
            FROM registrations
            WHERE registration_id = ${candidate.registration_id}::UUID
              AND status = 'PENDING_PAYMENT'
            FOR UPDATE SKIP LOCKED
          `;
          if (locked.length === 0) return; // claimed elsewhere or status changed
          const row = locked[0];

          if (row.payment_intent_id) {
            let piStatus: string;
            try {
              const pi = await this.stripe.paymentIntents.retrieve(row.payment_intent_id);
              piStatus = pi.status;
            } catch (_) {
              result.errorCount++;
              return; // commit empty txn; row remains PENDING_PAYMENT for next sweep
            }

            if (piStatus === 'requires_capture') {
              // Schedule recovery outside this transaction. Set flag and
              // return immediately so the transaction commits and releases
              // the row lock before handlePaymentAuthorized tries to re-lock.
              recoverPiId = row.payment_intent_id;
              recoverAmount = row.gross_amount_cents;
              return;
            }

            if (piStatus === 'succeeded') {
              // PI has been captured by some path that bypassed our DB.
              // Refuse to expire this row; flag for human investigation.
              console.error(
                `[reconciliation] anomaly: registration ${row.registration_id} is PENDING_PAYMENT ` +
                `but PI ${row.payment_intent_id} is 'succeeded'. Skipping; please reconcile manually.`
              );
              result.errorCount++;
              return;
            }

            if (piStatus !== 'canceled') {
              try { await this.stripe.paymentIntents.cancel(row.payment_intent_id); } catch (_) { /* best effort */ }
            }
          }

          const expireRows = await tx<Array<{result_code: string}>>`
            SELECT * FROM sp_expire_registration(${row.registration_id}::UUID)
          `;
          if (expireRows[0].result_code === 'SUCCESS') {
            result.expiredCount++;
            result.expiredRegistrationIds.push(row.registration_id);
          }
        });

        // Now the transaction is committed and the row lock is released.
        // Safe to call handlePaymentAuthorized which takes its own locks.
        if (recoverPiId) {
          await this.recoverAuthorized(recoverPiId, recoverAmount, result);
        }
      } catch (err) {
        console.error('[ReconciliationService] Error in scan 1:', err);
        result.errorCount++;
      }
    }
  }

  // Helper for the requires_capture recovery path. Called AFTER the per-row
  // transaction has committed (and its row lock released) to avoid deadlocking
  // with sp_acquire_slot_and_stage_capture's own FOR UPDATE lock.
  private async recoverAuthorized(
    paymentIntentId: string,
    grossAmountCents: number,
    result: ReconciliationResult
  ): Promise<void> {
    const res = await this.registrationService.handlePaymentAuthorized(paymentIntentId, grossAmountCents);
    if (res.outcome === 'SUCCESS' || res.outcome === 'IDEMPOTENT_REPLAY') {
      result.webhookRecoveredCount++;
    } else {
      result.errorCount++;
    }
  }

  // SCAN 2: PENDING_CAPTURE registrations needing a capture retry.
  private async runScan2(result: ReconciliationResult): Promise<void> {
    const candidates = await sql<Array<{
      registration_id: string;
    }>>`
      SELECT registration_id
      FROM registrations
      WHERE status = 'PENDING_CAPTURE'
    `;

    const now = new Date();
    for (const candidate of candidates) {
      try {
        await sql.begin(async (tx) => {
          const locked = await tx<Array<{
            registration_id: string;
            payment_intent_id: string | null;
            gross_amount_cents: number;
            capture_attempt_count: number;
            last_capture_attempt_at: Date | null;
            created_at: Date;
            status: string;
          }>>`
            SELECT registration_id, payment_intent_id, gross_amount_cents,
                   capture_attempt_count, last_capture_attempt_at, created_at, status
            FROM registrations
            WHERE registration_id = ${candidate.registration_id}::UUID
              AND status = 'PENDING_CAPTURE'
            FOR UPDATE SKIP LOCKED
          `;
          if (locked.length === 0) return;
          const row = locked[0];

          if (!row.payment_intent_id) {
            result.errorCount++;
            return;
          }

          const ageMs = now.getTime() - new Date(row.created_at).getTime();
          const ageDays = ageMs / (1000 * 60 * 60 * 24);
          const giveUp = ageDays > 6 || row.capture_attempt_count >= this.options.captureMaxRetries;

          if (giveUp) {
            await tx`SELECT * FROM sp_restore_slot_on_capture_failure(${row.payment_intent_id})`;
            // Release the customer's card authorization (best effort, OK if
            // already cancelled or expired).
            try { await this.stripe.paymentIntents.cancel(row.payment_intent_id); } catch (_) { /* best effort */ }
            result.captureRestoredCount++;
            result.restoredRegistrationIds.push(row.registration_id);
            return;
          }

          if (row.last_capture_attempt_at) {
            const backoffMs = Math.pow(2, row.capture_attempt_count) * 60 * 1000;
            const timeSinceLast = now.getTime() - new Date(row.last_capture_attempt_at).getTime();
            if (timeSinceLast < backoffMs) return;
          }

          await tx`SELECT sp_increment_capture_attempt(${row.registration_id}::UUID)`;

          try {
            const captured = await this.stripe.paymentIntents.capture(row.payment_intent_id);
            const netAmount = captured.latest_charge?.amount_captured ?? captured.amount_received ?? row.gross_amount_cents;

            const finalRows = await tx<Array<{result_code: string; registration_id: string | null}>>`
              SELECT * FROM sp_finalize_registration(${row.payment_intent_id}, ${netAmount})
            `;

            if (finalRows[0].result_code === 'SUCCESS') {
              result.captureRetriedCount++;
              // Email send happens after txn commit (scan 3 will retry on failure).
              setImmediate(() => {
                void this.sendConfirmationEmail(row.registration_id);
              });
            }
            // IDEMPOTENT_REPLAY / NOT_FOUND / INVALID_STATE are not counted as retries.
          } catch (captureErr: unknown) {
            if (isTransientStripeError(captureErr)) {
              // Transient: leave as PENDING_CAPTURE; backoff handles next attempt.
              return;
            }
            await tx`SELECT * FROM sp_restore_slot_on_capture_failure(${row.payment_intent_id})`;
            try { await this.stripe.paymentIntents.cancel(row.payment_intent_id); } catch (_) { /* best effort */ }
            result.captureRestoredCount++;
            result.restoredRegistrationIds.push(row.registration_id);
          }
        });
      } catch (err) {
        console.error('[ReconciliationService] Error in scan 2:', err);
        result.errorCount++;
      }
    }
  }

  // SCAN 3: CONFIRMED registrations whose confirmation email never sent.
  // Per-row transaction with SKIP LOCKED to prevent two workers from sending
  // duplicate emails to the same customer.
  private async runScan3(result: ReconciliationResult): Promise<void> {
    const candidates = await sql<Array<{ registration_id: string }>>`
      SELECT registration_id
      FROM registrations
      WHERE status = 'CONFIRMED'
        AND confirmation_email_sent_at IS NULL
    `;

    for (const candidate of candidates) {
      try {
        await sql.begin(async (tx) => {
          const locked = await tx<Array<{ registration_id: string }>>`
            SELECT registration_id
            FROM registrations
            WHERE registration_id = ${candidate.registration_id}::UUID
              AND status = 'CONFIRMED'
              AND confirmation_email_sent_at IS NULL
            FOR UPDATE SKIP LOCKED
          `;
          if (locked.length === 0) return;

          const reg = await this.registrationService.getRegistration(candidate.registration_id);
          if (!reg) return;

          const eventRows = await tx<Array<{name: string}>>`
            SELECT name FROM events WHERE event_id = ${reg.eventId}::UUID
          `;
          const eventName = eventRows.length > 0 ? eventRows[0].name : 'Event';

          await this.notificationService.sendRegistrationConfirmation(reg, eventName);
          await tx`SELECT sp_mark_confirmation_email_sent(${candidate.registration_id}::UUID)`;
          result.emailResentCount++;
        });
      } catch (err) {
        result.errorCount++;
        console.error('[ReconciliationService] Error in scan 3:', err);
      }
    }
  }

  private async sendConfirmationEmail(registrationId: string): Promise<void> {
    try {
      const reg = await this.registrationService.getRegistration(registrationId);
      if (!reg) return;
      const eventRows = await sql<Array<{name: string}>>`
        SELECT name FROM events WHERE event_id = ${reg.eventId}::UUID
      `;
      const eventName = eventRows.length > 0 ? eventRows[0].name : 'Event';
      await this.notificationService.sendRegistrationConfirmation(reg, eventName);
      await sql`SELECT sp_mark_confirmation_email_sent(${registrationId}::UUID)`;
    } catch (err) {
      console.error('[ReconciliationService] post-capture email failed:', err);
      // Scan 3 will retry on the next sweep.
    }
  }
}
