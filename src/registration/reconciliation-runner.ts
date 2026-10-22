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
  const { RefundService } = await import('./services/RefundService.js');
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
    await sql`INSERT INTO recovery_status(name,started_at,finished_at,error_count) VALUES('payments',now(),NULL,0)
      ON CONFLICT(name) DO UPDATE SET started_at=now(),finished_at=NULL,error_count=0`;
    const result = await reconciliationService.reconcilePendingRegistrations(ttlMinutes);

    const refunds = new RefundService(stripe, notificationService);
    const completedRefunds = await refunds.reconcilePendingRefunds();
    const cancelling = await sql`SELECT event_id FROM events WHERE status = 'CANCELLING'`;
    for (const event of cancelling) await refunds.refundEvent({ eventId: event.event_id, refundType: 'FULL', reason: 'event_cancelled' });
    console.log(`[reconciliation] refunds completed: ${completedRefunds}; cancellations checked: ${cancelling.length}`);
    console.log(`[reconciliation] sweep complete:`, JSON.stringify(result, null, 2));

    const pendingRefunds = await sql`SELECT count(*)::int n FROM refund_operations WHERE status='PENDING'`;
    const pendingCancellations = await sql`SELECT count(*)::int n FROM events WHERE status='CANCELLING'`;
    const errors = result.errorCount + pendingRefunds[0].n + pendingCancellations[0].n;
    await sql`UPDATE recovery_status SET finished_at=now(),error_count=${errors} WHERE name='payments'`;
    if (errors > 0) {
      console.warn(`[reconciliation] ${errors} unresolved items encountered during sweep`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('[reconciliation] fatal error:', err);
  process.exit(1);
});
