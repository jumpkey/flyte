import postgres from 'postgres';
import { config } from '../config.js';

export const sql = postgres(config.databaseUrl, {
  max: 5,
  idle_timeout: 10,        // close idle connections after 20s
  max_lifetime: 60,   // recycle connections every 30min
  connect_timeout: 15,
});