import type { Context } from 'hono';
import { renderView } from '../../render.js';
import { eventAdminService } from '../../../services/event-admin-service.js';
import { validateEventForm, isAllowedTransition } from '../../validators/event-form.js';
import { RefundService } from '../../../registration/services/RefundService.js';
import { NotificationService } from '../../../registration/services/NotificationService.js';
import { getStripe } from '../../../registration/stripe-factory.js';
import { eventService } from '../../../services/event-service.js';
import { getClientIp } from '../../utils/get-client-ip.js';
import type { SessionData } from '../../middleware/session.js';
import type { User } from '../../../services/user-service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function centsToDollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** Set a one-shot flash message on the session (shown after the redirect). */
function flash(c: Context, message: string): void {
  const session = c.get('session') as SessionData | undefined;
  if (session) session.flashMessage = message;
}

async function getBody(c: Context): Promise<Record<string, string | File>> {
  return (c.get('parsedBody') as Record<string, string | File> | undefined) ?? await c.req.parseBody();
}

let _refundService: RefundService | null = null;
async function getRefundService(): Promise<RefundService> {
  if (!_refundService) {
    const stripe = await getStripe();
    _refundService = new RefundService(stripe, new NotificationService());
  }
  return _refundService;
}

export const adminEventsController = {
  async list(c: Context): Promise<Response> {
    const events = await eventAdminService.listForAdmin();
    return renderView(c, 'admin/events-list', { title: 'Events', activeNav: 'events', events }, { layout: 'admin' });
  },

  async newForm(c: Context): Promise<Response> {
    return renderView(c, 'admin/event-form', {
      title: 'New event', activeNav: 'events',
      mode: 'create', errors: {}, values: { waitlistEnabled: true },
    }, { layout: 'admin' });
  },

  async create(c: Context): Promise<Response> {
    const body = await getBody(c);
    const result = validateEventForm(body as Record<string, unknown>);
    if (!result.ok) {
      return renderView(c, 'admin/event-form', {
        title: 'New event', activeNav: 'events',
        mode: 'create', errors: result.errors, values: result.values,
      }, { layout: 'admin' });
    }
    const openImmediately = body['openImmediately'] === 'on' || body['openImmediately'] === 'true';
    const eventId = await eventAdminService.create(result.values, openImmediately);
    flash(c, openImmediately ? 'Event created and opened.' : 'Event created as a draft.');
    return c.redirect(`/admin/events/${eventId}`);
  },

  async editForm(c: Context): Promise<Response> {
    const eventId = c.req.param('id');
    if (!eventId || !UUID_RE.test(eventId)) return c.notFound();
    const event = await eventAdminService.getById(eventId);
    if (!event) return c.notFound();

    return renderView(c, 'admin/event-form', {
      title: `Edit: ${event.name}`, activeNav: 'events',
      mode: 'edit', eventId, errors: {},
      currentStatus: event.status,
      confirmedCount: event.confirmed_count,
      values: {
        name: event.name,
        eventDateRaw: toLocalInput(event.event_date),
        location: event.location,
        description: event.description,
        totalCapacity: event.total_capacity,
        feeDollars: centsToDollars(event.registration_fee_cents),
        imageUrl: event.image_url,
        waitlistEnabled: event.waitlist_enabled,
      },
    }, { layout: 'admin' });
  },

  async update(c: Context): Promise<Response> {
    const eventId = c.req.param('id');
    if (!eventId || !UUID_RE.test(eventId)) return c.notFound();
    const event = await eventAdminService.getById(eventId);
    if (!event) return c.notFound();

    const body = await getBody(c);
    const result = validateEventForm(body as Record<string, unknown>, { minCapacity: event.confirmed_count });

    // Status transition validation (CANCELLED never comes through here).
    const requestedStatus = String(body['status'] ?? event.status);
    const errors = result.ok ? {} : { ...result.errors };
    if (requestedStatus !== 'CANCELLED' && !isAllowedTransition(event.status, requestedStatus)) {
      errors.status = `Cannot change status from ${event.status} to ${requestedStatus}.`;
    }

    if (!result.ok || Object.keys(errors).length > 0) {
      return renderView(c, 'admin/event-form', {
        title: `Edit: ${event.name}`, activeNav: 'events',
        mode: 'edit', eventId, errors,
        currentStatus: event.status,
        confirmedCount: event.confirmed_count,
        values: result.ok
          ? { ...result.values, feeDollars: centsToDollars(result.values.registrationFeeCents), eventDateRaw: toLocalInput(result.values.eventDate) }
          : result.values,
      }, { layout: 'admin' });
    }

    // FULL is engine-managed: if the event is currently FULL and the admin kept
    // it FULL via a hidden field, the transition table already forbids invalid
    // moves; we only ever write the requested allowed status.
    await eventAdminService.update(eventId, result.values, requestedStatus, event.opened_at);

    // Audit metadata for the I10 booking curve: record capacity and status
    // changes against the acting admin (best-effort, never blocks the update).
    const admin = c.get('user') as User | undefined;
    if (admin) {
      const ip = getClientIp(c);
      try {
        if (result.values.totalCapacity !== event.total_capacity) {
          await eventService.logAction({ userId: admin.id, action: 'event_capacity_changed', resource: `/admin/events/${eventId}`, metadata: { from: event.total_capacity, to: result.values.totalCapacity }, ipAddress: ip });
        }
        if (requestedStatus !== event.status) {
          await eventService.logAction({ userId: admin.id, action: 'event_status_changed', resource: `/admin/events/${eventId}`, metadata: { from: event.status, to: requestedStatus }, ipAddress: ip });
        }
      } catch (_) { /* audit is best-effort */ }
    }

    flash(c, 'Event updated.');
    return c.redirect(`/admin/events/${eventId}`);
  },

  async detail(c: Context): Promise<Response> {
    const eventId = c.req.param('id');
    if (!eventId || !UUID_RE.test(eventId)) return c.notFound();
    const event = await eventAdminService.getById(eventId);
    if (!event) return c.notFound();

    const [roster, waitlist, stats] = await Promise.all([
      eventAdminService.getRoster(eventId),
      eventAdminService.getWaitlist(eventId),
      eventAdminService.getStats(eventId),
    ]);

    return renderView(c, 'admin/event-detail', {
      title: event.name, activeNav: 'events',
      event, roster, waitlist, stats,
    }, { layout: 'admin' });
  },

  /**
   * Cancel an event = bulk-refund every confirmed registration via the engine's
   * RefundService. All-or-nothing (A6): the event flips to CANCELLED only if
   * every refund succeeds; otherwise it stays put and the failure is surfaced.
   */
  async cancel(c: Context): Promise<Response> {
    const eventId = c.req.param('id');
    if (!eventId || !UUID_RE.test(eventId)) return c.notFound();
    const event = await eventAdminService.getById(eventId);
    if (!event) return c.notFound();
    if (event.status === 'CANCELLED') {
      flash(c, 'Event is already cancelled.');
      return c.redirect(`/admin/events/${eventId}`);
    }

    // Nothing to refund → cancel directly without requiring Stripe. An empty or
    // draft event can be cancelled even when payments aren't configured, and the
    // bulk-refund path (which needs Stripe) only runs when money is actually owed.
    const confirmed = await eventAdminService.countConfirmedRegistrations(eventId);
    if (confirmed === 0) {
      await eventAdminService.setStatus(eventId, 'CANCELLED');
      flash(c, 'Event cancelled.');
      return c.redirect(`/admin/events/${eventId}`);
    }

    let svc: RefundService;
    try { svc = await getRefundService(); }
    catch (_) { flash(c, 'Payment service unavailable — event not cancelled.'); return c.redirect(`/admin/events/${eventId}`); }

    const result = await svc.refundEvent({ eventId, refundType: 'FULL', reason: 'event_cancelled' });
    if (result.totalFailed > 0) {
      flash(c, `Cancel failed: ${result.totalFailed} of ${result.totalProcessed} refunds did not go through. The event was NOT cancelled — review and retry.`);
    } else {
      flash(c, `Event cancelled. ${result.totalSucceeded} registration${result.totalSucceeded === 1 ? '' : 's'} refunded.`);
    }
    return c.redirect(`/admin/events/${eventId}`);
  },
};

/** Format a timestamptz for an <input type="datetime-local"> (YYYY-MM-DDTHH:mm). */
function toLocalInput(date: Date): string {
  const d = new Date(date);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
