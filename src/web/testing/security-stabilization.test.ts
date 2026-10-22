import 'dotenv/config';
import { testSql, assert, assertEqual } from '../../registration/testing/test-helpers.js';
import { authService } from '../../services/auth-service.js';
import { createSession } from '../middleware/session.js';
import { toCsv } from '../utils/csv.js';

const EMAIL = 'profile-security@example.com';
const CSRF = 'security-csrf-token-0123456789abcdef';

async function cleanup(): Promise<void> {
  const rows = await testSql`SELECT id FROM users WHERE email = ${EMAIL}`;
  if (rows.length) {
    await testSql`DELETE FROM sessions WHERE user_id = ${rows[0].id}`;
    await testSql`DELETE FROM user_action_events WHERE user_id = ${rows[0].id}`;
    await testSql`DELETE FROM login_events WHERE user_id = ${rows[0].id}`;
    await testSql`DELETE FROM users WHERE id = ${rows[0].id}`;
  }
}

async function runTests() {
  let passed = 0;
  let failed = 0;
  async function test(name: string, fn: () => Promise<void>) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}:`, e instanceof Error ? e.message : String(e)); failed++; }
  }

  console.log('\n=== Security stabilization ===\n');
  await test('CSV neutralizes formula text while preserving numeric values', async () => {
    const csv = toCsv(['value'], [['=1+1'], ['\t@SUM(A1)'], [-42]]);
    assert(csv.includes("' =1+1") === false, 'does not add an unexpected space');
    assert(csv.includes("'=1+1"), 'equals-prefixed text is literal');
    assert(csv.includes("'\t@SUM(A1)"), 'leading control whitespace is neutralized');
    assert(csv.includes('\r\n-42\r\n'), 'negative numeric column remains numeric');
  });

  await test('email availability hint has the same response for existing and absent addresses', async () => {
    await cleanup();
    await testSql`INSERT INTO users (email,password_hash,display_name,is_verified,account_status)
      VALUES (${EMAIL},'unused','Existing',TRUE,'active')`;
    const { app } = await import('../app.js');
    const responseFor = async (email: string) => app.request('http://localhost/api/check-email', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email }).toString(),
    });
    const existing = await responseFor('someone@example.com');
    const absent = await responseFor('nobody@example.invalid');
    assertEqual(existing.status, absent.status, 'status is independent of membership');
    assertEqual(await existing.text(), await absent.text(), 'body is independent of membership');
    await cleanup();
  });

  await test('only one concurrent reset can consume a token', async () => {
    await cleanup();
    const { userService } = await import('../../services/user-service.js');
    const user = await userService.findOrCreateShadowUser(EMAIL, 'Reset Race');
    const token = authService.generateToken();
    await userService.setPasswordResetToken(user.id, token.hashed, new Date(Date.now() + 3600_000));
    const [first, second] = await Promise.all([
      authService.hashPassword('first-password-123'),
      authService.hashPassword('second-password-123'),
    ]).then(async (hashes) => Promise.all(hashes.map((hash) => userService.resetPassword(token.hashed, hash))));
    assertEqual(Number(first !== null) + Number(second !== null), 1, 'one update consumes the token exactly once');
    await cleanup();
  });

  await test('request body limit returns 413 before public form processing', async () => {
    const { app } = await import('../app.js');
    const oversized = 'x'.repeat(64 * 1024 + 1);
    const response = await app.request('http://localhost/api/check-email', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: oversized,
    });
    assertEqual(response.status, 413, 'oversized form is rejected');
  });

  await test('JSON registration requests have a narrow limit before CSRF/body parsing', async () => {
    const { app } = await import('../app.js');
    const response = await app.request('http://localhost/events/00000000-0000-0000-0000-000000000001/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(128 * 1024) }),
    });
    assertEqual(response.status, 413, 'oversized JSON is rejected');
  });

  await test('raw Stripe webhook has its tighter body limit', async () => {
    const { app } = await import('../app.js');
    const response = await app.request('http://localhost/webhooks/stripe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(1024 * 1024 + 1),
    });
    assertEqual(response.status, 413, 'oversized webhook is rejected before handler/signature parsing');
  });

  await test('profile password change rotates the current session and revokes others', async () => {
    await cleanup();
    const oldHash = await authService.hashPassword('current-password');
    const inserted = await testSql`INSERT INTO users (email,password_hash,display_name,is_verified,account_status)
      VALUES (${EMAIL},${oldHash},'Profile Test',TRUE,'active') RETURNING id`;
    const userId = inserted[0].id as string;
    const current = await createSession({ userId, csrfToken: CSRF }, userId);
    const other = await createSession({ userId, csrfToken: CSRF }, userId);
    const { app } = await import('../app.js');
    const formPage = await app.request('http://localhost/profile', { headers: { Cookie: `sid=${current.signedSid}` } });
    const formHtml = await formPage.text();
    assert(formHtml.includes('method="post" action="/profile"'), 'profile form has safe native POST fallback');
    const response = await app.request('http://localhost/profile', {
      method: 'POST',
      headers: { Cookie: `sid=${current.signedSid}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: CSRF, currentPassword: 'current-password', newPassword: 'new-password-123', confirmPassword: 'new-password-123' }).toString(),
    });
    assertEqual(response.status, 200, 'non-HTMX post returns full page');
    const page = await response.text();
    assert(page.includes('Profile updated successfully'), 'full-page response gives confirmation');
    const cookie = response.headers.get('set-cookie') ?? '';
    assert(cookie.includes('sid=') && !cookie.includes(encodeURIComponent(current.signedSid)), 'current cookie is rotated');
    const rotatedCookie = cookie.split(';', 1)[0];
    const newSessionPage = await app.request('http://localhost/dashboard', { headers: { Cookie: rotatedCookie } });
    assertEqual(newSessionPage.status, 200, 'rotated session remains authenticated');
    const oldSessionPage = await app.request('http://localhost/dashboard', { headers: { Cookie: `sid=${encodeURIComponent(current.signedSid)}` } });
    assertEqual(oldSessionPage.status, 302, 'old session is rejected after password change');
    const live = await testSql`SELECT sid FROM sessions WHERE user_id=${userId}`;
    assertEqual(live.length, 1, 'only the rotated current session remains');
    assert(live[0].sid !== current.sid && live[0].sid !== other.sid, 'both previous session ids are gone');
    await cleanup();
  });

  await test('CSP permits blob image previews', async () => {
    const { app } = await import('../app.js');
    const response = await app.request('http://localhost/');
    const csp = response.headers.get('content-security-policy') ?? '';
    assert(csp.includes("img-src 'self' data: blob: https:"), 'image source includes blob');
  });

  console.log(`\n=== Security summary: ${passed} passed, ${failed} failed ===`);
  if (failed) process.exit(1);
}

runTests().catch((error) => { console.error(error); process.exit(1); });
