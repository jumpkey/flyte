import { sql } from './db.js';
import type { RegistrationRecord } from '../registration/types.js';

/**
 * Refund-request workflow reads/writes (I6, journey J4). The customer files at
 * most one open request per registration (enforced by the partial unique index
 * idx_refund_requests_open from migration 007); admins resolve from the queue.
 */

export interface RegistrationContext {
  registration: RegistrationRecord;
  eventName: string;
}

function toRegistrationRecord(row: Record<string, unknown>): RegistrationRecord {
  return {
    registrationId: row.registration_id as string,
    eventId: row.event_id as string,
    email: row.email as string,
    firstName: row.first_name as string,
    lastName: row.last_name as string,
    phone: (row.phone as string | null) ?? null,
    attributes: {},
    status: row.status as RegistrationRecord['status'],
    paymentIntentId: (row.payment_intent_id as string | null) ?? null,
    grossAmountCents: row.gross_amount_cents as number,
    netAmountCents: (row.net_amount_cents as number | null) ?? null,
    refundedAmountCents: row.refunded_amount_cents as number,
    stripeRefundId: null,
    captureAttemptCount: 0,
    lastCaptureAttemptAt: null,
    confirmationEmailSentAt: null,
    createdAt: row.created_at as Date,
    updatedAt: row.created_at as Date,
    confirmedAt: (row.confirmed_at as Date | null) ?? null,
    cancelledAt: null,
  };
}

export const refundRequestsService = {
  /** The registration + event name for a capability URL, or null if not found. */
  async getContext(registrationId: string): Promise<RegistrationContext | null> {
    const rows = await sql`
      SELECT r.*, e.name AS event_name
      FROM registrations r JOIN events e ON e.event_id = r.event_id
      WHERE r.registration_id = ${registrationId}::UUID
    `;
    if (rows.length === 0) return null;
    const row = rows[0] as Record<string, unknown>;
    return { registration: toRegistrationRecord(row), eventName: row.event_name as string };
  },

  async hasOpenRequest(registrationId: string): Promise<boolean> {
    const rows = await sql`SELECT 1 FROM refund_requests WHERE registration_id = ${registrationId}::UUID AND status = 'REQUESTED' LIMIT 1`;
    return rows.length > 0;
  },

  /**
   * File a request. The partial unique index makes this idempotent: a concurrent
   * or repeat filing surfaces as 'ALREADY_OPEN', never an error (AC-I6 ①).
   */
  async createRequest(registrationId: string, userId: string | null, reason: string | null): Promise<'CREATED' | 'ALREADY_OPEN'> {
    try {
      await sql`
        INSERT INTO refund_requests (registration_id, user_id, reason, status)
        VALUES (${registrationId}::UUID, ${userId}, ${reason}, 'REQUESTED')
      `;
      return 'CREATED';
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') return 'ALREADY_OPEN';
      throw err;
    }
  },

  /** Queue rows for the admin (WF-15). tab = 'open' (REQUESTED) or 'resolved'. */
  async listQueue(tab: 'open' | 'resolved'): Promise<Array<Record<string, unknown>>> {
    const statusClause = tab === 'open' ? sql`rr.status = 'REQUESTED'` : sql`rr.status IN ('APPROVED', 'DENIED')`;
    const order = tab === 'open' ? sql`rr.requested_at ASC` : sql`rr.resolved_at DESC`;
    const rows = await sql`
      SELECT rr.request_id, rr.status, rr.reason, rr.requested_at, rr.resolved_at, rr.resolution_note,
             r.registration_id, r.first_name, r.last_name, r.email,
             r.gross_amount_cents, r.net_amount_cents, r.refunded_amount_cents, r.status AS reg_status,
             e.name AS event_name
      FROM refund_requests rr
      JOIN registrations r ON r.registration_id = rr.registration_id
      JOIN events e ON e.event_id = r.event_id
      WHERE ${statusClause}
      ORDER BY ${order}
      LIMIT 200
    `;
    return rows as unknown as Array<Record<string, unknown>>;
  },

  async countOpen(): Promise<number> {
    const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM refund_requests WHERE status = 'REQUESTED'`;
    return rows[0]?.n ?? 0;
  },

  /** A single request with its registration (for approve/deny), or null. */
  async getById(requestId: string): Promise<{ requestId: string; status: string; context: RegistrationContext } | null> {
    const rows = await sql`
      SELECT rr.request_id, rr.status AS request_status, r.*, e.name AS event_name
      FROM refund_requests rr
      JOIN registrations r ON r.registration_id = rr.registration_id
      JOIN events e ON e.event_id = r.event_id
      WHERE rr.request_id = ${requestId}::UUID
    `;
    if (rows.length === 0) return null;
    const row = rows[0] as Record<string, unknown>;
    return {
      requestId: row.request_id as string,
      status: row.request_status as string,
      context: { registration: toRegistrationRecord(row), eventName: row.event_name as string },
    };
  },

  async resolve(requestId: string, status: 'APPROVED' | 'DENIED', resolvedBy: string, note: string | null): Promise<void> {
    await sql`
      UPDATE refund_requests
      SET status = ${status}, resolved_at = now(), resolved_by = ${resolvedBy}, resolution_note = ${note}
      WHERE request_id = ${requestId}::UUID AND status = 'REQUESTED'
    `;
  },
};
