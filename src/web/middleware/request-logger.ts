import { createMiddleware } from 'hono/factory';
import pino from 'pino';

const logger = pino({ level: 'info' });

export const requestLoggerMiddleware = createMiddleware(async (c, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  logger.info({
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration,
  });
});
