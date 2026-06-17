/**
 * I1 — global loadUser middleware (bug #28).
 *
 * Before loadUser, c.set('user') ran only inside authGuard, so public pages
 * rendered the logged-out nav (Log in / Sign up) even for a signed-in user.
 * loadUser now populates the user for any valid session, so the shared nav is
 * auth-aware everywhere. Proven on a genuinely public, non-redirecting page
 * (the registration form): a logged-in caller sees Dashboard + Sign out;
 * an anonymous caller sees Log in.
 *
 * Run: npx tsx src/web/testing/load-user.test.ts
 */
import 'dotenv/config';
import { testSql, assert, assertEqual } from '../../registration/testing/test-helpers.js';
import { authService } from '../../services/auth-service.js';
import { createSession } from '../middleware/session.js';

const EMAIL = 'loaduser-nav@example.com';

async function cleanup(userId?: string): Promise<void> {
  const ids = userId
    ? [userId]
    : (await testSql`SELECT id FROM users WHERE email = ${EMAIL}`).map((r) => r.id as string);
  if (ids.length > 0) {
    await testSql`DELETE FROM login_events WHERE user_id = ANY(${ids})`;
    await testSql`DELETE FROM sessions WHERE user_id = ANY(${ids})`;
    await testSql`DELETE FROM users WHERE id = ANY(${ids})`;
  }
}

async function runTests() {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => Promise<void>) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}:`, e instanceof Error ? e.message : String(e)); failed++; }
  }

  console.log('\n=== I1: loadUser auth-aware nav (#28) ===\n');

  await cleanup();
  const hash = await authService.hashPassword('loaduser-pass');
  const userRows = await testSql`
    INSERT INTO users (email, password_hash, display_name, is_verified, account_status)
    VALUES (${EMAIL}, ${hash}, 'Nav User', TRUE, 'active') RETURNING id`;
  const userId = userRows[0].id as string;
  const { signedSid } = await createSession({ userId }, userId);

  const evRows = await testSql`
    INSERT INTO events (name, event_date, total_capacity, confirmed_count, available_slots, registration_fee_cents, status)
    VALUES ('LoadUser Event', now() + interval '20 days', 10, 0, 10, 2500, 'OPEN') RETURNING event_id`;
  const eventId = evRows[0].event_id as string;
  const publicPath = `http://localhost/events/${eventId}/register`;

  const { app } = await import('../app.js');

  await test('logged-in user sees the authed nav on a public page', async () => {
    const resp = await app.request(publicPath, { headers: { Cookie: `sid=${signedSid}` } });
    assertEqual(resp.status, 200, 'registration form should render');
    const html = await resp.text();
    assert(html.includes('Dashboard'), 'authed nav should link to Dashboard');
    assert(html.includes('Sign out'), 'authed nav should offer Sign out');
    assert(!html.includes('>Log in<'), 'authed nav should not show Log in');
  });

  await test('anonymous user sees the logged-out nav on the same page', async () => {
    const resp = await app.request(publicPath);
    assertEqual(resp.status, 200, 'registration form should render');
    const html = await resp.text();
    assert(html.includes('Log in'), 'anonymous nav should show Log in');
    assert(!html.includes('Sign out'), 'anonymous nav should not show Sign out');
  });

  await testSql`DELETE FROM events WHERE event_id = ${eventId}`;
  await cleanup(userId);

  console.log(`\n=== loadUser: ${passed} passed, ${failed} failed ===`);
  await testSql.end();
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
