import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const baseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!baseUrl) throw new Error('TEST_DATABASE_URL or DATABASE_URL is required');

function runMigrationRunner(cwd: string, databaseUrl: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(projectRoot, 'node_modules/.bin/tsx'), [path.join(projectRoot, 'scripts/migrate.ts')], {
      cwd,
      env: { ...process.env, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, output }));
  });
}

async function main(): Promise<void> {
  const schema = `migration_test_${crypto.randomUUID().replaceAll('-', '')}`;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'flyte-migration-test-'));
  const migrationDir = path.join(tempRoot, 'db/migrations');
  fs.mkdirSync(migrationDir, { recursive: true });
  const migrationPath = path.join(migrationDir, '001_guard.sql');
  const scopedUrl = new URL(baseUrl!);
  scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
  const dbUrl = scopedUrl.toString();
  const adminSql = postgres(baseUrl!, { max: 1 });
  const scopedSql = postgres(dbUrl, { max: 1 });

  try {
    await adminSql.unsafe(`CREATE SCHEMA ${schema}`);
    fs.writeFileSync(migrationPath, `-- migrate:up\nCREATE TABLE migration_should_rollback (id INT);\nSELECT 1 / 0;\n-- migrate:down\nDROP TABLE migration_should_rollback;\n`);
    const failed = await runMigrationRunner(tempRoot, dbUrl);
    assert.notEqual(failed.code, 0, 'a broken migration must fail the process');
    const rolledBack = await scopedSql`SELECT to_regclass('migration_should_rollback') AS table_name`;
    assert.equal(rolledBack[0].table_name, null, 'DDL before the error is rolled back');
    const markers = await scopedSql`SELECT count(*)::int AS count FROM schema_migrations`;
    assert.equal(markers[0].count, 0, 'failed migration is not marked applied');

    fs.writeFileSync(migrationPath, `-- migrate:up\nCREATE TABLE migration_should_apply (id INT);\nSELECT pg_sleep(0.2);\n-- migrate:down\nDROP TABLE migration_should_apply;\n`);
    const [first, second] = await Promise.all([
      runMigrationRunner(tempRoot, dbUrl),
      runMigrationRunner(tempRoot, dbUrl),
    ]);
    assert.equal(first.code, 0, `first concurrent runner failed: ${first.output}`);
    assert.equal(second.code, 0, `second concurrent runner failed: ${second.output}`);
    const applied = await scopedSql`SELECT count(*)::int AS count FROM schema_migrations WHERE filename = '001_guard.sql'`;
    assert.equal(applied[0].count, 1, 'concurrent runners record one applied marker');
    const table = await scopedSql`SELECT to_regclass('migration_should_apply') AS table_name`;
    assert.equal(table[0].table_name, 'migration_should_apply', 'migration effect exists once');
    console.log('Migration runner: rollback, fail-closed marker, and concurrent serialization passed');
  } finally {
    await scopedSql.end();
    await adminSql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminSql.end();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
