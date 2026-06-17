/**
 * I1 — adminGuard + admin-route enumeration (AC-I1 ②; R1, S1).
 *
 * adminGuard must answer 404 (not 403, not a redirect) for every non-admin
 * caller so the admin area stays invisible. The four matrix cases:
 *   anonymous → 404, active non-admin → 404, locked admin → 404, admin → 200.
 *
 * The enumeration test is structural: it asks the Hono router for every
 * registered /admin route and asserts each one 404s without an admin session.
 * That catches a future controller wired without the guard — without anyone
 * having to maintain a hand-written route list (plan §4 security regression).
 *
 * Run: npx tsx src/web/testing/admin-guard.test.ts
 */
import 'dotenv/config';
import { testSql, assert, assertEqual } from '../../registration/testing/test-helpers.js';
import { authService } from '../../services/auth-service.js';
import { createSession } from '../middleware/session.js';

const ADMIN_EMAIL = 'guard-admin@example.com';
const LOCKED_ADMIN_EMAIL = 'guard-locked-admin@example.com';
const USER_EMAIL = 'guard-user@example.com';
const PASSWORD = 'guard-test-password';

async function cleanup(): Promise<void> {
  const emails = [ADMIN_EMAIL, LOCKED_ADMIN_EMAIL, USER_EMAIL];
  const ids = await testSql`SELECT id FROM users WHERE email = ANY(${emails})`;
  if (ids.length > 0) {
    const idList = ids.map((r) => r.id as string);
    await testSql`DELETE FROM login_events WHERE user_id = ANY(${idList})`;
    await testSql`DELETE FROM user_action_events WHERE user_id = ANY(${idList})`;
    await testSql`DELETE FROM sessions WHERE user_id = ANY(${idList})`;
  }
  await testSql`DELETE FROM users WHERE email = ANY(${emails})`;
}

async function makeUser(email: string, opts: { isAdmin: boolean; isLocked?: boolean }): Promise<string> {
  const hash = await authService.hashPassword(PASSWORD);
  const rows = await testSql`
    INSERT INTO users (email, password_hash, display_name, is_verified, is_admin, is_locked, account_status)
    VALUES (${email}, ${hash}, 'Guard Test', TRUE, ${opts.isAdmin}, ${opts.isLocked ?? false}, 'active')
    RETURNING id
  `;
  return rows[0].id as string;
}

/** A signed session cookie bound to userId, as the app would issue at login. */
async function sessionCookie(userId: string): Promise<string> {
  const { signedSid } = await createSession({ userId }, userId);
  return `sid=${signedSid}`;
}

async function get(path: string, cookie?: string): Promise<number> {
  const { app } = await import('../app.js');
  const resp = await app.request(`http://localhost${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
  return resp.status;
}

async function runTests() {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => Promise<void>) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}:`, e instanceof Error ? e.message : String(e)); failed++; }
  }

  console.log('\n=== I1: adminGuard + Route Enumeration ===\n');

  await cleanup();
  const adminId = await makeUser(ADMIN_EMAIL, { isAdmin: true });
  const lockedAdminId = await makeUser(LOCKED_ADMIN_EMAIL, { isAdmin: true, isLocked: true });
  const userId = await makeUser(USER_EMAIL, { isAdmin: false });

  // ── The four-case matrix on /admin ──
  await test('anonymous → 404', async () => {
    assertEqual(await get('/admin'), 404, 'anonymous must 404');
  });

  await test('active non-admin → 404', async () => {
    assertEqual(await get('/admin', await sessionCookie(userId)), 404, 'non-admin must 404');
  });

  await test('locked admin → 404', async () => {
    assertEqual(await get('/admin', await sessionCookie(lockedAdminId)), 404, 'locked admin must 404');
  });

  await test('admin → 200', async () => {
    assertEqual(await get('/admin', await sessionCookie(adminId)), 200, 'admin must 200');
  });

  // ── Structural: every registered /admin route 404s without admin ──
  await test('every /admin route 404s for an anonymous caller', async () => {
    const { app } = await import('../app.js');
    // Hono exposes registered routes; collect the distinct /admin paths.
    const adminPaths = Array.from(new Set(
      (app.routes as Array<{ path: string }>)
        .map((r) => r.path)
        .filter((p) => p === '/admin' || p.startsWith('/admin/')),
    ));
    assert(adminPaths.length >= 1, 'expected at least one /admin route registered');
    for (const p of adminPaths) {
      // Substitute any :param with a syntactically valid placeholder.
      const concrete = p.replace(/:[A-Za-z0-9_]+/g, '00000000-0000-0000-0000-000000000000');
      const status = await get(concrete);
      assert(status === 404, `${p} must 404 for anonymous, got ${status}`);
    }
  });

  // W2: admins get an Admin nav link (and reach /admin); non-admins don't.
  await test('nav shows an Admin link for admins only', async () => {
    const { app } = await import('../app.js');
    const adminBody = await (await app.request('http://localhost/', { headers: { Cookie: await sessionCookie(adminId) } })).text();
    assert(adminBody.includes('href="/admin"'), 'admin sees an Admin link');
    const userBody = await (await app.request('http://localhost/', { headers: { Cookie: await sessionCookie(userId) } })).text();
    assert(!userBody.includes('href="/admin"'), 'non-admin does not see an Admin link');
  });

  await cleanup();

  console.log(`\n=== adminGuard: ${passed} passed, ${failed} failed ===`);
  await testSql.end();
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
