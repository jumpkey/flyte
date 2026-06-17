import { sql } from './db.js';

/**
 * Customer account reads (I7, WF-06). Everything is scoped to a session user_id;
 * ownership (R3) is enforced by the queries themselves — a registration that
 * isn't the user's simply isn't returned.
 */

export interface AccountRegistrationRow {
  registration_id: string;
  status: string;
  gross_amount_cents: number;
  refunded_amount_cents: number;
  created_at: Date;
  event_id: string;
  event_name: string;
  event_date: Date;
  location: string | null;
  can_request_refund: boolean;
}

export interface AccountWaitlistRow {
  waitlist_entry_id: string;
  event_id: string;
  event_name: string;
  event_date: Date;
  location: string | null;
  position: number;
}

// A registration is refund-requestable when CONFIRMED with no open/approved
// request (AC-I7 ③). A DENIED request may be re-filed.
const CAN_REQUEST_REFUND = sql`
  r.status = 'CONFIRMED' AND NOT EXISTS (
    SELECT 1 FROM refund_requests rr
    WHERE rr.registration_id = r.registration_id AND rr.status IN ('REQUESTED', 'APPROVED')
  )
`;

export const accountService = {
  /** Every registration bound to this user — including guest-era purchases. */
  async listRegistrations(userId: string): Promise<AccountRegistrationRow[]> {
    const rows = await sql`
      SELECT r.registration_id, r.status, r.gross_amount_cents, r.refunded_amount_cents, r.created_at,
             e.event_id, e.name AS event_name, e.event_date, e.location,
             (${CAN_REQUEST_REFUND}) AS can_request_refund
      FROM registrations r JOIN events e ON e.event_id = r.event_id
      WHERE r.user_id = ${userId}
      ORDER BY e.event_date DESC
    `;
    return rows as unknown as AccountRegistrationRow[];
  },

  /** Waitlist entries bound to this user (#29 — the account view includes these). */
  async listWaitlist(userId: string): Promise<AccountWaitlistRow[]> {
    // `position` is the 1-based rank by created_at within each event, mirroring
    // WaitlistService.getWaitlistPosition (computed over every entry for the event,
    // then narrowed to this user's rows).
    const rows = await sql`
      SELECT w.waitlist_entry_id, e.event_id, e.name AS event_name, e.event_date, e.location,
             (SELECT count(*)::int FROM waitlist_entries w2
              WHERE w2.event_id = w.event_id AND w2.created_at <= w.created_at) AS position
      FROM waitlist_entries w JOIN events e ON e.event_id = w.event_id
      WHERE w.user_id = ${userId}
      ORDER BY e.event_date DESC
    `;
    return rows as unknown as AccountWaitlistRow[];
  },

  /** Next confirmed registrations for upcoming events (dashboard panel). */
  async upcomingRegistrations(userId: string, limit = 3): Promise<AccountRegistrationRow[]> {
    const rows = await sql`
      SELECT r.registration_id, r.status, r.gross_amount_cents, r.refunded_amount_cents, r.created_at,
             e.event_id, e.name AS event_name, e.event_date, e.location,
             (${CAN_REQUEST_REFUND}) AS can_request_refund
      FROM registrations r JOIN events e ON e.event_id = r.event_id
      WHERE r.user_id = ${userId} AND r.status = 'CONFIRMED' AND e.event_date > now()
      ORDER BY e.event_date ASC
      LIMIT ${limit}
    `;
    return rows as unknown as AccountRegistrationRow[];
  },

  /**
   * One registration owned by this user (R3). Returns null when it doesn't exist
   * OR isn't the user's — both surface to the controller as a 404.
   */
  async getRegistration(registrationId: string, userId: string): Promise<Record<string, unknown> | null> {
    const rows = await sql`
      SELECT r.*, e.name AS event_name, e.event_date, e.location,
             (${CAN_REQUEST_REFUND}) AS can_request_refund,
             (SELECT rr.status FROM refund_requests rr WHERE rr.registration_id = r.registration_id ORDER BY rr.requested_at DESC LIMIT 1) AS refund_request_status
      FROM registrations r JOIN events e ON e.event_id = r.event_id
      WHERE r.registration_id = ${registrationId}::UUID AND r.user_id = ${userId}
    `;
    return (rows[0] as Record<string, unknown>) ?? null;
  },

  /**
   * Remove a waitlist entry the user owns (W12). The DELETE is ownership-scoped
   * (R3) so a non-owner's id simply affects no rows. Returns true when a row was
   * removed.
   */
  async removeWaitlistEntry(waitlistEntryId: string, userId: string): Promise<boolean> {
    const rows = await sql`
      DELETE FROM waitlist_entries
      WHERE waitlist_entry_id = ${waitlistEntryId}::UUID AND user_id = ${userId}
      RETURNING waitlist_entry_id
    `;
    return rows.length > 0;
  },
};
