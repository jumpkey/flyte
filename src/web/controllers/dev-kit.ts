import type { Context } from 'hono';
import { renderView } from '../render.js';

// Pilot style-guide page (Document 7 §2). Dev-only: production gets a 404 so
// the kit never ships as public surface.
export const devKitController = {
  async index(c: Context): Promise<Response> {
    if (process.env.NODE_ENV === 'production') return c.notFound();
    return renderView(c, 'dev-kit', { title: 'Style kit' });
  },
};
