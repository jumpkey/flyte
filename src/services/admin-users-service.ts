import { sql } from './db.js';
import type { SortState } from '../web/utils/table-sort.js';

/**
 * Admin user management reads (I8, WF-13/WF-14). Read-only here; lock/unlock
 * writes go through user-service + session revocation in the controller (S7).
 */

export interface UsersPage {
  rows: Array<Record<string, unknown>>;
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
  sort: SortState;
}

/**
 * Map a validated (key, dir) to a HARDCODED sql fragment — every branch is a
 * constant, so nothing client-supplied reaches SQL. `reg_count` is a SELECT
 * alias defined in list(). Composes with the surrounding query (C1, security).
 */
function usersOrderBy(s: SortState) {
  const asc = s.dir === 'ASC';
  switch (s.key) {
    case 'email':         return asc ? sql`u.email ASC`        : sql`u.email DESC`;
    case 'name':          return asc ? sql`u.display_name ASC` : sql`u.display_name DESC`;
    case 'registrations': return asc ? sql`reg_count ASC`      : sql`reg_count DESC`;
    case 'joined':
    default:              return asc ? sql`u.created_at ASC`   : sql`u.created_at DESC`;
  }
}

export const adminUsersService = {
  /** Search (email/name) + filter (account_status, locked), with a purchase count. Paged + sortable. */
  async list(opts: { q?: string; status?: string; locked?: string; page?: number; perPage?: number; sort: SortState }): Promise<UsersPage> {
    const perPage = Math.min(Math.max(opts.perPage ?? 25, 1), 100);
    const page = Math.max(opts.page ?? 1, 1);
    const offset = (page - 1) * perPage;

    const q = opts.q && opts.q.trim() ? `%${opts.q.trim()}%` : null;
    const status = opts.status === 'shadow' || opts.status === 'active' ? opts.status : null;
    const lockedFilter = opts.locked === 'true' ? true : opts.locked === 'false' ? false : null;

    const where = sql`
      (${q}::text IS NULL OR u.email ILIKE ${q} OR u.display_name ILIKE ${q})
      AND (${status}::text IS NULL OR u.account_status = ${status})
      AND (${lockedFilter}::boolean IS NULL OR u.is_locked = ${lockedFilter})
    `;

    const countRows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users u WHERE ${where}`;
    const total = countRows[0]?.n ?? 0;

    const rows = await sql`
      SELECT u.id, u.email, u.display_name, u.account_status, u.is_admin, u.is_locked, u.is_verified, u.created_at,
             (SELECT count(*)::int FROM registrations r WHERE r.user_id = u.id) AS registration_count,
             (SELECT count(*)::int FROM registrations r WHERE r.user_id = u.id) AS reg_count
      FROM users u
      WHERE ${where}
      ORDER BY ${usersOrderBy(opts.sort)}
      LIMIT ${perPage} OFFSET ${offset}
    `;

    return {
      rows: rows as unknown as Array<Record<string, unknown>>,
      total, page, perPage,
      totalPages: Math.max(Math.ceil(total / perPage), 1),
      sort: opts.sort,
    };
  },

  async getProfile(userId: string): Promise<Record<string, unknown> | null> {
    const rows = await sql`SELECT id, email, display_name, account_status, is_admin, is_locked, is_verified, created_at, last_login_at FROM users WHERE id = ${userId}::UUID`;
    return (rows[0] as Record<string, unknown>) ?? null;
  },

  /** Everything the WF-14 detail page shows for one user. */
  async getDetail(userId: string): Promise<{
    purchases: Array<Record<string, unknown>>;
    waitlist: Array<Record<string, unknown>>;
  }> {
    // Login + action history used to live here; the user-detail page now shows a
    // single paginated activity timeline (getTimeline, D2), so those two queries
    // were dead weight and are gone. Only the at-a-glance summary panels remain.
    const [purchases, waitlist] = await Promise.all([
      sql`SELECT r.registration_id, r.status, r.gross_amount_cents, r.refunded_amount_cents, r.created_at, e.name AS event_name
          FROM registrations r JOIN events e ON e.event_id = r.event_id
          WHERE r.user_id = ${userId}::UUID ORDER BY r.created_at DESC`,
      sql`SELECT w.waitlist_entry_id, e.name AS event_name, w.created_at
          FROM waitlist_entries w JOIN events e ON e.event_id = w.event_id
          WHERE w.user_id = ${userId}::UUID ORDER BY w.created_at DESC`,
    ]);
    return {
      purchases: purchases as unknown as Array<Record<string, unknown>>,
      waitlist: waitlist as unknown as Array<Record<string, unknown>>,
    };
  },

  /**
   * Unified, paginated activity timeline (Batch D2): one chronological feed —
   * newest first — unioning account creation, logins, registrations, refunds,
   * waitlist joins, and admin/user actions for a single user. Replaces the old
   * unbounded login + action history lists. Everything is parameterized on
   * ${userId}; the UNION ALL branches line up column types via explicit casts.
   */
  async getTimeline(userId: string, page: number, perPage: number): Promise<{
    rows: Array<Record<string, unknown>>;
    total: number;
    page: number;
    perPage: number;
    totalPages: number;
  }> {
    const pp = Math.min(Math.max(perPage, 1), 100);
    const pg = Math.max(page, 1);
    const offset = (pg - 1) * pp;

    // The common UNION shape used by both the count and the page query.
    const union = sql`
      SELECT u.created_at AS at, 'account' AS kind, 'Account created' AS title,
             u.email::text AS detail, NULL::int AS amount_cents, u.account_status::text AS status
        FROM users u WHERE u.id = ${userId}::UUID
      UNION ALL
      SELECT le.created_at, 'login',
             CASE WHEN le.success THEN 'Signed in' ELSE 'Failed sign-in' END,
             COALESCE(le.ip_address::text, ''), NULL::int, COALESCE(le.failure_reason, '')
        FROM login_events le WHERE le.user_id = ${userId}::UUID
      UNION ALL
      SELECT r.created_at, 'registration', e.name::text, r.status::text,
             r.gross_amount_cents, r.status::text
        FROM registrations r JOIN events e ON e.event_id = r.event_id
        WHERE r.user_id = ${userId}::UUID
      UNION ALL
      SELECT rl.created_at, 'refund', e.name::text, rl.refund_type::text,
             rl.amount_cents, NULL::text
        FROM refund_log rl
        JOIN registrations r ON r.registration_id = rl.registration_id
        JOIN events e ON e.event_id = rl.event_id
        WHERE r.user_id = ${userId}::UUID
      UNION ALL
      SELECT w.created_at, 'waitlist', e.name::text, 'Joined waitlist', NULL::int, NULL::text
        FROM waitlist_entries w JOIN events e ON e.event_id = w.event_id
        WHERE w.user_id = ${userId}::UUID
      UNION ALL
      SELECT ae.created_at, 'action', ae.action::text, '', NULL::int, NULL::text
        FROM user_action_events ae WHERE ae.user_id = ${userId}::UUID
    `;

    const countRows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM (${union}) t`;
    const total = countRows[0]?.n ?? 0;

    const rows = await sql`
      SELECT * FROM (${union}) t
      ORDER BY t.at DESC
      LIMIT ${pp} OFFSET ${offset}
    `;

    return {
      rows: rows as unknown as Array<Record<string, unknown>>,
      total, page: pg, perPage: pp,
      totalPages: Math.max(Math.ceil(total / pp), 1),
    };
  },
};
