import type { Context } from 'hono';
import { renderView } from '../render.js';
import type { SessionData } from '../middleware/session.js';

export const homeController = {
  async index(c: Context): Promise<Response> {
    const session = c.get('session') as SessionData | undefined;
    if (session?.userId) return c.redirect('/dashboard');
    return renderView(c, 'home', { title: 'Welcome to Flyte' });
  },
};
