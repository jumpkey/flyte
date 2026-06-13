import type { Context } from 'hono';
import { renderView } from '../render.js';
import { eventService } from '../../services/event-service.js';

export const homeController = {
  async index(c: Context): Promise<Response> {
    const events = await eventService.listUpcomingPublic(6);
    return renderView(c, 'home', { title: 'Find your next event', events });
  },
};
