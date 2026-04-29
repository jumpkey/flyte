import { createMiddleware } from 'hono/factory';
import { userService } from '../../services/user-service.js';
import type { SessionData } from './session.js';

export const authGuard = createMiddleware(async (c, next) => {
  const session = c.get('session') as SessionData;
  if (!session?.userId) {
    return c.redirect('/login');
  }
  const user = await userService.findById(session.userId);
  if (!user) {
    return c.redirect('/login');
  }
  c.set('user', user);
  await next();
});
