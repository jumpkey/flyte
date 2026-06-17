import type { Context } from 'hono';
import { renderView, renderFragment } from '../../render.js';
import { adminUsersService } from '../../../services/admin-users-service.js';
import { resolveSort } from '../../utils/table-sort.js';
import { userService } from '../../../services/user-service.js';
import { eventService } from '../../../services/event-service.js';
import { destroyUserSessions } from '../../middleware/session.js';
import { getClientIp } from '../../utils/get-client-ip.js';
import type { User } from '../../../services/user-service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function flash(c: Context, message: string): void {
  const session = c.get('session') as { flashMessage?: string } | undefined;
  if (session) session.flashMessage = message;
}

export const adminUsersController = {
  /** GET /admin/users — search/filter list (WF-13). HTMX-paginated + sortable. */
  async list(c: Context): Promise<Response> {
    const q = c.req.query('q') ?? '';
    const status = c.req.query('status') ?? '';
    const locked = c.req.query('locked') ?? '';
    const page = parseInt(c.req.query('page') ?? '1', 10) || 1;
    const sort = resolveSort(c.req.query('sort'), c.req.query('dir'), ['email', 'name', 'registrations', 'joined'], 'joined');
    const result = await adminUsersService.list({ q, status, locked, page, sort });
    const data = {
      title: 'Users', activeNav: 'users',
      users: result.rows, ...result, filters: { q, status, locked },
    };
    if (c.req.header('HX-Request') === 'true') {
      return renderFragment(c, 'admin/partials/users-table', data);
    }
    return renderView(c, 'admin/users-list', data, { layout: 'admin' });
  },

  /** GET /admin/users/:id — profile + purchases + history (WF-14). */
  async detail(c: Context): Promise<Response> {
    const id = c.req.param('id');
    if (!id || !UUID_RE.test(id)) return c.notFound();
    const profile = await adminUsersService.getProfile(id);
    if (!profile) return c.notFound();
    const detail = await adminUsersService.getDetail(id);
    const self = (c.get('user') as User).id === id;
    return renderView(c, 'admin/user-detail', { title: profile.display_name as string, activeNav: 'users', profile, ...detail, self }, { layout: 'admin' });
  },

  /** POST /admin/users/:id/lock — lock + revoke live sessions (S7). Cannot lock self. */
  async lock(c: Context): Promise<Response> {
    const id = c.req.param('id');
    if (!id || !UUID_RE.test(id)) return c.notFound();
    const admin = c.get('user') as User;
    const back = `/admin/users/${id}`;

    if (id === admin.id) {
      flash(c, "You can't lock your own account.");
      return c.redirect(back);
    }
    const target = await userService.findById(id);
    if (!target) return c.notFound();

    await userService.lockAccount(id);
    await destroyUserSessions(id);   // revoke live sessions immediately
    try { await eventService.logAction({ userId: admin.id, action: 'user_locked', resource: back, metadata: { target: id }, ipAddress: getClientIp(c) }); } catch (_) { /* best effort */ }
    flash(c, `${target.email} has been locked and signed out.`);
    return c.redirect(back);
  },

  /** POST /admin/users/:id/unlock. */
  async unlock(c: Context): Promise<Response> {
    const id = c.req.param('id');
    if (!id || !UUID_RE.test(id)) return c.notFound();
    const admin = c.get('user') as User;
    const back = `/admin/users/${id}`;
    const target = await userService.findById(id);
    if (!target) return c.notFound();

    await userService.unlockAccount(id);
    try { await eventService.logAction({ userId: admin.id, action: 'user_unlocked', resource: back, metadata: { target: id }, ipAddress: getClientIp(c) }); } catch (_) { /* best effort */ }
    flash(c, `${target.email} has been unlocked.`);
    return c.redirect(back);
  },
};
