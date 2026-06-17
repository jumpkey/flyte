import type { Context } from 'hono';
import { renderView, renderFragment } from '../render.js';
import { catalogService } from '../../services/catalog-service.js';
import { eventCardState } from '../view-helpers.js';
import type { SessionData } from '../middleware/session.js';
import type { User } from '../../services/user-service.js';

function parsePage(raw: string | undefined): number {
  const n = parseInt(raw ?? '1', 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export const catalogController = {
  /**
   * GET /events — the catalog (WF-02). Text + month filters, 12/page. HTMX swaps
   * just the grid fragment; with JS disabled the same query is a plain full-page
   * GET (progressive enhancement, AC-I2 ⑤).
   */
  async list(c: Context): Promise<Response> {
    const q = c.req.query('q') ?? '';
    const month = c.req.query('month') ?? '';
    const page = parsePage(c.req.query('page'));

    const result = await catalogService.listCatalog({ q, month, page, perPage: 12 });
    const data = {
      title: 'Events',
      events: result.events,
      total: result.total,
      page: result.page,
      perPage: result.perPage,
      totalPages: result.totalPages,
      q,
      month,
    };

    // HTMX requests get only the swappable grid+pagination fragment.
    if (c.req.header('HX-Request') === 'true') {
      return renderFragment(c, 'partials/events-grid', data);
    }
    return renderView(c, 'events-list', data);
  },

  /**
   * GET /events/:eventId — public event detail (WF-03). 404 for missing, DRAFT,
   * or CANCELLED. Logged-in holders of an active registration see the
   * "You're registered ✓" state instead of the booking CTA.
   */
  async detail(c: Context): Promise<Response> {
    const eventId = c.req.param('eventId');
    if (!eventId) {
      return c.notFound();
    }
    const event = await catalogService.getPublicEvent(eventId);
    if (!event) {
      return c.notFound();
    }

    const card = eventCardState(event);

    let alreadyRegistered = false;
    const session = c.get('session') as SessionData | undefined;
    const user = c.get('user') as User | undefined;
    if (session?.userId && user) {
      alreadyRegistered = await catalogService.hasActiveRegistration(eventId, session.userId);
    }

    return renderView(c, 'event-detail', {
      title: event.name,
      event,
      card,
      alreadyRegistered,
    });
  },
};
