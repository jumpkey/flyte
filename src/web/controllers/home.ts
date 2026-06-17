import type { Context } from 'hono';
import { renderView } from '../render.js';
import { catalogService } from '../../services/catalog-service.js';

export const homeController = {
  /**
   * GET / — public storefront landing (WF-01): hero + up to 6 soonest OPEN
   * upcoming events. Public for everyone (the previous logged-in → /dashboard
   * redirect is gone; the nav reflects the session via loadUser).
   */
  async index(c: Context): Promise<Response> {
    const events = await catalogService.listHomeEvents(6);
    return renderView(c, 'home', { title: 'Find your next event', events });
  },
};
