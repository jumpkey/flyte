import type { Context } from 'hono';
import { renderView, renderFragment } from '../../render.js';
import { analyticsService } from '../../../services/analytics-service.js';

const ALLOWED_RANGES = [30, 90, 365, 3650];

export const adminAnalyticsController = {
  /** GET /admin/analytics — A1 sales & business dashboard (WF-17). HTMX range swap. */
  async dashboard(c: Context): Promise<Response> {
    const raw = parseInt(c.req.query('range') ?? '90', 10);
    const rangeDays = ALLOWED_RANGES.includes(raw) ? raw : 90;
    const data = await analyticsService.getSalesDashboard(rangeDays);
    if (c.req.header('HX-Request') === 'true') {
      return renderFragment(c, 'admin/partials/analytics-body', { ...data });
    }
    return renderView(c, 'admin/analytics', { title: 'Analytics', activeNav: 'analytics', ...data }, { layout: 'admin' });
  },

  /** GET /admin/events/:id/performance — A2 event performance (WF-18). */
  async eventPerformance(c: Context): Promise<Response> {
    const id = c.req.param('id');
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return c.notFound();
    const perf = await analyticsService.getEventPerformance(id);
    if (!perf) return c.notFound();
    return renderView(c, 'admin/event-performance', { title: 'Performance', activeNav: 'events', ...perf }, { layout: 'admin' });
  },
};
