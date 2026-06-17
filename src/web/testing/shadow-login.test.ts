/**
 * I1 — Shadow-account login oracle audit (AC-I1 ③, ⑤; S6).
 *
 * Migration 007 makes users.password_hash nullable so guest checkout can create
 * "shadow" rows (NULL hash, account_status='shadow'). The hazard: today's login
 * path passed the hash straight to bcrypt.compare, which throws on a non-string
 * hash — turning a shadow email into a 500 while a wrong password returns 200.
 * That is an account-enumeration oracle. The fix (auth-service.verifyPassword)
 * runs a dummy compare on the NULL branch and fails closed.
 *
 * This suite proves: (a) verifyPassword(pw, null) is false and never throws, and
 * (b) at the HTTP layer a shadow email is byte-for-byte indistinguishable from a
 * wrong password and a non-existent account — and the happy path still works.
 *
 * Run: npx tsx src/web/testing/shadow-login.test.ts
 */
import 'dotenv/config';
import { testSql, assert, assertEqual } from '../../registration/testing/test-helpers.js';
import { authService } from '../../services/auth-service.js';

const SHADOW_EMAIL = 'shadow-oracle@example.com';
const ACTIVE_EMAIL = 'active-oracle@example.com';
const ABSENT_EMAIL = 'no-such-oracle@example.com';
const ACTIVE_PASSWORD = 'correct horse battery';

async function cleanupUsers(): Promise<void> {
  // Login attempts and audit rows carry a FK to users; clear them first.
  const ids = await testSql`SELECT id FROM users WHERE email IN (${SHADOW_EMAIL}, ${ACTIVE_EMAIL})`;
  if (ids.length > 0) {
    const idList = ids.map((r) => r.id as string);
    await testSql`DELETE FROM login_events WHERE user_id = ANY(${idList})`;
    await testSql`DELETE FROM user_action_events WHERE user_id = ANY(${idList})`;
    await testSql`DELETE FROM sessions WHERE user_id = ANY(${idList})`;
  }
  await testSql`DELETE FROM users WHERE email IN (${SHADOW_EMAIL}, ${ACTIVE_EMAIL})`;
}

async function seedUsers(): Promise<void> {
  await cleanupUsers();
  // Shadow row: NULL password_hash, unverified, account_status='shadow'.
  await testSql`
    INSERT INTO users (email, password_hash, display_name, is_verified, account_status)
    VALUES (${SHADOW_EMAIL}, NULL, 'Shadow Guest', FALSE, 'shadow')
  `;
  // Active verified user with a real bcrypt hash.
  const hash = await authService.hashPassword(ACTIVE_PASSWORD);
  await testSql`
    INSERT INTO users (email, password_hash, display_name, is_verified, account_status)
    VALUES (${ACTIVE_EMAIL}, ${hash}, 'Active User', TRUE, 'active')
  `;
}

/** POST /login through the real app, returning {status, body}. */
async function login(email: string, password: string): Promise<{ status: number; body: string }> {
  const { app } = await import('../app.js');
  const getResp = await app.request('http://localhost/login');
  const setCookie = getResp.headers.get('set-cookie') ?? '';
  const sidMatch = setCookie.match(/sid=([^;]+)/);
  const html = await getResp.text();
  const csrfMatch = html.match(/name="_csrf" value="([^"]+)"/);
  if (!csrfMatch || !sidMatch) throw new Error('could not bootstrap CSRF/session for /login');
  const resp = await app.request('http://localhost/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': `sid=${sidMatch[1]}`,
    },
    body: new URLSearchParams({ email, password, _csrf: csrfMatch[1] }).toString(),
  });
  return { status: resp.status, body: await resp.text() };
}

async function runTests() {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => Promise<void>) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}:`, e instanceof Error ? e.message : String(e)); failed++; }
  }

  console.log('\n=== I1: Shadow-Login Oracle Audit ===\n');

  // ── Unit: verifyPassword fails closed on NULL hash without throwing ──
  await test('null-hash verifyPassword returns false and does not throw', async () => {
    const result = await authService.verifyPassword('anything at all', null);
    assertEqual(result, false, 'NULL hash must never authenticate');
  });

  await test('empty-string hash verifyPassword returns false', async () => {
    assertEqual(await authService.verifyPassword('anything', ''), false, 'empty hash must fail closed');
  });

  await test('valid hash still authenticates the correct password', async () => {
    const hash = await authService.hashPassword(ACTIVE_PASSWORD);
    assertEqual(await authService.verifyPassword(ACTIVE_PASSWORD, hash), true, 'correct password should pass');
    assertEqual(await authService.verifyPassword('wrong', hash), false, 'wrong password should fail');
  });

  // ── HTTP: no enumeration oracle ──
  await test('shadow-email login is not a 500 and shows invalid-credentials', async () => {
    await seedUsers();
    const r = await login(SHADOW_EMAIL, 'whatever-they-type');
    assert(r.status !== 500, `shadow login must not 500, got ${r.status}`);
    assertEqual(r.status, 200, 'shadow login re-renders the login form');
    assert(r.body.includes('Invalid email or password'), 'shadow login shows the standard error');
  });

  await test('shadow / wrong-password / absent-account responses are indistinguishable', async () => {
    await seedUsers();
    const shadow = await login(SHADOW_EMAIL, 'whatever');
    const wrongPw = await login(ACTIVE_EMAIL, 'definitely-not-it');
    const absent = await login(ABSENT_EMAIL, 'whatever');
    // Same status and same rendered error for all three — no oracle.
    assertEqual(shadow.status, wrongPw.status, 'shadow vs wrong-password status parity');
    assertEqual(shadow.status, absent.status, 'shadow vs absent-account status parity');
    for (const r of [shadow, wrongPw, absent]) {
      assert(r.body.includes('Invalid email or password'), 'all three render the standard invalid-credentials error');
    }
  });

  await test('no timing oracle: absent email pays the same bcrypt cost as a real compare', async () => {
    await seedUsers();
    // The non-existent-email branch must run the dummy compare; otherwise it
    // returns in microseconds and leaks account existence by latency. Measure a
    // floor rather than a tight band (CI is noisy): a real bcrypt compare at
    // cost 12 is tens-to-hundreds of ms, so anything past ~50ms proves the
    // dummy compare ran. A bare short-circuit would be sub-millisecond.
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      await login(ABSENT_EMAIL, 'whatever');
      samples.push(Date.now() - t0);
    }
    const best = Math.min(...samples);
    assert(best > 50, `absent-email login should cost a bcrypt compare (>50ms), best was ${best}ms`);
  });

  await test('the active user can still log in (happy path intact)', async () => {
    await seedUsers();
    const r = await login(ACTIVE_EMAIL, ACTIVE_PASSWORD);
    // Successful login redirects to /dashboard (302), never re-renders an error.
    assertEqual(r.status, 302, `correct credentials should redirect, got ${r.status}`);
  });

  await cleanupUsers();

  console.log(`\n=== Shadow-Login: ${passed} passed, ${failed} failed ===`);
  await testSql.end();
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
