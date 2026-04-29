import { createMiddleware } from 'hono/factory';
import crypto from 'crypto';
import type { SessionData } from './session.js';
import { createSession } from './session.js';

const CSRF_EXEMPT_PATHS = new Set(['/api/check-email']);

export const csrfMiddleware = createMiddleware(async (c, next) => {
  const session = c.get('session') as SessionData;

  if (!session.csrfToken) {
    session.csrfToken = crypto.randomBytes(32).toString('hex');

    // Persist a new session so the CSRF token survives across requests
    // (needed for unauthenticated users who have no session cookie yet)
    const existingSessionId = c.get('sessionId') as string | null;
    if (!existingSessionId) {
      const { signedSid, sid } = await createSession({ csrfToken: session.csrfToken });
      c.set('sessionId', sid);
      c.set('sessionCookie', signedSid);
    }
  }

  if (c.req.method === 'POST' && !CSRF_EXEMPT_PATHS.has(c.req.path)) {
    const body = await c.req.parseBody();
    const token = body['_csrf'] as string | undefined;
    if (!token || token !== session.csrfToken) {
      return c.text('Invalid CSRF token', 403);
    }
  }

  await next();
});
