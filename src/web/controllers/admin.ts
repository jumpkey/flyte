import type { Context } from 'hono';
import { renderView } from '../render.js';

/**
 * Placeholder admin landing (I1). The real admin dashboard (WF-07) arrives in
 * I5; for now this exists to exercise adminGuard + the admin layout shell and
 * give the security regression set a live /admin endpoint to enumerate against.
 */
export const adminController = {
  async index(c: Context): Promise<Response> {
    return renderView(c, 'admin/index', { title: 'Admin', activeNav: 'dashboard' }, { layout: 'admin' });
  },
};
