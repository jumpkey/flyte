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
    // Form submissions carry the token in the body; JSON/fetch requests
    // (e.g., the registration page's POSTs) carry it in X-CSRF-Token.
    // parseBody is only safe to call for form/multipart bodies — it returns {}
    // for JSON, but consumes the request stream, which would break a
    // downstream c.req.json() call. Guard on content-type accordingly.
    const contentType = c.req.header('content-type') ?? '';
    let bodyToken: string | undefined;
    if (contentType.startsWith('application/x-www-form-urlencoded') ||
        contentType.startsWith('multipart/form-data')) {
      const body = await c.req.parseBody();
      c.set('parsedBody', body);
      bodyToken = body['_csrf'] as string | undefined;
    }
    const headerToken = c.req.header('X-CSRF-Token') ?? c.req.header('X-Csrf-Token');
    const token = bodyToken ?? headerToken;
    if (!token || !session.csrfToken || Buffer.byteLength(token) !== Buffer.byteLength(session.csrfToken) || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(session.csrfToken))) {
      return c.text('Invalid CSRF token', 403);
    }
  }

  await next();
});
