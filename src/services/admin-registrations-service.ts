import { sql } from './db.js';

/**
 * Admin transaction log + payment detail reads (I5, WF-11/WF-12). Sees every
 * registration in every payment state — this is the first UI to surface
 * PAYMENT_FAILED and EXPIRED rows.
 */

export interface TransactionRow {
  registration_id: string;
  created_at: Date;
  email: string;
  first_name: string;
  last_name: string;
  status: string;
  gross_amount_cents: number;
  net_amount_cents: number | null;
  refunded_amount_cents: number;
  event_id: string;
  event_name: string;
}

export interface TransactionFilters {
  eventId?: string;
  status?: string;
  email?: string;
  from?: string;   // YYYY-MM-DD
  to?: string;     // YYYY-MM-DD
  page?: number;
  perPage?: number;
}

export interface TransactionPage {
  rows: TransactionRow[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
}

const STATUSES = ['PENDING_PAYMENT', 'PENDING_CAPTURE', 'CONFIRMED', 'PAYMENT_FAILED', 'EXPIRED', 'CANCELLED'];

export const adminRegistrationsService = {
  validStatuses(): string[] {
    return STATUSES;
  },

  async listTransactions(f: TransactionFilters): Promise<TransactionPage> {
    const perPage = Math.min(Math.max(f.perPage ?? 25, 1), 100);
    const page = Math.max(f.page ?? 1, 1);
    const offset = (page - 1) * perPage;

    const eventId = f.eventId && /^[0-9a-f-]{36}$/i.test(f.eventId) ? f.eventId : null;
    const status = f.status && STATUSES.includes(f.status) ? f.status : null;
    const email = f.email && f.email.trim() ? `%${f.email.trim()}%` : null;
    const from = f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from) ? f.from : null;
    // `to` is inclusive of the whole day → compare against the next day.
    const to = f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to) ? f.to : null;

    const where = sql`
      (${eventId}::uuid IS NULL OR r.event_id = ${eventId}::uuid)
      AND (${status}::text IS NULL OR r.status = ${status})
      AND (${email}::text IS NULL OR r.email ILIKE ${email})
      AND (${from}::date IS NULL OR r.created_at >= ${from}::date)
      AND (${to}::date IS NULL OR r.created_at < (${to}::date + 1))
    `;

    const countRows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM registrations r WHERE ${where}`;
    const total = countRows[0]?.n ?? 0;

    const rows = await sql`
      SELECT r.registration_id, r.created_at, r.email, r.first_name, r.last_name,
             r.status, r.gross_amount_cents, r.net_amount_cents, r.refunded_amount_cents,
             e.event_id, e.name AS event_name
      FROM registrations r JOIN events e ON e.event_id = r.event_id
      WHERE ${where}
      ORDER BY r.created_at DESC
      LIMIT ${perPage} OFFSET ${offset}
    `;

    return {
      rows: rows as unknown as TransactionRow[],
      total, page, perPage,
      totalPages: Math.max(Math.ceil(total / perPage), 1),
    };
  },

  /** Full payment record + linked user + refund-log timeline (WF-12). */
  async getDetail(registrationId: string): Promise<{
    registration: Record<string, unknown>;
    refundLog: Array<Record<string, unknown>>;
  } | null> {
    const rows = await sql`
      SELECT r.*, e.name AS event_name, e.event_date,
             u.email AS user_email, u.account_status AS user_account_status
      FROM registrations r
      JOIN events e ON e.event_id = r.event_id
      LEFT JOIN users u ON u.id = r.user_id
      WHERE r.registration_id = ${registrationId}::UUID
    `;
    if (rows.length === 0) return null;

    const refundLog = await sql`
      SELECT refund_type, amount_cents, reason, stripe_refund_id, created_at
      FROM refund_log WHERE registration_id = ${registrationId}::UUID
      ORDER BY created_at ASC
    `;
    return {
      registration: rows[0] as Record<string, unknown>,
      refundLog: refundLog as unknown as Array<Record<string, unknown>>,
    };
  },

  /**
   * Auto-resolve any open refund request for a registration after a direct
   * admin refund (site map §4.3), so I6's queue can never go stale. No-op until
   * I6 starts creating refund_requests, but the wiring ships here.
   */
  async resolveOpenRefundRequests(registrationId: string, resolvedBy: string): Promise<void> {
    await sql`
      UPDATE refund_requests
      SET status = 'APPROVED', resolved_at = now(), resolved_by = ${resolvedBy},
          resolution_note = 'Resolved by direct refund'
      WHERE registration_id = ${registrationId}::UUID AND status = 'REQUESTED'
    `;
  },
};
