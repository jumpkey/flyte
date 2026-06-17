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
    loginHistory: Array<Record<string, unknown>>;
    actionHistory: Array<Record<string, unknown>>;
  }> {
    const [purchases, waitlist, loginHistory, actionHistory] = await Promise.all([
      sql`SELECT r.registration_id, r.status, r.gross_amount_cents, r.refunded_amount_cents, r.created_at, e.name AS event_name
          FROM registrations r JOIN events e ON e.event_id = r.event_id
          WHERE r.user_id = ${userId}::UUID ORDER BY r.created_at DESC`,
      sql`SELECT w.waitlist_entry_id, e.name AS event_name, w.created_at
          FROM waitlist_entries w JOIN events e ON e.event_id = w.event_id
          WHERE w.user_id = ${userId}::UUID ORDER BY w.created_at DESC`,
      sql`SELECT success, failure_reason, ip_address, created_at FROM login_events
          WHERE user_id = ${userId}::UUID ORDER BY created_at DESC LIMIT 25`,
      sql`SELECT action, resource, ip_address, created_at FROM user_action_events
          WHERE user_id = ${userId}::UUID ORDER BY created_at DESC LIMIT 25`,
    ]);
    return {
      purchases: purchases as unknown as Array<Record<string, unknown>>,
      waitlist: waitlist as unknown as Array<Record<string, unknown>>,
      loginHistory: loginHistory as unknown as Array<Record<string, unknown>>,
      actionHistory: actionHistory as unknown as Array<Record<string, unknown>>,
    };
  },
};
