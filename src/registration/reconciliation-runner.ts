// Entry point for the scheduled reconciliation job.
// Executed by supercronic every 5 minutes.

import 'dotenv/config';

async function main(): Promise<void> {
  const requiredEnv = ['STRIPE_SECRET_KEY', 'DATABASE_URL'];
  for (const key of requiredEnv) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  const ttlMinutes        = parseInt(process.env.REGISTRATION_TTL_MINUTES ?? '30', 10);
  const captureMaxRetries = parseInt(process.env.CAPTURE_MAX_RETRIES ?? '5', 10);

  console.log(`[reconciliation] sweep starting at ${new Date().toISOString()}`);

  const { getStripe } = await import('./stripe-factory.js');
  const { ReconciliationService } = await import('./services/ReconciliationService.js');
  const { RegistrationService }   = await import('./services/RegistrationService.js');
  const { NotificationService }   = await import('./services/NotificationService.js');
  const { sql }                   = await import('../services/db.js');

  const stripe = await getStripe();

  const notificationService  = new NotificationService();
  const registrationService  = new RegistrationService(stripe, notificationService);
  const reconciliationService = new ReconciliationService(
    stripe,
    registrationService,
    notificationService,
    { captureMaxRetries }
  );

  try {
    const result = await reconciliationService.reconcilePendingRegistrations(ttlMinutes);

    console.log(`[reconciliation] sweep complete:`, JSON.stringify(result, null, 2));

    if (result.errorCount > 0) {
      console.warn(`[reconciliation] ${result.errorCount} errors encountered during sweep`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('[reconciliation] fatal error:', err);
  process.exit(1);
});
