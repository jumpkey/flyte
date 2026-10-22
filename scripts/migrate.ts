import 'dotenv/config';
import postgres from 'postgres';
import fs from 'fs';
import path from 'path';

const sql = postgres(process.env.DATABASE_URL ?? 'postgres://flyte:flyte@localhost:5432/flyte', {
  onnotice: () => {}, // suppress NOTICE messages
});

// Session-level lock serializes the complete migration run across processes;
// each individual migration still commits atomically with its schema marker.
const MIGRATION_LOCK_KEY = '7419302611';

function readUpSection(filename: string): string {
  const content = fs.readFileSync(filename, 'utf-8');
  const upMarker = '-- migrate:up';
  const downMarker = '-- migrate:down';
  const upStart = content.indexOf(upMarker);
  if (upStart < 0) throw new Error(`${filename} is missing ${upMarker}`);
  const downStart = content.indexOf(downMarker, upStart + upMarker.length);
  const body = content.slice(upStart + upMarker.length, downStart < 0 ? content.length : downStart).trim();
  if (!body) throw new Error(`${filename} has an empty up migration`);
  return body;
}

async function migrate(): Promise<void> {
  const connection = await sql.reserve();
  let locked = false;
  try {
    await connection`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`;
    locked = true;

    await connection.unsafe(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationsDir = path.join(process.cwd(), 'db/migrations');
    const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.sql')).sort();
    const appliedRows = await connection<{ filename: string }[]>`SELECT filename FROM schema_migrations`;
    const applied = new Set(appliedRows.map((row) => row.filename));

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`Skipping (already applied): ${file}`);
        continue;
      }
      console.log(`Running migration: ${file}`);
      const upSql = readUpSection(path.join(migrationsDir, file));
      await connection.unsafe('BEGIN');
      try {
        // unsafe is intentional: migration files contain multiple statements,
        // including function bodies. Any failure rolls back all of them.
        await connection.unsafe(upSql);
        await connection`INSERT INTO schema_migrations (filename) VALUES (${file})`;
        await connection.unsafe('COMMIT');
      } catch (error) {
        await connection.unsafe('ROLLBACK');
        throw error;
      }
      console.log(`✓ ${file}`);
    }
    console.log('Migrations complete!');
  } finally {
    if (locked) {
      try {
        await connection`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`;
      } catch (error) {
        console.error('Failed to release migration advisory lock:', error);
      }
    }
    connection.release();
  }
}

try {
  await migrate();
} catch (err) {
  console.error('Migration failed:', err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
