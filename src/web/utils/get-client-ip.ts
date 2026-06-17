import type { Context } from 'hono';

/**
 * Best-effort client IP for rate-limiting keys and audit logs.
 *
 * On Fly.io the `Fly-Client-IP` header is stamped by the edge and cannot be
 * forged by the client, so it is the trusted source (W16). We only fall back to
 * `X-Forwarded-For` / `X-Real-IP` off-platform; for X-Forwarded-For we take the
 * LAST hop (the value our own proxy appended) rather than the client-controlled
 * left-most entry, so a spoofed header can't pollute the key.
 */
export function getClientIp(c: Context): string {
  const flyClientIp = c.req.header('fly-client-ip');
  if (flyClientIp) return flyClientIp.trim();

  const forwardedFor = c.req.header('x-forwarded-for');
  if (forwardedFor) return forwardedFor.split(',').pop()!.trim();

  return c.req.header('x-real-ip') ?? '127.0.0.1';
}
