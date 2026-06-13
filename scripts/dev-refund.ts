import 'dotenv/config';

// Pilot harness (Document 7 §3): drives the production RefundService from
// the CLI so refunds can be tested against sandbox AND live Stripe without
// building the admin UI early. Exercises the exact code path increment I5
// will expose over HTTP.
//
//   npx tsx scripts/dev-refund.ts <registrationId>              # full refund
//   npx tsx scripts/dev-refund.ts <registrationId> 500          # partial: $5.00

async function main() {
  const [registrationId, amountArg] = process.argv.slice(2);
  if (!registrationId) {
    console.error('usage: npx tsx scripts/dev-refund.ts <registrationId> [partialAmountCents]');
    process.exit(1);
  }
  const partialAmountCents = amountArg ? parseInt(amountArg, 10) : undefined;
  if (amountArg && (!Number.isInteger(partialAmountCents) || partialAmountCents! <= 0)) {
    console.error('partialAmountCents must be a positive integer (cents)');
    process.exit(1);
  }

  const { getStripe } = await import('../src/registration/stripe-factory.js');
  const { RefundService } = await import('../src/registration/services/RefundService.js');
  const { NotificationService } = await import('../src/registration/services/NotificationService.js');
  const { sql } = await import('../src/services/db.js');

  const stripe = await getStripe();
  const service = new RefundService(stripe, new NotificationService());

  const result = await service.refundRegistration({
    registrationId,
    refundType: partialAmountCents ? 'PARTIAL' : 'FULL',
    partialAmountCents,
    reason: 'pilot_dev_refund',
  });

  console.log(JSON.stringify(result, null, 2));
  const rows = await sql`
    SELECT status, gross_amount_cents, refunded_amount_cents, stripe_refund_id
    FROM registrations WHERE registration_id = ${registrationId}
  `;
  console.log('registration now:', JSON.stringify(rows[0] ?? null, null, 2));
  await sql.end();
  process.exit(result.outcome === 'SUCCESS' || result.outcome === 'ALREADY_REFUNDED' ? 0 : 2);
}

main().catch((err) => { console.error(err); process.exit(1); });
