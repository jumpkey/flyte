import 'dotenv/config';
import postgres from 'postgres';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = postgres(process.env.DATABASE_URL ?? 'postgres://flyte:flyte@localhost:5432/flyte', {
  onnotice: () => {}, // suppress NOTICE messages
});

async function migrate() {
  // Create migrations tracking table if it doesn't exist
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const migrationsDir = path.join(__dirname, '../db/migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  // Get already-applied migrations
  const applied = await sql<{ filename: string }[]>`SELECT filename FROM schema_migrations`;
  const appliedSet = new Set(applied.map(r => r.filename));

  for (const file of files) {
    if (appliedSet.has(file)) {
      console.log(`Skipping (already applied): ${file}`);
      continue;
    }
    console.log(`Running migration: ${file}`);
    const content = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    const upSection = content.split('-- migrate:down')[0].replace('-- migrate:up', '').trim();
    try {
      await sql.unsafe(upSection);
    } catch (err: unknown) {
      const pgErr = err as { code?: string; message?: string };
      // If the object already exists (42P07 = duplicate_table, 42710 = duplicate_object),
      // treat as already applied and record it so future runs skip it.
      if (pgErr.code === '42P07' || pgErr.code === '42710') {
        console.log(`  (objects already exist, recording as applied)`);
      } else {
        throw err;
      }
    }
    await sql`INSERT INTO schema_migrations (filename) VALUES (${file}) ON CONFLICT DO NOTHING`;
    console.log(`✓ ${file}`);
  }

  await sql.end();
  console.log('Migrations complete!');
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
