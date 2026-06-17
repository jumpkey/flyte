import { sql } from './db.js';

/**
 * Admin user management reads (I8, WF-13/WF-14). Read-only here; lock/unlock
 * writes go through user-service + session revocation in the controller (S7).
 */

export const adminUsersService = {
  /** Search (email/name) + filter (account_status, locked), with a purchase count. */
  async list(opts: { q?: string; status?: string; locked?: string }): Promise<Array<Record<string, unknown>>> {
    const q = opts.q && opts.q.trim() ? `%${opts.q.trim()}%` : null;
    const status = opts.status === 'shadow' || opts.status === 'active' ? opts.status : null;
    const lockedFilter = opts.locked === 'true' ? true : opts.locked === 'false' ? false : null;

    const rows = await sql`
      SELECT u.id, u.email, u.display_name, u.account_status, u.is_admin, u.is_locked, u.is_verified, u.created_at,
             (SELECT count(*)::int FROM registrations r WHERE r.user_id = u.id) AS registration_count
      FROM users u
      WHERE (${q}::text IS NULL OR u.email ILIKE ${q} OR u.display_name ILIKE ${q})
        AND (${status}::text IS NULL OR u.account_status = ${status})
        AND (${lockedFilter}::boolean IS NULL OR u.is_locked = ${lockedFilter})
      ORDER BY u.created_at DESC
      LIMIT 200
    `;
    return rows as unknown as Array<Record<string, unknown>>;
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
