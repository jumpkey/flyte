import type { Context } from 'hono';
import { RegistrationService } from '../../registration/services/RegistrationService.js';
import { NotificationService } from '../../registration/services/NotificationService.js';
import { getStripe } from '../../registration/stripe-factory.js';
import { config } from '../../config.js';

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

export const webhookController = {
  async handleStripeWebhook(c: Context): Promise<Response> {
    const sig = c.req.header('stripe-signature');
    if (!sig) return c.text('No signature', 400);

    const rawBody = await c.req.arrayBuffer();
    const bodyBuffer = Buffer.from(rawBody);

    let event: Record<string, unknown>;
    try {
      if (!config.stripe.secretKey) throw new Error('STRIPE_SECRET_KEY not configured');
      if (!config.stripe.webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET not configured');
      const { default: Stripe } = await import('stripe');
      const stripe = new Stripe(config.stripe.secretKey, { apiVersion: '2026-04-22.dahlia' as const });
      event = stripe.webhooks.constructEvent(bodyBuffer, sig, config.stripe.webhookSecret) as unknown as Record<string, unknown>;
    } catch (err) {
      console.error('[webhook] signature verification failed:', err);
      return c.text('Invalid signature', 400);
    }

    let svc: RegistrationService;
    try { svc = await getRegistrationService(); }
    catch (_) { return c.text('Service unavailable', 500); }

    const piObject = (event['data'] as Record<string, unknown>)?.['object'] as Record<string, unknown> | undefined;
    const piId = piObject?.['id'] as string | undefined;

    if (!piId) return c.text('OK', 200);

    const eventType = event['type'] as string;

    try {
      if (eventType === 'payment_intent.amount_capturable_updated') {
        await svc.handleAuthorizationWebhook(piId, event);
      } else if (eventType === 'payment_intent.payment_failed') {
        await svc.handlePaymentFailed(piId, event);
      }
    } catch (err) {
      console.error('[webhook] error processing event:', err);
      return c.text('Internal error', 500);
    }

    return c.text('OK', 200);
  },
};
