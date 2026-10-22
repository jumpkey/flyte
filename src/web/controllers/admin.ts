import { sql } from '../../services/db.js';
import type { Context } from 'hono';
import { renderView } from '../render.js';
import { adminDashboardService } from '../../services/admin-dashboard-service.js';

/**
 * Admin dashboard (WF-07) — the morning-coffee page: money in, registrations,
 * what needs attention. KPI queries land here in I5 (the data they read now
 * exists). The pending-refund-requests banner is wired but stays empty until I6
 * starts creating requests.
 */
export const adminController = {
  async index(c: Context): Promise<Response> {
    const data = await adminDashboardService.getDashboard();
    const recovery = (await sql`SELECT *, finished_at IS NULL OR finished_at < now()-interval '15 minutes' AS stale FROM recovery_status WHERE name='payments'`)[0] ?? null;
    const pendingRefunds = await sql`SELECT registration_id, operation_id, created_at FROM refund_operations WHERE status='PENDING' ORDER BY created_at LIMIT 20`;
    return renderView(c, 'admin/dashboard', { title: 'Dashboard', activeNav: 'dashboard', ...data, recovery, pendingRefunds }, { layout: 'admin' });
  },
};
