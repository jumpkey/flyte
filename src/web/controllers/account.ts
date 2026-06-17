import type { Context } from 'hono';
import { renderView } from '../render.js';
import { accountService } from '../../services/account-service.js';
import type { User } from '../../services/user-service.js';
import type { SessionData } from '../middleware/session.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const accountController = {
  /** GET /account/registrations — My Registrations (WF-06). */
  async registrations(c: Context): Promise<Response> {
    const user = c.get('user') as User; // authGuard guarantees presence
    const [registrations, waitlist] = await Promise.all([
      accountService.listRegistrations(user.id),
      accountService.listWaitlist(user.id),
    ]);
    return renderView(c, 'account-registrations', {
      title: 'My registrations', registrations, waitlist,
    });
  },

  /** GET /account/registrations/:id — ownership-checked detail (R3). */
  async registrationDetail(c: Context): Promise<Response> {
    const user = c.get('user') as User;
    const id = c.req.param('id');
    if (!id || !UUID_RE.test(id)) return c.notFound();
    const reg = await accountService.getRegistration(id, user.id);
    if (!reg) return c.notFound(); // missing OR not owned (R3)
    return renderView(c, 'account-registration-detail', { title: 'Registration', reg });
  },

  /** POST /account/waitlist/:id/remove — ownership-checked waitlist removal (W12). */
  async removeWaitlist(c: Context): Promise<Response> {
    const user = c.get('user') as User;
    const id = c.req.param('id');
    if (!id || !UUID_RE.test(id)) return c.notFound();
    const removed = await accountService.removeWaitlistEntry(id, user.id);
    if (removed) {
      const session = c.get('session') as SessionData | undefined;
      if (session) session.flashMessage = 'Removed from the waitlist.';
    }
    return c.redirect('/account/registrations');
  },
};
