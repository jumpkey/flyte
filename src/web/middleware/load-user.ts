import { createMiddleware } from 'hono/factory';
import { userService } from '../../services/user-service.js';
import type { SessionData } from './session.js';

/**
 * Populate c.get('user') for any request that carries a valid session, so the
 * shared nav (and any public page) reflects the logged-in state. Runs globally
 * after sessionMiddleware. Before this, c.set('user') happened only inside
 * authGuard, so public pages — home, event detail, the storefront — always
 * rendered the logged-out nav even for signed-in users (bug #28).
 *
 * Locked accounts are treated as not-loaded here; authGuard/adminGuard remain
 * the authority for access decisions, this only drives presentation.
 */
export const loadUser = createMiddleware(async (c, next) => {
  const session = c.get('session') as SessionData | undefined;
  if (session?.userId && !c.get('user')) {
    const user = await userService.findById(session.userId);
    if (user && !user.isLocked) {
      c.set('user', user);
    }
  }
  await next();
});
