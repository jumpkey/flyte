import type { Context } from 'hono';
import { renderView } from '../render.js';
import { accountService } from '../../services/account-service.js';
import type { User } from '../../services/user-service.js';

export const dashboardController = {
  async index(c: Context): Promise<Response> {
    const user = c.get('user') as User; // authGuard guarantees presence
    const upcoming = await accountService.upcomingRegistrations(user.id, 3);
    return renderView(c, 'dashboard', { title: 'Dashboard', upcoming });
  },
};
