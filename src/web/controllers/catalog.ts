import type { Context } from 'hono';
import { renderView, renderFragment } from '../render.js';
import { catalogService } from '../../services/catalog-service.js';
import { analyticsService } from '../../services/analytics-service.js';
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
    const when = c.req.query('when') === 'past' ? 'past' : 'upcoming';

    const result = await catalogService.listCatalog({ q, month, page, perPage: 12, when });
    const data = {
      title: 'Events',
      events: result.events,
      total: result.total,
      page: result.page,
      perPage: result.perPage,
      totalPages: result.totalPages,
      q,
      month,
      when,
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

    // W18: count this storefront view (per-day counter). Fire-and-forget — the
    // analytics counter must never delay or fail the page render.
    void analyticsService.recordEventView(event.event_id).catch(() => { /* best effort */ });

    const card = eventCardState(event);

    let alreadyRegistered = false;
    let waitlist: { onWaitlist: boolean; position: number | null; waitlistEntryId: string | null } = {
      onWaitlist: false,
      position: null,
      waitlistEntryId: null,
    };
    const session = c.get('session') as SessionData | undefined;
    const user = c.get('user') as User | undefined;
    if (session?.userId && user) {
      alreadyRegistered = await catalogService.hasActiveRegistration(eventId, session.userId);
      waitlist = await catalogService.getWaitlistMembership(eventId, session.userId);
    }

    // Open Graph card (V3 / W22): turn a shared link into a poster. Image-less
    // events fall back to the static brand card so they still unfurl with art;
    // og:type is `event` for richer unfurls on platforms that key off it.
    const origin = new URL(c.req.url).origin;
    const firstLine = (event.description ?? '').split('\n')[0].slice(0, 200);
    // D1: an uploaded blob is served from our own route; it counts as the event's
    // own art for OG just like a remote image_url does. Blob takes precedence.
    const ownImageUrl = event.has_image
      ? `${origin}/events/${event.event_id}/image`
      : event.image_url;
    const hasOwnImage = !!ownImageUrl;
    const og = {
      title: event.name,
      description: firstLine || `${new Date(event.event_date).toDateString()}${event.location ? ' · ' + event.location : ''}`,
      type: 'event',
      url: `${origin}/events/${event.event_id}`,
      image: ownImageUrl ?? `${origin}/public/og-default.svg`,
      // Only the real raster art warrants a large Twitter card; the SVG brand
      // fallback isn't rendered large by Twitter, so it stays a summary card.
      largeImage: hasOwnImage,
    };

    return renderView(c, 'event-detail', {
      title: event.name,
      event,
      card,
      alreadyRegistered,
      waitlist,
      og,
    });
  },
};
