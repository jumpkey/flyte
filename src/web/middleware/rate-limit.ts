import { createMiddleware } from 'hono/factory';

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

// Purge expired entries every 5 minutes to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (entry.resetAt < now) rateLimitMap.delete(key);
  }
}, 5 * 60 * 1000).unref();

const RETRY_MAX = 3;
const RETRY_BASE_MS = 500;
const RETRY_CEILING_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    const forwardedFor = c.req.header('x-forwarded-for');
    const ip = forwardedFor ? forwardedFor.split(',').pop()!.trim() : (c.req.header('x-real-ip') ?? '127.0.0.1');
    const key = `${c.req.path}:${ip}`;

    if (isUnderLimit(key, maxRequests, windowMs)) {
      await next();
      return;
    }

    // Over the limit — retry with random backoff up to RETRY_MAX times.
    // This absorbs brief spikes without returning 429 to the client.
    for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
      const jitter = RETRY_BASE_MS + Math.random() * (RETRY_CEILING_MS - RETRY_BASE_MS);
      await sleep(jitter);

      if (isUnderLimit(key, maxRequests, windowMs)) {
        await next();
        return;
      }
    }

    // Exhausted retries — likely sustained abuse, not a legitimate spike.
    return c.text('Too many requests', 429);
  });
}
