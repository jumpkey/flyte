import 'dotenv/config';

if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET environment variable must be set in production');
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://flyte:flyte@localhost:5432/flyte',
  sessionSecret: process.env.SESSION_SECRET ?? 'dev-secret-change-me',
  appDomain: process.env.APP_DOMAIN ?? 'http://localhost:3000',
  smtp: {
    host: process.env.SMTP_HOST ?? 'localhost',
    port: parseInt(process.env.SMTP_PORT ?? '1025', 10),
    user: process.env.SMTP_USER ?? '',
    pass: process.env.SMTP_PASS ?? '',
    from: process.env.SMTP_FROM ?? 'noreply@flyte.fly.dev',
  },
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10),
  accountLockThreshold: parseInt(process.env.ACCOUNT_LOCK_THRESHOLD ?? '10', 10),
  verificationTokenTtlHours: parseInt(process.env.VERIFICATION_TOKEN_TTL_HOURS ?? '24', 10),
  passwordResetTokenTtlHours: parseInt(process.env.PASSWORD_RESET_TOKEN_TTL_HOURS ?? '1', 10),
  seedAdminEmail: process.env.SEED_ADMIN_EMAIL ?? 'admin@flyte.local',
  seedAdminPassword: process.env.SEED_ADMIN_PASSWORD ?? 'changeme123',
  isProduction: process.env.NODE_ENV === 'production',
};
