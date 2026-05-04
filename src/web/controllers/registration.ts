import type { Context } from 'hono';
import { renderView } from '../render.js';
import { EventAvailabilityService } from '../../registration/services/EventAvailabilityService.js';
import { RegistrationService } from '../../registration/services/RegistrationService.js';
import { WaitlistService } from '../../registration/services/WaitlistService.js';
import { NotificationService } from '../../registration/services/NotificationService.js';
import { getStripe } from '../../registration/stripe-factory.js';
import { sql } from '../../services/db.js';
import { config } from '../../config.js';

const eventAvailabilityService = new EventAvailabilityService();
const waitlistService = new WaitlistService();

let _registrationService: RegistrationService | null = null;
let _notificationService: NotificationService | null = null;

function getNotificationService(): NotificationService {
  if (!_notificationService) _notificationService = new NotificationService();
  return _notificationService;
}

async function getRegistrationService(): Promise<RegistrationService> {
  if (!_registrationService) {
    const stripe = await getStripe();
    _registrationService = new RegistrationService(stripe, getNotificationService());
  }
  return _registrationService;
}

export const registrationController = {
  async showRegistrationForm(c: Context): Promise<Response> {
    const eventId = c.req.param('eventId');
    if (!eventId) return c.text('Event not found', 404);
    const availability = await eventAvailabilityService.getAvailability(eventId);

    if (!availability) {
      return c.text('Event not found', 404);
    }

    if (availability.availableSlots <= 0) {
      return c.redirect(`/events/${eventId}/waitlist`);
    }

    const eventRows = await sql<{name: string; event_date: Date; location: string | null; registration_fee_cents: number}[]>`
      SELECT name, event_date, location, registration_fee_cents FROM events WHERE event_id = ${eventId}::UUID
    `;

    if (eventRows.length === 0) return c.text('Event not found', 404);
    const event = eventRows[0];

    return renderView(c, 'registration-form', {
      title: `Register: ${event.name}`,
      event: { ...event, eventId, availability },
      stripePublishableKey: config.stripe.publishableKey,
    });
  },

  async initiateRegistration(c: Context): Promise<Response> {
    const eventId = c.req.param('eventId');
    if (!eventId) return c.json({ error: 'event_not_found' }, 404);
    const body = await c.req.json().catch(() => null);

    if (!body) return c.json({ error: 'invalid_request' }, 400);

    const eventRows = await sql<{registration_fee_cents: number}[]>`
      SELECT registration_fee_cents FROM events WHERE event_id = ${eventId}::UUID
    `;
    if (eventRows.length === 0) return c.json({ error: 'event_not_found' }, 404);

    const grossAmountCents = eventRows[0].registration_fee_cents;

    let svc: RegistrationService;
    try { svc = await getRegistrationService(); }
    catch (_) { return c.json({ error: 'payment_setup_failed' }, 500); }

    const result = await svc.initiateRegistration({
      eventId,
      email: body.email,
      firstName: body.firstName,
      lastName: body.lastName,
      phone: body.phone,
      attributes: body.attributes ?? {},
      grossAmountCents,
    });

    if (result.outcome === 'SUCCESS') {
      return c.json({ clientSecret: result.stripeClientSecret, paymentIntentId: result.paymentIntentId, registrationId: result.registrationId });
    }
    if (result.outcome === 'ALREADY_REGISTERED') return c.json({ error: 'already_registered' }, 400);
    if (result.outcome === 'STRIPE_TIMEOUT') return c.json({ error: 'payment_setup_failed' }, 503);
    if (result.outcome === 'STRIPE_ERROR') return c.json({ error: 'payment_setup_failed' }, 503);
    if (result.outcome === 'NOT_FOUND') return c.json({ error: 'event_not_found' }, 404);
    return c.json({ error: 'internal_error' }, 500);
  },

  async confirmRegistration(c: Context): Promise<Response> {
    const paymentIntentId = c.req.param('paymentIntentId');
    if (!paymentIntentId) return renderView(c, 'registration-payment-failed', { title: 'Error', message: 'Invalid request' });

    let svc: RegistrationService;
    try { svc = await getRegistrationService(); }
    catch (_) { return renderView(c, 'registration-payment-failed', { title: 'Error', message: 'Payment service unavailable' }); }

    const result = await svc.confirmRegistrationFromClient(paymentIntentId);

    if (result.outcome === 'SUCCESS' || result.outcome === 'IDEMPOTENT_REPLAY') {
      return c.redirect(`/registration/${result.registrationId}/confirmed`);
    }
    if (result.outcome === 'AVAILABILITY_EXHAUSTED') {
      const reg = await svc.getRegistrationByPaymentIntent(paymentIntentId);
      const eventId = reg?.eventId ?? '';
      return c.redirect(`/events/${eventId}/waitlist?reason=full`);
    }
    if (result.outcome === 'CAPTURE_FAILED') {
      return renderView(c, 'registration-capture-pending', { title: 'Finalizing Registration' });
    }
    return renderView(c, 'registration-payment-failed', { title: 'Payment Failed' });
  },

  async showConfirmed(c: Context): Promise<Response> {
    const registrationId = c.req.param('registrationId');
    if (!registrationId) return c.text('Registration not found', 404);

    let svc: RegistrationService;
    try { svc = await getRegistrationService(); }
    catch (_) { return c.text('Service unavailable', 503); }

    const reg = await svc.getRegistration(registrationId);
    if (!reg) return c.text('Registration not found', 404);

    const eventRows = await sql<{name: string; event_date: Date; location: string | null}[]>`
      SELECT name, event_date, location FROM events WHERE event_id = ${reg.eventId}::UUID
    `;

    return renderView(c, 'registration-confirmed', {
      title: 'Registration Confirmed',
      registration: reg,
      event: eventRows.length > 0 ? eventRows[0] : null,
    });
  },

  async showWaitlistForm(c: Context): Promise<Response> {
    const eventId = c.req.param('eventId');
    if (!eventId) return c.text('Event not found', 404);
    const reason = c.req.query('reason');

    const eventRows = await sql<{name: string}[]>`SELECT name FROM events WHERE event_id = ${eventId}::UUID`;
    if (eventRows.length === 0) return c.text('Event not found', 404);

    return renderView(c, 'waitlist-form', {
      title: 'Join Waitlist',
      event: { eventId, name: eventRows[0].name },
      reason,
    });
  },

  async addToWaitlist(c: Context): Promise<Response> {
    const eventId = c.req.param('eventId');
    if (!eventId) return c.text('Event not found', 404);
    const body = (c.get('parsedBody') as Record<string, string | File> | undefined) ?? {};

    const entry = await waitlistService.addToWaitlist({
      eventId,
      email: body['email'] as string,
      firstName: body['firstName'] as string,
      lastName: body['lastName'] as string,
      phone: body['phone'] as string | undefined,
    });

    const position = await waitlistService.getWaitlistPosition(eventId, entry.email);

    const eventRows = await sql<{name: string}[]>`SELECT name FROM events WHERE event_id = ${eventId}::UUID`;
    const eventName = eventRows.length > 0 ? eventRows[0].name : 'Event';

    const notif = getNotificationService();
    try {
      await notif.sendWaitlistAcknowledgement(entry, position ?? 1, eventName);
    } catch (_) { /* best effort */ }

    return renderView(c, 'waitlist-confirmed', {
      title: 'Added to Waitlist',
      entry,
      position,
      eventName,
    });
  },
};
