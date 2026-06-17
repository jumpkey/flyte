import { createMiddleware } from 'hono/factory';
import { getClientIp } from '../utils/get-client-ip.js';

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

// Purge expired entries every 5 minutes to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (entry.resetAt < now) rateLimitMap.delete(key);
  }
}, 5 * 60 * 1000).unref();

function isUnderLimit(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || entry.resetAt < now) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  entry.count++;
  return entry.count <= maxRequests;
}

export function rateLimit(maxRequests: number, windowMs: number) {
  return createMiddleware(async (c, next) => {
    // Trusted client IP (Fly-Client-IP on platform) so the key can't be spoofed.
    const key = `${c.req.path}:${getClientIp(c)}`;

    if (isUnderLimit(key, maxRequests, windowMs)) {
      await next();
      return;
    }

    // Over the limit — answer 429 immediately (W16). The previous sleep-retry
    // loop held the request open for up to several seconds before responding,
    // which under sustained load ties up server connections — amplifying an
    // attack rather than absorbing it. A fast 429 sheds load and lets honest
    // clients back off.
    return c.text('Too many requests', 429);
  });
}
