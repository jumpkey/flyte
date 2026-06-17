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
  has_image: boolean;
  waitlist_enabled: boolean;
  opened_at: Date | null;
  gross_revenue_cents?: number;
}

export const eventAdminService = {
  /** Every event, all statuses, with confirmed-gross revenue, soonest first. */
  async listForAdmin(): Promise<AdminEventRow[]> {
    const rows = await sql`
      SELECT e.event_id, e.name, e.event_date, e.location, e.description,
             e.total_capacity, e.confirmed_count, e.available_slots,
             e.registration_fee_cents, e.status, e.image_url,
             (e.image_blob IS NOT NULL) AS has_image,
             e.waitlist_enabled, e.opened_at, e.created_at, e.updated_at,
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
    // Select explicit columns + a has_image flag rather than `*` so the (potentially
    // large) image_blob bytea is never pulled into a row used purely for rendering.
    const rows = await sql`
      SELECT event_id, name, event_date, location, description,
             total_capacity, confirmed_count, available_slots,
             registration_fee_cents, status, image_url,
             (image_blob IS NOT NULL) AS has_image,
             waitlist_enabled, opened_at, created_at, updated_at
      FROM events WHERE event_id = ${eventId}::UUID`;
    return (rows[0] as unknown as AdminEventRow) ?? null;
  },

  /**
   * Persist an uploaded graphic (D1). A stored blob is the single source of
   * truth for the image, so setting one also clears image_url — the storefront
   * precedence (blob > url) then has nothing to disagree with.
   */
  async setImageBlob(eventId: string, buffer: Buffer, mime: string): Promise<void> {
    await sql`
      UPDATE events
      SET image_blob = ${buffer}, image_mime = ${mime}, image_url = NULL, updated_at = now()
      WHERE event_id = ${eventId}::UUID`;
  },

  /** Remove an uploaded graphic, leaving image_url as the admin set it. */
  async clearImageBlob(eventId: string): Promise<void> {
    await sql`
      UPDATE events
      SET image_blob = NULL, image_mime = NULL, updated_at = now()
      WHERE event_id = ${eventId}::UUID`;
  },

  /** Fetch the stored graphic bytes + server-derived mime for the serve route. */
  async getImageBlob(eventId: string): Promise<{ blob: Buffer; mime: string } | null> {
    const rows = await sql<{ image_blob: Buffer | null; image_mime: string | null }[]>`
      SELECT image_blob, image_mime FROM events WHERE event_id = ${eventId}::UUID`;
    const row = rows[0];
    if (!row || !row.image_blob || !row.image_mime) return null;
    return { blob: Buffer.from(row.image_blob), mime: row.image_mime };
  },

  /** Count of CONFIRMED registrations — what a bulk refund would actually act on. */
  async countConfirmedRegistrations(eventId: string): Promise<number> {
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM registrations WHERE event_id = ${eventId}::UUID AND status = 'CONFIRMED'`;
    return rows[0]?.n ?? 0;
  },

  /** Direct status write (used by the zero-refund cancel short-circuit). */
  async setStatus(eventId: string, status: string): Promise<void> {
    await sql`UPDATE events SET status = ${status}, updated_at = now() WHERE event_id = ${eventId}::UUID`;
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
