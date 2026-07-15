import type { Context } from 'hono';
import { renderView, renderFragment } from '../../render.js';
import { refundRequestsService } from '../../../services/refund-requests-service.js';
import { RefundService } from '../../../registration/services/RefundService.js';
import { NotificationService } from '../../../registration/services/NotificationService.js';
import { getStripe } from '../../../registration/stripe-factory.js';
import { eventService } from '../../../services/event-service.js';
import { getClientIp } from '../../utils/get-client-ip.js';
import type { SessionData } from '../../middleware/session.js';
import type { User } from '../../../services/user-service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Server-side cap on the admin deny note (W15) — the email and audit row that
// quote it back are bounded, and a free-text field is otherwise unbounded input.
const NOTE_MAX = 500;

function flash(c: Context, message: string): void {
  const session = c.get('session') as SessionData | undefined;
  if (session) session.flashMessage = message;
}

async function getBody(c: Context): Promise<Record<string, string | File>> {
  return (c.get('parsedBody') as Record<string, string | File> | undefined) ?? await c.req.parseBody();
}

let _notif: NotificationService | null = null;
function notif(): NotificationService {
  if (!_notif) _notif = new NotificationService();
  return _notif;
}
let _refundService: RefundService | null = null;
async function getRefundService(): Promise<RefundService> {
  if (!_refundService) _refundService = new RefundService(await getStripe(), notif());
  return _refundService;
}

export const adminRefundsController = {
  /** GET /admin/refund-requests — the queue (WF-15). Tabs: open / resolved. HTMX-paginated. */
  async queue(c: Context): Promise<Response> {
    const tab = c.req.query('tab') === 'resolved' ? 'resolved' : 'open';
    const page = parseInt(c.req.query('page') ?? '1', 10) || 1;
    // Open tab = the customer-request queue; resolved tab = the full refund
    // ledger (every executed refund, including direct admin refunds).
    const result = tab === 'resolved'
      ? await refundRequestsService.listRefundLedger(page, 25)
      : await refundRequestsService.listQueue('open', page, 25);
    const data = {
      title: 'Refund requests', activeNav: 'refunds', tab,
      ...result,
    };
    if (c.req.header('HX-Request') === 'true') {
      return renderFragment(c, 'admin/partials/refund-queue', data);
    }
    return renderView(c, 'admin/refund-requests', data, { layout: 'admin' });
  },

  /**
   * POST /admin/refund-requests/:id/approve — execute the refund and resolve.
   * Stripe failure leaves the request REQUESTED (never silently resolved); an
   * already-refunded registration resolves gracefully with no second refund.
   */
  async approve(c: Context): Promise<Response> {
    const id = c.req.param('id');
    if (!id || !UUID_RE.test(id)) return c.notFound();
    const req = await refundRequestsService.getById(id);
    if (!req) return c.notFound();
    const back = `/admin/refund-requests`;

    if (req.status !== 'REQUESTED') {
      flash(c, 'That request was already resolved.');
      return c.redirect(back);
    }

    // Optional approver inputs (B5): an editable refund amount (to deduct a
    // service fee) and a note. The amount is validated for shape here and
    // hard-capped against the real captured balance in RefundService — never
    // more than what was charged. Blank amount → full refund.
    const body = await getBody(c);
    const rawAmount = String(body['amount'] ?? '').trim();
    let partialAmountCents: number | undefined;
    if (rawAmount) {
      if (!/^\d+(\.\d{1,2})?$/.test(rawAmount)) {
        flash(c, 'Enter a valid refund amount.');
        return c.redirect(back);
      }
      partialAmountCents = Math.round(parseFloat(rawAmount) * 100);
      if (partialAmountCents <= 0) {
        flash(c, 'Refund amount must be greater than zero.');
        return c.redirect(back);
      }
    }
    const note = String(body['note'] ?? '').trim().slice(0, NOTE_MAX) || null;

    let svc: RefundService;
    try { svc = await getRefundService(); }
    catch (_) { flash(c, 'Payment service unavailable — request left open.'); return c.redirect(back); }

    const result = await svc.refundRegistration({
      registrationId: req.context.registration.registrationId,
      refundType: 'FULL',
      partialAmountCents,
      reason: 'refund_request_approved',
    });

    const admin = c.get('user') as User | undefined;
    const resolver = admin?.id ?? null;

    switch (result.outcome) {
      case 'REFUND_ISSUED':
      case 'PARTIAL_REFUND_ISSUED':
        if (resolver) await refundRequestsService.resolve(id, 'APPROVED', resolver, note ?? 'Approved — refund issued');
        if (admin) { try { await eventService.logAction({ userId: admin.id, action: 'refund_request_approved', resource: back, metadata: { requestId: id, amountCents: result.refundedAmountCents }, ipAddress: getClientIp(c) }); } catch (_) { /* best effort */ } }
        flash(c, `Approved — $${((result.refundedAmountCents ?? 0) / 100).toFixed(2)} refunded.`);
        break;
      case 'ALREADY_REFUNDED':
        // Idempotent (site map §4.3): resolve, no second refund.
        if (resolver) await refundRequestsService.resolve(id, 'APPROVED', resolver, 'Approved — registration was already refunded; no second refund');
        flash(c, 'Approved — this registration had already been refunded, so no further charge-back was made.');
        break;
      case 'AMOUNT_EXCEEDS_BALANCE':
        flash(c, 'That amount is more than the refundable balance — the request is still open.');
        break;
      case 'STRIPE_ERROR':
        flash(c, 'Stripe declined the refund — the request is still open. Try again or refund from the payment detail.');
        break;
      default:
        flash(c, 'Could not complete the refund — the request is still open.');
    }
    return c.redirect(back);
  },

  /** POST /admin/refund-requests/:id/deny — DENIED + required note → email (escaped). */
  async deny(c: Context): Promise<Response> {
    const id = c.req.param('id');
    if (!id || !UUID_RE.test(id)) return c.notFound();
    const req = await refundRequestsService.getById(id);
    if (!req) return c.notFound();
    const back = `/admin/refund-requests`;

    if (req.status !== 'REQUESTED') {
      flash(c, 'That request was already resolved.');
      return c.redirect(back);
    }

    const body = await getBody(c);
    const note = String(body['note'] ?? '').trim().slice(0, NOTE_MAX);
    if (!note) {
      flash(c, 'A note is required to deny a request.');
      return c.redirect(back);
    }

    const admin = c.get('user') as User | undefined;
    if (!admin) return c.redirect(back);
    await refundRequestsService.resolve(id, 'DENIED', admin.id, note);
    try { await notif().sendRefundDenied(req.context.registration, req.context.eventName, note); } catch (_) { /* best effort */ }
    try { await eventService.logAction({ userId: admin.id, action: 'refund_request_denied', resource: back, metadata: { requestId: id }, ipAddress: getClientIp(c) }); } catch (_) { /* best effort */ }
    flash(c, 'Request denied and the customer notified.');
    return c.redirect(back);
  },
};
