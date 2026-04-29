import 'dotenv/config';
import postgres from 'postgres';
import bcrypt from 'bcryptjs';

const sql = postgres(process.env.DATABASE_URL ?? 'postgres://flyte:flyte@localhost:5432/flyte');

async function seed() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@flyte.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'changeme123';
  const rounds = parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10);

  const passwordHash = await bcrypt.hash(adminPassword, rounds);

  // Upsert: insert or update based on email
  await sql`
    INSERT INTO users (email, display_name, password_hash, is_verified, is_admin)
    VALUES (${adminEmail}, 'Admin', ${passwordHash}, TRUE, TRUE)
    ON CONFLICT DO NOTHING
  `;

  await sql`
    UPDATE users
    SET password_hash = ${passwordHash}, is_verified = TRUE, is_admin = TRUE, display_name = 'Admin'
    WHERE LOWER(email) = LOWER(${adminEmail})
  `;

  console.log(`✓ Admin user seeded: ${adminEmail}`);
  await sql.end();
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
