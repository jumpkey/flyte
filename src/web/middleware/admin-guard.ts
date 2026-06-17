import { createMiddleware } from 'hono/factory';
import { userService } from '../../services/user-service.js';
import type { SessionData } from './session.js';

/**
 * Gate for every /admin surface (R1, S1).
 *
 * Unlike authGuard (which redirects anonymous users to /login), adminGuard
 * answers 404 for *every* non-admin case — anonymous, active non-admin, locked
 * admin, or an unknown session user. The admin area must be invisible, not
 * merely forbidden: a 403 or a redirect would confirm the route exists. The
 * structural admin-route enumeration test (I1 security regression set) asserts
 * this 404 holds for every registered /admin route.
 */
export const adminGuard = createMiddleware(async (c, next) => {
  const session = c.get('session') as SessionData | undefined;
  if (!session?.userId) {
    return c.notFound();
  }
  const user = await userService.findById(session.userId);
  if (!user || user.isLocked || !user.isAdmin) {
    return c.notFound();
  }
  c.set('user', user);
  await next();
});
