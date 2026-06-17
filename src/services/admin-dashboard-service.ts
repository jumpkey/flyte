import { sql } from './db.js';

/**
 * Admin dashboard KPIs + attention panel (I5, WF-07; addendum A5). Money figures
 * are confirmed-gross over a trailing window so they reconcile with the
 * transaction log's totals.
 */

export interface DashboardData {
  grossRevenue30dCents: number;
  confirmedRegistrations30d: number;
  upcomingEvents: number;
  pendingRefundRequests: number;
  // Attention panel (A5)
  paymentFailed7d: number;
  recentTransactions: Array<Record<string, unknown>>;
  recentSignins: Array<Record<string, unknown>>;
}

export const adminDashboardService = {
  async getDashboard(): Promise<DashboardData> {
    const [kpis, recentTx, recentSignins] = await Promise.all([
      sql<{
        gross_30d: string | null; confirmed_30d: number; upcoming: number;
        pending_requests: number; failed_7d: number;
      }[]>`
        SELECT
          (SELECT COALESCE(SUM(gross_amount_cents),0) FROM registrations
             WHERE status = 'CONFIRMED' AND confirmed_at >= now() - interval '30 days')        AS gross_30d,
          (SELECT count(*)::int FROM registrations
             WHERE status = 'CONFIRMED' AND confirmed_at >= now() - interval '30 days')         AS confirmed_30d,
          (SELECT count(*)::int FROM events
             WHERE status = 'OPEN' AND event_date > now())                                       AS upcoming,
          (SELECT count(*)::int FROM refund_requests WHERE status = 'REQUESTED')                 AS pending_requests,
          (SELECT count(*)::int FROM registrations
             WHERE status = 'PAYMENT_FAILED' AND updated_at >= now() - interval '7 days')        AS failed_7d
      `,
      sql`
        SELECT r.registration_id, r.created_at, r.email, r.first_name, r.last_name,
               r.status, r.gross_amount_cents, e.name AS event_name
        FROM registrations r JOIN events e ON e.event_id = r.event_id
        ORDER BY r.created_at DESC LIMIT 10
      `,
      sql`
        SELECT email_attempted, success, created_at, ip_address
        FROM login_events
        ORDER BY created_at DESC LIMIT 10
      `,
    ]);

    const k = kpis[0];
    return {
      grossRevenue30dCents: parseInt(k?.gross_30d ?? '0', 10) || 0,
      confirmedRegistrations30d: k?.confirmed_30d ?? 0,
      upcomingEvents: k?.upcoming ?? 0,
      pendingRefundRequests: k?.pending_requests ?? 0,
      paymentFailed7d: k?.failed_7d ?? 0,
      recentTransactions: recentTx as unknown as Array<Record<string, unknown>>,
      recentSignins: recentSignins as unknown as Array<Record<string, unknown>>,
    };
  },
};
