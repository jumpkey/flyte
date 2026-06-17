import type { Context } from 'hono';
import { renderView } from '../render.js';
import { accountService } from '../../services/account-service.js';
import type { User } from '../../services/user-service.js';

export const dashboardController = {
  async index(c: Context): Promise<Response> {
    const user = c.get('user') as User; // authGuard guarantees presence
    const [upcoming, waitlist] = await Promise.all([
      accountService.upcomingRegistrations(user.id, 3),
      accountService.listWaitlist(user.id),
    ]);
    return renderView(c, 'dashboard', { title: 'Dashboard', upcoming, waitlist });
  },
};
