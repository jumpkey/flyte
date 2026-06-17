import { sql } from './db.js';

/**
 * Unified activity feed (I8, WF — admin/activity) over login_events +
 * user_action_events. Filterable by type (login | action), user email, and date
 * range; 50/page.
 */

export interface ActivityFilters {
  type?: string;     // 'login' | 'action'
  email?: string;
  from?: string;     // YYYY-MM-DD
  to?: string;
  page?: number;
}

export interface ActivityPage {
  rows: Array<Record<string, unknown>>;
  page: number;
  totalPages: number;
  total: number;
}

export const adminActivityService = {
  async list(f: ActivityFilters): Promise<ActivityPage> {
    const perPage = 50;
    const page = Math.max(f.page ?? 1, 1);
    const offset = (page - 1) * perPage;
    const type = f.type === 'login' || f.type === 'action' ? f.type : null;
    const email = f.email && f.email.trim() ? `%${f.email.trim()}%` : null;
    const from = f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from) ? f.from : null;
    const to = f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to) ? f.to : null;

    // Two normalized SELECTs unioned: kind, summary, email, ip, when.
    const unioned = sql`
      SELECT * FROM (
        SELECT 'login' AS kind,
               (CASE WHEN le.success THEN 'Signed in' ELSE 'Failed sign-in' || COALESCE(' (' || le.failure_reason || ')', '') END) AS summary,
               COALESCE(u.email, le.email_attempted) AS email,
               le.ip_address::text AS ip, le.created_at AS at
        FROM login_events le LEFT JOIN users u ON u.id = le.user_id
        WHERE (${type}::text IS NULL OR ${type} = 'login')
        UNION ALL
        SELECT 'action' AS kind, ae.action AS summary, u.email AS email,
               ae.ip_address::text AS ip, ae.created_at AS at
        FROM user_action_events ae JOIN users u ON u.id = ae.user_id
        WHERE (${type}::text IS NULL OR ${type} = 'action')
      ) feed
      WHERE (${email}::text IS NULL OR feed.email ILIKE ${email})
        AND (${from}::date IS NULL OR feed.at >= ${from}::date)
        AND (${to}::date IS NULL OR feed.at < (${to}::date + 1))
    `;

    const countRows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM (${unioned}) c`;
    const total = countRows[0]?.n ?? 0;
    const rows = await sql`SELECT * FROM (${unioned}) f ORDER BY f.at DESC LIMIT ${perPage} OFFSET ${offset}`;
    return { rows: rows as unknown as Array<Record<string, unknown>>, page, total, totalPages: Math.max(Math.ceil(total / perPage), 1) };
  },
};
