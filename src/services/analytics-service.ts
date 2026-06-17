import { sql } from './db.js';
import { computeProjection, type Projection } from './analytics-projection.js';

/**
 * Analytics reads (I10, WF-17/WF-18). Everything derives from data I1–I5 already
 * record — registration timestamps/statuses, refund_log, opened_at, audit
 * metadata — so booking curves are real from launch (the point of §5).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SalesKpis {
  grossCents: number; netCents: number; refundedCents: number;
  confirmedCount: number; aovCents: number; refundRatePct: number;
  grossDeltaPct: number | null;
}

export interface SalesDashboard {
  rangeDays: number;
  kpis: SalesKpis;
  dailyRevenue: number[];           // net cents per day
  paymentFunnel: { stages: Array<{ label: string; count: number }>; conversions: number[]; lostExpiredCents: number; lostFailedCents: number };
  perEvent: Array<Record<string, unknown>>;
  customers: { newBuyers: number; returningBuyers: number; repeatRatePct: number; activationRatePct: number; top: Array<Record<string, unknown>> };
}

/**
 * W17 — gross and refunds over the SAME population: registrations confirmed in
 * the period (confirmed_at in window, regardless of current status). A
 * fully-refunded sale is now CANCELLED but keeps confirmed_at set, so it counts
 * toward both gross and refunds. refunded_amount_cents is always ≤ gross, so
 * net = gross − refunded ≥ 0 and refund-rate = refunded/gross ≤ 100%.
 */
async function periodTotals(fromDays: number, toDays: number): Promise<{ gross: number; refunded: number; count: number }> {
  const rows = await sql<{ gross: string | null; refunded: string | null; count: number }[]>`
    SELECT COALESCE(SUM(gross_amount_cents),0) AS gross,
           COALESCE(SUM(refunded_amount_cents),0) AS refunded,
           COUNT(*)::int AS count
    FROM registrations
    WHERE confirmed_at IS NOT NULL
      AND confirmed_at >= now() - (${toDays}||' days')::interval
      AND confirmed_at <  now() - (${fromDays}||' days')::interval`;
  const r = rows[0];
  return { gross: +(r?.gross ?? 0), refunded: +(r?.refunded ?? 0), count: r?.count ?? 0 };
}

export const analyticsService = {
  /**
   * W18 — record one storefront view of an event (per-day counter upsert). Called
   * fire-and-forget from the detail route, so it must never throw into the
   * request path; the caller swallows rejections.
   */
  async recordEventView(eventId: string): Promise<void> {
    await sql`
      INSERT INTO page_views (event_id, view_date, views)
      VALUES (${eventId}::UUID, CURRENT_DATE, 1)
      ON CONFLICT (event_id, view_date) DO UPDATE SET views = page_views.views + 1`;
  },

  /** Total storefront views across all events in the trailing window (A1 view stage). */
  async viewsInRange(rangeDays: number): Promise<number> {
    const rows = await sql<{ n: string | null }[]>`
      SELECT COALESCE(SUM(views), 0)::text AS n FROM page_views
      WHERE view_date >= (CURRENT_DATE - (${rangeDays - 1}||' days')::interval)`;
    return +(rows[0]?.n ?? 0);
  },

  /** Lifetime storefront views for one event (A2). */
  async viewsByEvent(eventId: string): Promise<number> {
    const rows = await sql<{ n: string | null }[]>`
      SELECT COALESCE(SUM(views), 0)::text AS n FROM page_views WHERE event_id = ${eventId}::UUID`;
    return +(rows[0]?.n ?? 0);
  },

  async getSalesDashboard(rangeDays: number): Promise<SalesDashboard> {
    const cur = await periodTotals(0, rangeDays);
    const prev = await periodTotals(rangeDays, rangeDays * 2);

    const netBusiness = cur.gross - cur.refunded;
    const kpis: SalesKpis = {
      grossCents: cur.gross,
      netCents: netBusiness,
      refundedCents: cur.refunded,
      confirmedCount: cur.count,
      aovCents: cur.count > 0 ? Math.round(cur.gross / cur.count) : 0,
      refundRatePct: cur.gross > 0 ? Math.round((cur.refunded / cur.gross) * 1000) / 10 : 0,
      grossDeltaPct: prev.gross > 0 ? Math.round(((cur.gross - prev.gross) / prev.gross) * 1000) / 10 : null,
    };

    // W19 — Daily net revenue series, oldest → newest, gap-filled. Net per day =
    // confirmed-or-was-confirmed gross captured that day minus refunds dated that
    // day (refund_log.amount_cents on that calendar day).
    const dailyRows = await sql<{ net: string }[]>`
      SELECT (COALESCE(g.gross, 0) - COALESCE(rl.refunded, 0))::text AS net
      FROM generate_series(date_trunc('day', now()) - (${rangeDays - 1}||' days')::interval,
                           date_trunc('day', now()), '1 day') AS series(day)
      LEFT JOIN LATERAL (
        SELECT date_trunc('day', r.confirmed_at) AS day, SUM(r.gross_amount_cents) AS gross
        FROM registrations r
        WHERE r.confirmed_at IS NOT NULL
          AND (r.status = 'CONFIRMED' OR r.confirmed_at IS NOT NULL)
          AND date_trunc('day', r.confirmed_at) = series.day
        GROUP BY 1
      ) g ON TRUE
      LEFT JOIN LATERAL (
        SELECT date_trunc('day', l.created_at) AS day, SUM(l.amount_cents) AS refunded
        FROM refund_log l
        WHERE date_trunc('day', l.created_at) = series.day
        GROUP BY 1
      ) rl ON TRUE
      ORDER BY series.day ASC`;
    const dailyRevenue = dailyRows.map((r) => +r.net);

    // W19 — Payment funnel (registrations created in range) + a top Views stage.
    const views = await this.viewsInRange(rangeDays);
    const funnelRows = await sql<{ status: string; n: number; fee: string; captured: number; authorized: number }[]>`
      SELECT status, count(*)::int AS n, COALESCE(SUM(gross_amount_cents),0)::text AS fee,
             count(*) FILTER (WHERE confirmed_at IS NOT NULL)::int AS captured,
             count(*) FILTER (WHERE status IN ('PENDING_CAPTURE','CONFIRMED') OR confirmed_at IS NOT NULL)::int AS authorized
      FROM registrations WHERE created_at >= now() - (${rangeDays}||' days')::interval
      GROUP BY status`;
    const byStatus = (s: string) => funnelRows.find((r) => r.status === s)?.n ?? 0;
    const feeOf = (s: string) => +(funnelRows.find((r) => r.status === s)?.fee ?? 0);
    const initiated = funnelRows.reduce((a, r) => a + r.n, 0);
    const authorized = funnelRows.reduce((a, r) => a + r.authorized, 0);
    const captured = funnelRows.reduce((a, r) => a + r.captured, 0);
    const stages = [
      { label: 'Views', count: views },
      { label: 'Initiated', count: initiated },
      { label: 'Authorized', count: authorized },
      { label: 'Captured', count: captured },
      { label: 'Confirmed', count: byStatus('CONFIRMED') },
    ];
    const conversions = stages.slice(1).map((s, i) => {
      const prev = stages[i].count;
      return prev > 0 ? Math.round((s.count / prev) * 100) : 0;
    });
    const paymentFunnel = {
      stages,
      conversions,
      lostExpiredCents: feeOf('EXPIRED') + feeOf('PENDING_PAYMENT'),
      lostFailedCents: feeOf('PAYMENT_FAILED'),
    };

    // Per-event table. W17 — gross AND refunded over the same confirmed-or-was-
    // confirmed population so the row's refund% can never exceed 100%.
    const perEvent = await sql`
      SELECT e.event_id, e.name, e.status, e.total_capacity, e.confirmed_count,
             COALESCE(SUM(r.gross_amount_cents) FILTER (WHERE r.status='CONFIRMED' OR r.confirmed_at IS NOT NULL),0)::int AS gross,
             COALESCE(SUM(r.refunded_amount_cents) FILTER (WHERE r.status='CONFIRMED' OR r.confirmed_at IS NOT NULL),0)::int AS refunded,
             e.opened_at
      FROM events e LEFT JOIN registrations r ON r.event_id = e.event_id
      WHERE e.status <> 'DRAFT'
      GROUP BY e.event_id ORDER BY e.event_date DESC LIMIT 50`;

    // A4 customers.
    const buyerRows = await sql<{ user_id: string; n: number; net: string; account_status: string }[]>`
      SELECT r.user_id, count(*)::int AS n, COALESCE(SUM(r.net_amount_cents),0)::text AS net, u.account_status
      FROM registrations r JOIN users u ON u.id = r.user_id
      WHERE r.status='CONFIRMED' AND r.user_id IS NOT NULL
      GROUP BY r.user_id, u.account_status`;
    const totalBuyers = buyerRows.length;
    const returningBuyers = buyerRows.filter((b) => b.n > 1).length;
    const activeBuyers = buyerRows.filter((b) => b.account_status === 'active').length;
    const top = await sql`
      SELECT u.email, u.account_status, COALESCE(SUM(r.net_amount_cents),0)::int AS lifetime_net, count(*)::int AS purchases
      FROM registrations r JOIN users u ON u.id = r.user_id
      WHERE r.status='CONFIRMED' AND r.user_id IS NOT NULL
      GROUP BY u.id ORDER BY lifetime_net DESC LIMIT 5`;

    return {
      rangeDays, kpis, dailyRevenue, paymentFunnel,
      perEvent: perEvent as unknown as Array<Record<string, unknown>>,
      customers: {
        newBuyers: totalBuyers - returningBuyers,
        returningBuyers,
        repeatRatePct: totalBuyers > 0 ? Math.round((returningBuyers / totalBuyers) * 1000) / 10 : 0,
        activationRatePct: totalBuyers > 0 ? Math.round((activeBuyers / totalBuyers) * 1000) / 10 : 0,
        top: top as unknown as Array<Record<string, unknown>>,
      },
    };
  },

  /** Velocity (regs/day, trailing 7d) per event — for the events-list pace column (A3). */
  async velocityByEvent(): Promise<Record<string, number>> {
    const rows = await sql<{ event_id: string; n: number }[]>`
      SELECT event_id, count(*)::int AS n FROM registrations
      WHERE status='CONFIRMED' AND confirmed_at >= now() - interval '7 days'
      GROUP BY event_id`;
    const map: Record<string, number> = {};
    for (const r of rows) map[r.event_id] = r.n / 7;
    return map;
  },

  /** A2 — one event's booking curve, velocity, and projection. */
  async getEventPerformance(eventId: string): Promise<{
    event: Record<string, unknown>;
    projection: Projection;
    cumulative: number[];
    dailyBookings: number[];
    movingAvg: number[];
    currentVelocity: number;
    waitlistDepth: number;
    refundsCount: number;
    views: number;
    revenue: { grossCents: number; refundedCents: number; netCents: number };
  } | null> {
    const evRows = await sql`SELECT * FROM events WHERE event_id = ${eventId}::UUID`;
    if (evRows.length === 0) return null;
    const ev = evRows[0] as Record<string, unknown>;

    const openedAt = (ev.opened_at as Date | null) ?? (ev.created_at as Date);
    const eventDate = ev.event_date as Date;
    const now = new Date();
    const endDay = new Date(Math.min(now.getTime(), eventDate.getTime()));

    const confRows = await sql<{ confirmed_at: Date }[]>`
      SELECT confirmed_at FROM registrations WHERE event_id = ${eventId}::UUID AND status='CONFIRMED' AND confirmed_at IS NOT NULL ORDER BY confirmed_at ASC`;

    // Daily buckets opened_at → endDay.
    const startDay = new Date(new Date(openedAt).setHours(0, 0, 0, 0));
    const days = Math.max(1, Math.ceil((endDay.getTime() - startDay.getTime()) / DAY_MS) + 1);
    const dailyBookings = new Array(Math.min(days, 365)).fill(0);
    for (const r of confRows) {
      const idx = Math.floor((new Date(r.confirmed_at).getTime() - startDay.getTime()) / DAY_MS);
      if (idx >= 0 && idx < dailyBookings.length) dailyBookings[idx]++;
    }
    const cumulative: number[] = [];
    dailyBookings.reduce((acc, v) => { const c = acc + v; cumulative.push(c); return c; }, 0);

    // 7-day moving average.
    const movingAvg = dailyBookings.map((_, i) => {
      const from = Math.max(0, i - 6);
      const slice = dailyBookings.slice(from, i + 1);
      return slice.reduce((a, b) => a + b, 0) / slice.length;
    });

    // Velocity over min(7, days_on_sale).
    const daysOnSale = Math.max(1, (now.getTime() - new Date(openedAt).getTime()) / DAY_MS);
    const windowDays = Math.min(7, daysOnSale);
    const windowStart = now.getTime() - windowDays * DAY_MS;
    const inWindow = confRows.filter((r) => new Date(r.confirmed_at).getTime() >= windowStart).length;
    const currentVelocity = inWindow / windowDays;

    const projection = computeProjection({
      openedAt: new Date(openedAt), eventDate,
      capacity: ev.total_capacity as number, confirmed: ev.confirmed_count as number,
      availableSlots: ev.available_slots as number, velocity: currentVelocity, now,
    });

    const wl = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM waitlist_entries WHERE event_id=${eventId}::UUID`;
    const rf = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM refund_log WHERE event_id=${eventId}::UUID`;

    // W21 — lifetime views + event revenue (gross AND refunded over the same
    // confirmed-or-was-confirmed population → net ≥ 0).
    const views = await this.viewsByEvent(eventId);
    const revRows = await sql<{ gross: string | null; refunded: string | null }[]>`
      SELECT COALESCE(SUM(gross_amount_cents) FILTER (WHERE status='CONFIRMED' OR confirmed_at IS NOT NULL),0)::text AS gross,
             COALESCE(SUM(refunded_amount_cents) FILTER (WHERE status='CONFIRMED' OR confirmed_at IS NOT NULL),0)::text AS refunded
      FROM registrations WHERE event_id = ${eventId}::UUID`;
    const grossCents = +(revRows[0]?.gross ?? 0);
    const refundedCents = +(revRows[0]?.refunded ?? 0);

    return {
      event: ev, projection, cumulative, dailyBookings, movingAvg,
      currentVelocity, waitlistDepth: wl[0]?.n ?? 0, refundsCount: rf[0]?.n ?? 0,
      views,
      revenue: { grossCents, refundedCents, netCents: grossCents - refundedCents },
    };
  },
};
