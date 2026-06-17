import { sql } from './db.js';
import type { EventFormValues } from '../web/validators/event-form.js';

/**
 * Admin-side event domain operations (I4). Unlike catalog-service (public reads,
 * visibility-filtered), this sees every event in every status and performs the
 * create/update/lifecycle writes behind adminGuard.
 */

export interface AdminEventRow {
  event_id: string;
  name: string;
  event_date: Date;
  location: string | null;
  description: string | null;
  total_capacity: number;
  confirmed_count: number;
  available_slots: number;
  registration_fee_cents: number;
  status: string;
  image_url: string | null;
  waitlist_enabled: boolean;
  opened_at: Date | null;
  gross_revenue_cents?: number;
}

export const eventAdminService = {
  /** Every event, all statuses, with confirmed-gross revenue, soonest first. */
  async listForAdmin(): Promise<AdminEventRow[]> {
    const rows = await sql`
      SELECT e.*,
             COALESCE(r.gross, 0)::int AS gross_revenue_cents
      FROM events e
      LEFT JOIN (
        SELECT event_id, SUM(gross_amount_cents) AS gross
        FROM registrations WHERE status = 'CONFIRMED'
        GROUP BY event_id
      ) r ON r.event_id = e.event_id
      ORDER BY e.event_date ASC
    `;
    return rows as unknown as AdminEventRow[];
  },

  async getById(eventId: string): Promise<AdminEventRow | null> {
    const rows = await sql`SELECT * FROM events WHERE event_id = ${eventId}::UUID`;
    return (rows[0] as unknown as AdminEventRow) ?? null;
  },

  /**
   * Create an event. New events default to DRAFT (publicly invisible) unless
   * opened immediately, in which case opened_at is stamped (Document 5 §5).
   */
  async create(values: EventFormValues, openImmediately: boolean): Promise<string> {
    const status = openImmediately ? 'OPEN' : 'DRAFT';
    const rows = await sql`
      INSERT INTO events (
        name, description, event_date, location,
        total_capacity, confirmed_count, available_slots,
        registration_fee_cents, status, image_url, waitlist_enabled, opened_at
      ) VALUES (
        ${values.name}, ${values.description}, ${values.eventDate}, ${values.location},
        ${values.totalCapacity}, 0, ${values.totalCapacity},
        ${values.registrationFeeCents}, ${status}, ${values.imageUrl}, ${values.waitlistEnabled},
        ${openImmediately ? sql`now()` : null}
      ) RETURNING event_id
    `;
    return rows[0].event_id as string;
  },

  /**
   * Update an event's fields and status. Capacity changes recompute
   * available_slots against the live confirmed_count (the capacity_invariant
   * CHECK enforces consistency; the form's capacity floor keeps it non-negative).
   * A first transition into OPEN stamps opened_at.
   */
  async update(eventId: string, values: EventFormValues, newStatus: string, currentOpenedAt: Date | null): Promise<void> {
    const stampOpened = newStatus === 'OPEN' && currentOpenedAt === null;
    await sql`
      UPDATE events SET
        name = ${values.name},
        description = ${values.description},
        event_date = ${values.eventDate},
        location = ${values.location},
        total_capacity = ${values.totalCapacity},
        available_slots = ${values.totalCapacity} - confirmed_count,
        registration_fee_cents = ${values.registrationFeeCents},
        image_url = ${values.imageUrl},
        waitlist_enabled = ${values.waitlistEnabled},
        status = ${newStatus},
        opened_at = ${stampOpened ? sql`now()` : sql`opened_at`},
        updated_at = now()
      WHERE event_id = ${eventId}::UUID
    `;
  },

  /** Roster: all registrations for the event, newest first. */
  async getRoster(eventId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await sql`
      SELECT registration_id, first_name, last_name, email, status,
             gross_amount_cents, refunded_amount_cents, created_at, user_id
      FROM registrations WHERE event_id = ${eventId}::UUID
      ORDER BY created_at DESC
    `;
    return rows as unknown as Array<Record<string, unknown>>;
  },

  async getWaitlist(eventId: string): Promise<Array<Record<string, unknown>>> {
    const rows = await sql`
      SELECT waitlist_entry_id, first_name, last_name, email, created_at
      FROM waitlist_entries WHERE event_id = ${eventId}::UUID
      ORDER BY created_at ASC
    `;
    return rows as unknown as Array<Record<string, unknown>>;
  },

  /** Header stats for the event detail page (WF-10). */
  async getStats(eventId: string): Promise<{ waitlistCount: number; grossRevenueCents: number; netRevenueCents: number; refundedCents: number }> {
    const rows = await sql<{ gross: string | null; net: string | null; refunded: string | null }[]>`
      SELECT
        SUM(gross_amount_cents) FILTER (WHERE status = 'CONFIRMED') AS gross,
        SUM(net_amount_cents)   FILTER (WHERE status = 'CONFIRMED') AS net,
        SUM(refunded_amount_cents) AS refunded
      FROM registrations WHERE event_id = ${eventId}::UUID
    `;
    const wl = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM waitlist_entries WHERE event_id = ${eventId}::UUID`;
    return {
      waitlistCount: wl[0]?.n ?? 0,
      grossRevenueCents: parseInt(rows[0]?.gross ?? '0', 10) || 0,
      netRevenueCents: parseInt(rows[0]?.net ?? '0', 10) || 0,
      refundedCents: parseInt(rows[0]?.refunded ?? '0', 10) || 0,
    };
  },
};
