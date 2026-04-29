import type { Context } from 'hono';

export function getClientIp(c: Context): string {
  const forwardedFor = c.req.header('x-forwarded-for');
  return forwardedFor
    ? forwardedFor.split(',').pop()!.trim()
    : (c.req.header('x-real-ip') ?? '127.0.0.1');
}
