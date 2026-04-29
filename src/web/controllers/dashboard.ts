import type { Context } from 'hono';
import { renderView } from '../render.js';

export const dashboardController = {
  async index(c: Context): Promise<Response> {
    return renderView(c, 'dashboard', { title: 'Dashboard' });
  },
};
