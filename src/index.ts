import 'dotenv/config';
import { serve } from '@hono/node-server';
import { app } from './web/app.js';
import { config } from './config.js';
import pino from 'pino';

const logger = pino({ level: 'info' });

serve({
  fetch: app.fetch,
  port: config.port,
}, (info) => {
  logger.info(`Server running on http://localhost:${info.port}`);
});
