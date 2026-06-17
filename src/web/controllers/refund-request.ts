import type { Context } from 'hono';
import { renderView } from '../render.js';
import { refundRequestsService } from '../../services/refund-requests-service.js';
import { NotificationService } from '../../registration/services/NotificationService.js';
import type { SessionData } from '../middleware/session.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_MAX = 500;

let _notif: NotificationService | null = null;
function notif(): NotificationService {
  if (!_notif) _notif = new NotificationService();
  return _notif;
}

async function getBody(c: Context): Promise<Record<string, string | File>> {
  return (c.get('parsedBody') as Record<string, string | File> | undefined) ?? await c.req.parseBody();
}

/** Build the locals the refund-request view needs from a registration context. */
function summary(ctx: { registration: { registrationId: string; grossAmountCents: number; firstName: string; lastName: string; email: string }; eventName: string }, registrationId: string) {
  return {
    registrationId,
    eventName: ctx.eventName,
    amountCents: ctx.registration.grossAmountCents,
    name: `${ctx.registration.firstName} ${ctx.registration.lastName}`,
    email: ctx.registration.email,
  };
}

export const refundRequestController = {
  /** GET /registration/:id/refund-request — the request form / friendly states (J4). */
  async form(c: Context): Promise<Response> {
    const id = c.req.param('id');
    if (!id || !UUID_RE.test(id)) return c.text('Not found', 404);
    const ctx = await refundRequestsService.getContext(id);
    if (!ctx) return c.text('Not found', 404);

    const base = { title: 'Request a refund', ...summary(ctx, id) };

    if (c.req.query('sent') === '1') {
      return renderView(c, 'refund-request', { ...base, state: 'sent' });
    }
    if (ctx.registration.status !== 'CONFIRMED') {
      return renderView(c, 'refund-request', { ...base, state: 'ineligible' });
    }
    if (await refundRequestsService.hasOpenRequest(id)) {
      return renderView(c, 'refund-request', { ...base, state: 'already' });
    }
    return renderView(c, 'refund-request', { ...base, state: 'form' });
  },

  /** POST /registration/:id/refund-request — file the request (RL(5), S2). */
  async create(c: Context): Promise<Response> {
    const id = c.req.param('id');
    if (!id || !UUID_RE.test(id)) return c.text('Not found', 404);
    const ctx = await refundRequestsService.getContext(id);
    if (!ctx) return c.text('Not found', 404);

    if (ctx.registration.status !== 'CONFIRMED') {
      return renderView(c, 'refund-request', { title: 'Request a refund', ...summary(ctx, id), state: 'ineligible' });
    }

    const body = await getBody(c);
    const reason = String(body['reason'] ?? '').trim().slice(0, REASON_MAX) || null;
    const session = c.get('session') as SessionData | undefined;
    const userId = session?.userId ?? null;

    const result = await refundRequestsService.createRequest(id, userId, reason);
    if (result === 'ALREADY_OPEN') {
      // Friendly state, not an error (AC-I6 ①).
      return c.redirect(`/registration/${id}/refund-request`);
    }

    // Notify admin + acknowledge customer (best effort).
    try { await notif().sendRefundRequestAdminAlert(ctx.registration, ctx.eventName, reason); } catch (_) { /* best effort */ }
    try { await notif().sendRefundRequestReceived(ctx.registration, ctx.eventName); } catch (_) { /* best effort */ }

    return c.redirect(`/registration/${id}/refund-request?sent=1`);
  },
};
