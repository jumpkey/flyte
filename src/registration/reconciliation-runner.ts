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
  const stripeTimeout     = parseInt(process.env.STRIPE_API_TIMEOUT_MS ?? '10000', 10);

  console.log(`[reconciliation] sweep starting at ${new Date().toISOString()}`);

  const { default: Stripe } = await import('stripe');
  const { ReconciliationService } = await import('./services/ReconciliationService.js');
  const { RegistrationService }   = await import('./services/RegistrationService.js');
  const { NotificationService }   = await import('./services/NotificationService.js');

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-04-22.dahlia' as const,
    timeout: stripeTimeout,
  });

  const notificationService  = new NotificationService();
  const registrationService  = new RegistrationService(stripe as any, notificationService);
  const reconciliationService = new ReconciliationService(
    stripe as any,
    registrationService,
    notificationService,
    { captureMaxRetries }
  );

  const result = await reconciliationService.reconcilePendingRegistrations(ttlMinutes);

  console.log(`[reconciliation] sweep complete:`, JSON.stringify(result, null, 2));

  if (result.errorCount > 0) {
    console.warn(`[reconciliation] ${result.errorCount} errors encountered during sweep`);
  }
}

main().catch((err) => {
  console.error('[reconciliation] fatal error:', err);
  process.exit(1);
});
