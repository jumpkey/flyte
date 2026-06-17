import type { Context } from 'hono';
import { renderView } from '../../render.js';
import { eventAdminService } from '../../../services/event-admin-service.js';
import { validateEventForm, isAllowedTransition } from '../../validators/event-form.js';
import { analyticsService } from '../../../services/analytics-service.js';
import { computeProjection } from '../../../services/analytics-projection.js';
import { RefundService } from '../../../registration/services/RefundService.js';
import { NotificationService } from '../../../registration/services/NotificationService.js';
import { getStripe } from '../../../registration/stripe-factory.js';
import { eventService } from '../../../services/event-service.js';
import { validateImageUpload, MAX_IMAGE_BYTES } from '../../../services/image-upload.js';
import { getClientIp } from '../../utils/get-client-ip.js';
import { toCsv, csvResponse } from '../../utils/csv.js';
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

/** Did the admin tick the "Remove image" checkbox? */
function wantsRemoveImage(body: Record<string, string | File>): boolean {
  return body['removeImage'] === 'on' || body['removeImage'] === 'true';
}

/**
 * Pull an uploaded graphic out of the parsed (multipart) body and validate it
 * (size cap + magic-byte sniff). Returns:
 *   { kind: 'none' }     — no file was chosen
 *   { kind: 'error', .. } — a file was chosen but failed validation
 *   { kind: 'ok', .. }    — a valid image buffer + server-derived mime
 * The client Content-Type is never trusted; the stored mime comes from the sniff.
 */
type ImageUpload =
  | { kind: 'none' }
  | { kind: 'error'; error: string }
  | { kind: 'ok'; buffer: Buffer; mime: string };

async function readImageUpload(body: Record<string, string | File>): Promise<ImageUpload> {
  const file = body['imageFile'];
  if (!(file instanceof File) || file.size === 0) return { kind: 'none' };
  // Reject by declared size first to avoid buffering huge uploads needlessly.
  if (file.size > MAX_IMAGE_BYTES) {
    return { kind: 'error', error: 'Image is too large — uploads must be 2 MB or smaller.' };
  }
  const buf = Buffer.from(await file.arrayBuffer());
  const result = validateImageUpload(buf);
  if (!result.ok) return { kind: 'error', error: result.error };
  return { kind: 'ok', buffer: result.buffer, mime: result.mime };
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
    // Pace column (A3): compute a band per OPEN/FULL event from trailing velocity.
    const velocities = await analyticsService.velocityByEvent();
    const withPace = events.map((e) => {
      let band: string | null = null;
      if (e.status === 'OPEN' || e.status === 'FULL') {
        band = computeProjection({
          openedAt: e.opened_at, eventDate: e.event_date,
          capacity: e.total_capacity, confirmed: e.confirmed_count,
          availableSlots: e.available_slots, velocity: velocities[e.event_id] ?? 0,
        }).band;
      }
      return { ...e, pace_band: band };
    });
    return renderView(c, 'admin/events-list', { title: 'Events', activeNav: 'events', events: withPace }, { layout: 'admin' });
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
    const upload = await readImageUpload(body);

    const errors: Record<string, string> = result.ok ? {} : { ...result.errors };
    if (upload.kind === 'error') errors.imageFile = upload.error;

    if (!result.ok || Object.keys(errors).length > 0) {
      return renderView(c, 'admin/event-form', {
        title: 'New event', activeNav: 'events',
        mode: 'create', errors, values: result.ok ? result.values : result.values,
      }, { layout: 'admin' });
    }
    const openImmediately = body['openImmediately'] === 'on' || body['openImmediately'] === 'true';
    const eventId = await eventAdminService.create(result.values, openImmediately);
    // A stored blob is the one source of truth — write it after create. (The
    // create proc/INSERT doesn't take image columns, so we follow up.)
    if (upload.kind === 'ok') {
      await eventAdminService.setImageBlob(eventId, upload.buffer, upload.mime);
    }
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
      hasImageBlob: event.has_image,
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
    const upload = await readImageUpload(body);
    const removeImage = wantsRemoveImage(body);

    // Status transition validation (CANCELLED never comes through here).
    const requestedStatus = String(body['status'] ?? event.status);
    const errors = result.ok ? {} : { ...result.errors };
    if (requestedStatus !== 'CANCELLED' && !isAllowedTransition(event.status, requestedStatus)) {
      errors.status = `Cannot change status from ${event.status} to ${requestedStatus}.`;
    }
    if (upload.kind === 'error') errors.imageFile = upload.error;

    if (!result.ok || Object.keys(errors).length > 0) {
      return renderView(c, 'admin/event-form', {
        title: `Edit: ${event.name}`, activeNav: 'events',
        mode: 'edit', eventId, errors,
        currentStatus: event.status,
        confirmedCount: event.confirmed_count,
        hasImageBlob: event.has_image,
        values: result.ok
          ? { ...result.values, feeDollars: centsToDollars(result.values.registrationFeeCents), eventDateRaw: toLocalInput(result.values.eventDate) }
          : result.values,
      }, { layout: 'admin' });
    }

    // FULL is engine-managed: if the event is currently FULL and the admin kept
    // it FULL via a hidden field, the transition table already forbids invalid
    // moves; we only ever write the requested allowed status.
    await eventAdminService.update(eventId, result.values, requestedStatus, event.opened_at);

    // Image (D1): a new upload wins and clears image_url (one source of truth);
    // otherwise the "Remove image" checkbox deletes the stored graphic, leaving
    // image_url as the admin set it. Upload takes precedence over a stray remove.
    if (upload.kind === 'ok') {
      await eventAdminService.setImageBlob(eventId, upload.buffer, upload.mime);
    } else if (removeImage) {
      await eventAdminService.clearImageBlob(eventId);
    }

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

    const [roster, waitlist, stats, perf] = await Promise.all([
      eventAdminService.getRoster(eventId),
      eventAdminService.getWaitlist(eventId),
      eventAdminService.getStats(eventId),
      analyticsService.getEventPerformance(eventId),
    ]);

    return renderView(c, 'admin/event-detail', {
      title: event.name, activeNav: 'events',
      event, roster, waitlist, stats, perf,
    }, { layout: 'admin' });
  },

  /**
   * GET /events/:eventId/image — serve an event's uploaded graphic (D1). Public
   * (storefront cards and the admin edit form both point here). The Content-Type
   * is the SERVER-derived mime stored at upload time, never a client value;
   * X-Content-Type-Options: nosniff blocks browser MIME-guessing, and a long
   * cache is safe because the URL changes meaning only when the admin re-uploads.
   */
  async image(c: Context): Promise<Response> {
    const eventId = c.req.param('eventId');
    if (!eventId || !UUID_RE.test(eventId)) return c.notFound();
    const img = await eventAdminService.getImageBlob(eventId);
    if (!img) return c.notFound();
    // Buffer/Uint8Array aren't BodyInit under this lib's DOM types; copy the
    // bytes into a standalone ArrayBuffer, which is.
    const ab = img.blob.buffer.slice(img.blob.byteOffset, img.blob.byteOffset + img.blob.byteLength) as ArrayBuffer;
    return new Response(ab, {
      headers: {
        'Content-Type': img.mime,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=3600',
        'Content-Length': String(img.blob.length),
      },
    });
  },

  /** GET /admin/events/:id/roster.csv — roster export (A7). */
  async rosterCsv(c: Context): Promise<Response> {
    const eventId = c.req.param('id');
    if (!eventId || !UUID_RE.test(eventId)) return c.notFound();
    const event = await eventAdminService.getById(eventId);
    if (!event) return c.notFound();
    const roster = await eventAdminService.getRoster(eventId);
    const csv = toCsv(
      ['First name', 'Last name', 'Email', 'Status', 'Gross', 'Refunded', 'Registered'],
      roster.map((r) => [r.first_name, r.last_name, r.email, r.status,
        ((r.gross_amount_cents as number) / 100).toFixed(2),
        ((r.refunded_amount_cents as number) / 100).toFixed(2), r.created_at]),
    );
    return csvResponse('roster.csv', csv);
  },

  /** GET /admin/events/:id/waitlist.csv — waitlist export (A7). */
  async waitlistCsv(c: Context): Promise<Response> {
    const eventId = c.req.param('id');
    if (!eventId || !UUID_RE.test(eventId)) return c.notFound();
    const event = await eventAdminService.getById(eventId);
    if (!event) return c.notFound();
    const waitlist = await eventAdminService.getWaitlist(eventId);
    const csv = toCsv(
      ['Position', 'First name', 'Last name', 'Email', 'Joined'],
      waitlist.map((w, i) => [i + 1, w.first_name, w.last_name, w.email, w.created_at]),
    );
    return csvResponse('waitlist.csv', csv);
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
