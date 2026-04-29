import 'dotenv/config';
import postgres from 'postgres';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = postgres(process.env.DATABASE_URL ?? 'postgres://flyte:flyte@localhost:5432/flyte');

async function migrate() {
  const migrationsDir = path.join(__dirname, '../db/migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    console.log(`Running migration: ${file}`);
    const content = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    const upSection = content.split('-- migrate:down')[0].replace('-- migrate:up', '').trim();
    await sql.unsafe(upSection);
    console.log(`✓ ${file}`);
  }

  await sql.end();
  console.log('Migrations complete!');
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
