import { createMiddleware } from 'hono/factory';
import crypto from 'crypto';
import { sql } from '../../services/db.js';
import { config } from '../../config.js';

// Purge expired sessions every 15 minutes
setInterval(async () => {
  try {
    await sql`DELETE FROM sessions WHERE expire < NOW()`;
  } catch {
    // Silently ignore cleanup errors to avoid crashing the process
  }
}, 15 * 60 * 1000).unref();

export interface SessionData {
  userId?: string;
  csrfToken?: string;
  flashMessage?: string;
}

function signSessionId(sid: string): string {
  const hmac = crypto.createHmac('sha256', config.sessionSecret);
  hmac.update(sid);
  return `${sid}.${hmac.digest('hex')}`;
}

function verifySessionId(signed: string): string | null {
  const dotIndex = signed.lastIndexOf('.');
  if (dotIndex === -1) return null;
  const sid = signed.substring(0, dotIndex);
  const expected = signSessionId(sid);
  if (signed.length !== expected.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signed), Buffer.from(expected))) return null;
  } catch { return null; }
  return sid;
}

export async function createSession(data: SessionData, userId?: string): Promise<{ signedSid: string; sid: string }> {
  const sid = crypto.randomUUID();
  const expire = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await sql`INSERT INTO sessions (sid, sess, expire, user_id) VALUES (${sid}, ${sql.json(data as any)}, ${expire}, ${userId ?? null})`;
  return { signedSid: signSessionId(sid), sid };
}

export async function getSession(signedSid: string): Promise<{ sid: string; data: SessionData } | null> {
  const sid = verifySessionId(signedSid);
  if (!sid) return null;
  const rows = await sql`SELECT sess FROM sessions WHERE sid = ${sid} AND expire > NOW()`;
  if (rows.length === 0) return null;
  return { sid, data: rows[0].sess as SessionData };
}

export async function updateSession(sid: string, data: SessionData): Promise<void> {
  const expire = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await sql`UPDATE sessions SET sess = ${sql.json(data as any)}, expire = ${expire} WHERE sid = ${sid}`;
}

export async function destroySession(sid: string): Promise<void> {
  await sql`DELETE FROM sessions WHERE sid = ${sid}`;
}

export async function destroyUserSessions(userId: string): Promise<void> {
  await sql`DELETE FROM sessions WHERE user_id = ${userId}`;
}

function buildCookieString(value: string, isProduction: boolean): string {
  const parts = [
    `sid=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${7 * 24 * 60 * 60}`,
  ];
  if (isProduction) parts.push('Secure');
  return parts.join('; ');
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.substring(0, idx).trim();
    const val = part.substring(idx + 1).trim();
    try {
      cookies[key] = decodeURIComponent(val);
    } catch {
      cookies[key] = val;
    }
  }
  return cookies;
}

export const sessionMiddleware = createMiddleware(async (c, next) => {
  const cookieHeader = c.req.header('cookie') ?? '';
  const cookies = parseCookies(cookieHeader);

  const signedSid = cookies['sid'];
  let sessionId: string | null = null;
  let sessionData: SessionData = {};

  if (signedSid) {
    const result = await getSession(signedSid);
    if (result) {
      sessionId = result.sid;
      sessionData = result.data;
    }
  }

  c.set('session', sessionData);
  c.set('sessionId', sessionId);

  await next();

  const newCookieValue = c.get('sessionCookie') as string | undefined;
  if (newCookieValue) {
    c.header('Set-Cookie', buildCookieString(newCookieValue, config.isProduction));
  } else if (sessionId) {
    const updatedSession = c.get('session') as SessionData;
    await updateSession(sessionId, updatedSession);
  }
});
