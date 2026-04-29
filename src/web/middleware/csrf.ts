import { createMiddleware } from 'hono/factory';
import crypto from 'crypto';
import type { SessionData } from './session.js';

export const csrfMiddleware = createMiddleware(async (c, next) => {
  const session = c.get('session') as SessionData;

  if (!session.csrfToken) {
    session.csrfToken = crypto.randomBytes(32).toString('hex');
  }

  if (c.req.method === 'POST' && c.req.path !== '/api/check-email') {
    const body = await c.req.parseBody();
    const token = body['_csrf'] as string | undefined;
    if (!token || token !== session.csrfToken) {
      return c.text('Invalid CSRF token', 403);
    }
  }

  await next();
});
