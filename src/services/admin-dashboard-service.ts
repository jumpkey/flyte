import { sql } from './db.js';
import { computeProjection } from './analytics-projection.js';

/**
 * Admin dashboard KPIs + attention panel (I5, WF-07; addendum A5). Money figures
 * are confirmed-gross over a trailing window so they reconcile with the
 * transaction log's totals.
 */

export type AttentionSeverity = 'danger' | 'warning' | 'info';
export interface AttentionItem {
  severity: AttentionSeverity;
  text: string;
  href: string;
}

export interface DashboardData {
  grossRevenue30dCents: number;
  confirmedRegistrations30d: number;
  upcomingEvents: number;
  pendingRefundRequests: number;
  // Attention panel (A5) — a prioritized, deep-linked trigger list; empty = calm.
  attention: AttentionItem[];
  recentTransactions: Array<Record<string, unknown>>;
  recentSignins: Array<Record<string, unknown>>;
}

function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const adminDashboardService = {
  async getDashboard(): Promise<DashboardData> {
    const [counts, atRiskRows, recentTx, recentSignins] = await Promise.all([
      sql<{
        gross_30d: string | null; confirmed_30d: number; upcoming: number;
        pending_requests: number; failed_7d: number; unsent_receipts: number;
        stuck_capture: number; drafts_soon: number; events_next_7d: number;
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
             WHERE status = 'PAYMENT_FAILED' AND updated_at >= now() - interval '7 days')        AS failed_7d,
          (SELECT count(*)::int FROM registrations
             WHERE status = 'CONFIRMED' AND confirmation_email_sent_at IS NULL
               AND confirmed_at < now() - interval '1 hour')                                      AS unsent_receipts,
          (SELECT count(*)::int FROM registrations
             WHERE status = 'PENDING_CAPTURE' AND created_at < now() - interval '2 hours')        AS stuck_capture,
          (SELECT count(*)::int FROM events
             WHERE status = 'DRAFT' AND event_date >= now() AND event_date < now() + interval '14 days') AS drafts_soon,
          (SELECT count(*)::int FROM events
             WHERE status = 'OPEN' AND event_date >= now() AND event_date < now() + interval '7 days')    AS events_next_7d
      `,
      // OPEN upcoming events + trailing-7d confirmations → projection band (A2).
      sql<{
        total_capacity: number; confirmed_count: number; available_slots: number;
        opened_at: Date | null; created_at: Date; event_date: Date; recent: number;
      }[]>`
        SELECT e.total_capacity, e.confirmed_count, e.available_slots,
               e.opened_at, e.created_at, e.event_date,
               COALESCE(v.n, 0)::int AS recent
        FROM events e
        LEFT JOIN (
          SELECT event_id, count(*) AS n FROM registrations
          WHERE status = 'CONFIRMED' AND confirmed_at >= now() - interval '7 days'
          GROUP BY event_id
        ) v ON v.event_id = e.event_id
        WHERE e.status = 'OPEN' AND e.event_date > now()
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

    const c = counts[0];
    const pendingRefundRequests = c?.pending_requests ?? 0;
    const failed7d = c?.failed_7d ?? 0;
    const unsentReceipts = c?.unsent_receipts ?? 0;
    const stuckCapture = c?.stuck_capture ?? 0;
    const draftsSoon = c?.drafts_soon ?? 0;
    const eventsNext7d = c?.events_next_7d ?? 0;

    // A2 AT-RISK count: feed each OPEN upcoming event through the projection.
    const now = new Date();
    const atRiskEvents = atRiskRows.filter((e) => {
      const projection = computeProjection({
        openedAt: (e.opened_at as Date | null) ?? (e.created_at as Date),
        eventDate: e.event_date as Date,
        capacity: e.total_capacity,
        confirmed: e.confirmed_count,
        availableSlots: e.available_slots,
        velocity: e.recent / 7,
        now,
      });
      return projection.band === 'AT_RISK';
    }).length;

    // Build the attention list in priority order (most urgent first); each entry
    // is deep-linked. An empty list renders as the calm "all clear" state.
    const attention: AttentionItem[] = [];
    if (stuckCapture > 0) attention.push({ severity: 'danger', text: `${plural(stuckCapture, 'payment')} stuck in capture over 2h`, href: '/admin/registrations?status=PENDING_CAPTURE' });
    if (pendingRefundRequests > 0) attention.push({ severity: 'danger', text: `${plural(pendingRefundRequests, 'pending refund request')}`, href: '/admin/refund-requests' });
    if (failed7d > 0) attention.push({ severity: 'danger', text: `${plural(failed7d, 'failed payment')} (7d)`, href: '/admin/registrations?status=PAYMENT_FAILED' });
    if (unsentReceipts > 0) attention.push({ severity: 'warning', text: `${plural(unsentReceipts, 'receipt')} unsent over 1h`, href: '/admin/registrations?status=CONFIRMED' });
    if (atRiskEvents > 0) attention.push({ severity: 'warning', text: `${plural(atRiskEvents, 'event')} at risk of underselling`, href: '/admin/analytics' });
    if (draftsSoon > 0) attention.push({ severity: 'warning', text: `${plural(draftsSoon, 'draft')} with an event date within 14 days`, href: '/admin/events' });
    if (eventsNext7d > 0) attention.push({ severity: 'info', text: `${plural(eventsNext7d, 'event')} in the next 7 days`, href: '/admin/events' });

    return {
      grossRevenue30dCents: parseInt(c?.gross_30d ?? '0', 10) || 0,
      confirmedRegistrations30d: c?.confirmed_30d ?? 0,
      upcomingEvents: c?.upcoming ?? 0,
      pendingRefundRequests,
      attention,
      recentTransactions: recentTx as unknown as Array<Record<string, unknown>>,
      recentSignins: recentSignins as unknown as Array<Record<string, unknown>>,
    };
  },
};
