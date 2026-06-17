import { sql } from './db.js';

/**
 * Storefront read model for the public event catalog (I2). Separate from
 * event-service.ts, which is the audit-event logger — this owns domain reads of
 * the `events` table for the public storefront. DRAFT and CANCELLED events are
 * never returned here; visibility is the storefront's job, not the caller's.
 */

export interface CatalogEvent {
  event_id: string;
  name: string;
  description: string | null;
  event_date: Date;
  location: string | null;
  total_capacity: number;
  available_slots: number;
  registration_fee_cents: number;
  status: string;
  image_url: string | null;
  waitlist_enabled: boolean;
}

const PUBLIC_COLUMNS = sql`
  event_id, name, description, event_date, location,
  total_capacity, available_slots, registration_fee_cents,
  status, image_url, waitlist_enabled
`;

export interface CatalogPage {
  events: CatalogEvent[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
}

export const catalogService = {
  /** Home page: up to `limit` soonest OPEN upcoming events (AC-I2 ①). */
  async listHomeEvents(limit = 6): Promise<CatalogEvent[]> {
    const rows = await sql`
      SELECT ${PUBLIC_COLUMNS}
      FROM events
      WHERE status = 'OPEN' AND event_date > now()
      ORDER BY event_date ASC
      LIMIT ${limit}
    `;
    return rows as unknown as CatalogEvent[];
  },

  /**
   * Catalog (/events): upcoming OPEN/FULL/CLOSED events, soonest first, with an
   * optional text search (name/location) and month filter, paginated. DRAFT and
   * CANCELLED never appear. `month` is 'YYYY-MM'.
   */
  async listCatalog(opts: { q?: string; month?: string; page?: number; perPage?: number; when?: 'upcoming' | 'past' } = {}): Promise<CatalogPage> {
    const perPage = Math.min(Math.max(opts.perPage ?? 12, 1), 48);
    const page = Math.max(opts.page ?? 1, 1);
    const offset = (page - 1) * perPage;
    const past = opts.when === 'past';

    const q = (opts.q ?? '').trim();
    const like = q ? `%${q}%` : null;

    // Month filter → [start, nextMonth) range, NULL when absent or malformed.
    let monthStart: string | null = null;
    let monthEnd: string | null = null;
    if (opts.month && /^\d{4}-\d{2}$/.test(opts.month)) {
      monthStart = `${opts.month}-01`;
      const [y, m] = opts.month.split('-').map(Number);
      const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      monthEnd = `${next}-01`;
    }

    // Upcoming (default): future OPEN/FULL/CLOSED, soonest first. Past (V5): events
    // whose date has passed — gives CLOSED events a dignified permanent home —
    // most-recent first. DRAFT and CANCELLED never appear either way.
    const where = sql`
      status IN ('OPEN', 'FULL', 'CLOSED')
      AND (${past} = (event_date <= now()))
      AND (${like}::text IS NULL OR name ILIKE ${like} OR location ILIKE ${like})
      AND (${monthStart}::timestamptz IS NULL OR event_date >= ${monthStart}::timestamptz)
      AND (${monthEnd}::timestamptz IS NULL OR event_date < ${monthEnd}::timestamptz)
    `;

    const countRows = await sql`SELECT count(*)::int AS n FROM events WHERE ${where}`;
    const total = (countRows[0]?.n as number) ?? 0;

    const rows = past
      ? await sql`SELECT ${PUBLIC_COLUMNS} FROM events WHERE ${where} ORDER BY event_date DESC LIMIT ${perPage} OFFSET ${offset}`
      : await sql`SELECT ${PUBLIC_COLUMNS} FROM events WHERE ${where} ORDER BY event_date ASC LIMIT ${perPage} OFFSET ${offset}`;

    return {
      events: rows as unknown as CatalogEvent[],
      total,
      page,
      perPage,
      totalPages: Math.max(Math.ceil(total / perPage), 1),
    };
  },

  /** Public event detail. Returns null for missing, DRAFT, or CANCELLED events. */
  async getPublicEvent(eventId: string): Promise<CatalogEvent | null> {
    const rows = await sql`
      SELECT ${PUBLIC_COLUMNS}
      FROM events
      WHERE event_id = ${eventId} AND status NOT IN ('DRAFT', 'CANCELLED')
    `;
    return (rows[0] as unknown as CatalogEvent) ?? null;
  },

  /**
   * Whether a logged-in user already holds an active (non-terminal) registration
   * for this event — drives the "You're registered ✓" detail state. Mirrors the
   * engine's active-registration definition (migration 006).
   */
  async hasActiveRegistration(eventId: string, userId: string): Promise<boolean> {
    const rows = await sql`
      SELECT 1 FROM registrations
      WHERE event_id = ${eventId} AND user_id = ${userId}
        AND status NOT IN ('PAYMENT_FAILED', 'EXPIRED', 'CANCELLED')
      LIMIT 1
    `;
    return rows.length > 0;
  },
};
