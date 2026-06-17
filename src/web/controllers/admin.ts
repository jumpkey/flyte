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
    return renderView(c, 'admin/dashboard', { title: 'Dashboard', activeNav: 'dashboard', ...data }, { layout: 'admin' });
  },
};
