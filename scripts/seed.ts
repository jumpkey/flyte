import 'dotenv/config';
import postgres from 'postgres';
import bcrypt from 'bcryptjs';

const sql = postgres(process.env.DATABASE_URL ?? 'postgres://flyte:flyte@localhost:5432/flyte');

async function seed() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@flyte.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;

  // Mirror the SESSION_SECRET production guard in src/config.ts: never let a
  // production deployment end up with the publicly known default password.
  if (process.env.NODE_ENV === 'production' && !adminPassword) {
    throw new Error('SEED_ADMIN_PASSWORD environment variable must be set when seeding in production');
  }

  const rounds = parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10);
  const passwordHash = await bcrypt.hash(adminPassword ?? 'changeme123', rounds);

  // Insert-only: if the admin user already exists, leave it untouched so a
  // re-run of the seeder can never reset a changed password back to the
  // seed value.
  const inserted = await sql`
    INSERT INTO users (email, display_name, password_hash, is_verified, is_admin)
    VALUES (${adminEmail}, 'Admin', ${passwordHash}, TRUE, TRUE)
    ON CONFLICT (LOWER(email)) DO NOTHING
    RETURNING id
  `;

  if (inserted.length > 0) {
    console.log(`✓ Admin user seeded: ${adminEmail}`);
    if (!adminPassword) {
      console.log('  (development default password in use — set SEED_ADMIN_PASSWORD to override)');
    }
  } else {
    console.log(`✓ Admin user already exists, left unmodified: ${adminEmail}`);
  }
  await sql.end();
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
