import type { Context } from 'hono';
import { renderView } from '../../render.js';
import { adminActivityService } from '../../../services/admin-activity-service.js';

export const adminActivityController = {
  /** GET /admin/activity — unified login + action feed (50/page). */
  async list(c: Context): Promise<Response> {
    const f = {
      type: c.req.query('type') ?? '',
      email: c.req.query('email') ?? '',
      from: c.req.query('from') ?? '',
      to: c.req.query('to') ?? '',
      page: parseInt(c.req.query('page') ?? '1', 10) || 1,
    };
    const result = await adminActivityService.list(f);
    return renderView(c, 'admin/activity', { title: 'Activity', activeNav: 'activity', ...result, filters: f }, { layout: 'admin' });
  },
};
