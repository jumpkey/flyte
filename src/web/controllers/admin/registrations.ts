import type { Context } from 'hono';
import { renderView, renderFragment } from '../../render.js';
import { adminRegistrationsService } from '../../../services/admin-registrations-service.js';
import { RefundService } from '../../../registration/services/RefundService.js';
import { NotificationService } from '../../../registration/services/NotificationService.js';
import { getStripe } from '../../../registration/stripe-factory.js';
import { eventService } from '../../../services/event-service.js';
import { eventAdminService } from '../../../services/event-admin-service.js';
import { getClientIp } from '../../utils/get-client-ip.js';
import { toCsv, csvResponse } from '../../utils/csv.js';
import { config } from '../../../config.js';
import type { SessionData } from '../../middleware/session.js';
import type { User } from '../../../services/user-service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    _refundService = new RefundService(await getStripe(), new NotificationService());
  }
  return _refundService;
}

/** Stripe dashboard deep-link base — test vs live from the configured key. */
function stripePaymentUrl(paymentIntentId: string): string {
  const testMode = config.stripe.secretKey.startsWith('sk_test') || config.stripe.publishableKey.startsWith('pk_test');
  return `https://dashboard.stripe.com/${testMode ? 'test/' : ''}payments/${paymentIntentId}`;
}

export const adminRegistrationsController = {
  /** GET /admin/registrations — the transaction log (WF-11). HTMX-paginated. */
  async list(c: Context): Promise<Response> {
    const f = {
      eventId: c.req.query('eventId') ?? '',
      status: c.req.query('status') ?? '',
      email: c.req.query('email') ?? '',
      from: c.req.query('from') ?? '',
      to: c.req.query('to') ?? '',
      page: parseInt(c.req.query('page') ?? '1', 10) || 1,
      perPage: 25,
    };
    const result = await adminRegistrationsService.listTransactions(f);
    const events = await eventAdminService.listForAdmin();
    const data = {
      title: 'Transactions', activeNav: 'registrations',
      ...result, filters: f, events, statuses: adminRegistrationsService.validStatuses(),
    };
    if (c.req.header('HX-Request') === 'true') {
      return renderFragment(c, 'admin/partials/transactions-table', data);
    }
    return renderView(c, 'admin/registrations-list', data, { layout: 'admin' });
  },

  /** GET /admin/registrations.csv — the transaction log as CSV, honoring filters (A7). */
  async exportCsv(c: Context): Promise<Response> {
    const f = {
      eventId: c.req.query('eventId') ?? '',
      status: c.req.query('status') ?? '',
      email: c.req.query('email') ?? '',
      from: c.req.query('from') ?? '',
      to: c.req.query('to') ?? '',
    };
    const rows = await adminRegistrationsService.exportTransactions(f);
    const csv = toCsv(
      ['Created', 'Event', 'First name', 'Last name', 'Email', 'Status', 'Gross', 'Net', 'Refunded'],
      rows.map((r) => [
        r.created_at, r.event_name, r.first_name, r.last_name, r.email, r.status,
        (r.gross_amount_cents / 100).toFixed(2),
        r.net_amount_cents != null ? (r.net_amount_cents / 100).toFixed(2) : '',
        (r.refunded_amount_cents / 100).toFixed(2),
      ]),
    );
    return csvResponse('transactions.csv', csv);
  },

  /** GET /admin/registrations/:id — payment detail + timeline (WF-12). */
  async detail(c: Context): Promise<Response> {
    const id = c.req.param('id');
    if (!id || !UUID_RE.test(id)) return c.notFound();
    const detail = await adminRegistrationsService.getDetail(id);
    if (!detail) return c.notFound();

    const reg = detail.registration;
    const net = (reg.net_amount_cents as number | null) ?? (reg.gross_amount_cents as number);
    const remaining = net - (reg.refunded_amount_cents as number);
    return renderView(c, 'admin/registration-detail', {
      title: 'Payment detail', activeNav: 'registrations',
      reg, refundLog: detail.refundLog,
      remainingCents: remaining,
      refundable: reg.status === 'CONFIRMED' && remaining > 0,
      stripeUrl: reg.payment_intent_id ? stripePaymentUrl(reg.payment_intent_id as string) : null,
    }, { layout: 'admin' });
  },

  /**
   * POST /admin/registrations/:id/refund — first HTTP exposure of RefundService
   * (S3). adminGuard + CSRF (middleware) + server-validated amount here. Full or
   * partial; optional reason; on success auto-resolves any open refund request.
   */
  async refund(c: Context): Promise<Response> {
    const id = c.req.param('id');
    if (!id || !UUID_RE.test(id)) return c.notFound();
    const detail = await adminRegistrationsService.getDetail(id);
    if (!detail) return c.notFound();
    const reg = detail.registration;
    const back = `/admin/registrations/${id}`;

    if (reg.status !== 'CONFIRMED') {
      flash(c, 'Only confirmed registrations can be refunded.');
      return c.redirect(back);
    }

    const body = await getBody(c);
    const refundType = String(body['refundType'] ?? 'full').toLowerCase() === 'partial' ? 'PARTIAL' : 'FULL';
    const reason = String(body['reason'] ?? '').trim() || 'admin_initiated';
    const net = (reg.net_amount_cents as number | null) ?? (reg.gross_amount_cents as number);
    const remaining = net - (reg.refunded_amount_cents as number);

    let partialAmountCents: number | undefined;
    if (refundType === 'PARTIAL') {
      const raw = String(body['amount'] ?? '').trim();
      if (!/^\d+(\.\d{1,2})?$/.test(raw)) {
        flash(c, 'Enter a valid refund amount.');
        return c.redirect(back);
      }
      partialAmountCents = Math.round(parseFloat(raw) * 100);
      // Server-side amount validation (AC-I5 ③): positive and ≤ remaining net.
      if (partialAmountCents <= 0) { flash(c, 'Refund amount must be greater than zero.'); return c.redirect(back); }
      if (partialAmountCents > remaining) { flash(c, `Refund exceeds the remaining balance (${(remaining / 100).toFixed(2)}).`); return c.redirect(back); }
    }

    let svc: RefundService;
    try { svc = await getRefundService(); }
    catch (_) { flash(c, 'Payment service unavailable — no refund issued.'); return c.redirect(back); }

    const result = await svc.refundRegistration({ registrationId: id, refundType, partialAmountCents, reason });

    const admin = c.get('user') as User | undefined;
    switch (result.outcome) {
      case 'REFUND_ISSUED':
      case 'PARTIAL_REFUND_ISSUED': {
        // Auto-resolve any open refund request + audit (best effort).
        if (admin) {
          try {
            await adminRegistrationsService.resolveOpenRefundRequests(id, admin.id);
            await eventService.logAction({ userId: admin.id, action: 'refund_issued', resource: back, metadata: { amountCents: result.refundedAmountCents, type: refundType }, ipAddress: getClientIp(c) });
          } catch (_) { /* best effort */ }
        }
        flash(c, `Refunded $${((result.refundedAmountCents ?? 0) / 100).toFixed(2)} to the customer.`);
        break;
      }
      case 'STRIPE_ERROR':
        flash(c, 'Stripe declined the refund — nothing was recorded. Try again or check the Stripe dashboard.');
        break;
      case 'AMOUNT_EXCEEDS_BALANCE':
        flash(c, 'Refund exceeds the remaining balance.');
        break;
      case 'ALREADY_REFUNDED':
        flash(c, 'This registration has already been fully refunded.');
        break;
      case 'INVALID_STATE':
        flash(c, 'This registration can no longer be refunded.');
        break;
      default:
        flash(c, 'The refund could not be completed.');
    }
    return c.redirect(back);
  },
};
