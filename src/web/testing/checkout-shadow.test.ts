/**
 * I3 — Checkout & shadow accounts (AC-I3 ①–⑥).
 *
 * The D1 core: find-or-create shadow users (never mutating existing rows),
 * the guest email double-entry, session-wins for logged-in checkout, the
 * forgot/reset activation chain (shadow → active+verified, with guest purchases
 * becoming visible by user_id), and the waitlist email-confirm + D6 gate.
 *
 * The full Stripe checkout isn't exercised here (no Stripe in CI — the engine's
 * own suites cover that); we test the buyer-resolution logic that runs before
 * Stripe and the activation flow end to end at the DB/HTTP layer.
 *
 * Run: npx tsx src/web/testing/checkout-shadow.test.ts
 */
import 'dotenv/config';
import { testSql, truncateTables, assert, assertEqual } from '../../registration/testing/test-helpers.js';
import { userService } from '../../services/user-service.js';
import { authService } from '../../services/auth-service.js';
import { createSession } from '../middleware/session.js';

async function deleteUser(email: string): Promise<void> {
  const ids = (await testSql`SELECT id FROM users WHERE LOWER(email)=LOWER(${email})`).map((r) => r.id as string);
  if (ids.length) {
    await testSql`DELETE FROM registrations WHERE user_id = ANY(${ids})`;
    await testSql`DELETE FROM waitlist_entries WHERE user_id = ANY(${ids})`;
    await testSql`DELETE FROM login_events WHERE user_id = ANY(${ids})`;
    await testSql`DELETE FROM user_action_events WHERE user_id = ANY(${ids})`;
    await testSql`DELETE FROM sessions WHERE user_id = ANY(${ids})`;
    await testSql`DELETE FROM users WHERE id = ANY(${ids})`;
  }
}

async function createEvent(status = 'OPEN', waitlistEnabled = true): Promise<string> {
  const rows = await testSql`
    INSERT INTO events (name, event_date, total_capacity, confirmed_count, available_slots, registration_fee_cents, status, waitlist_enabled)
    VALUES ('I3 Event', now() + interval '14 days', 10, ${status === 'FULL' ? 10 : 0}, ${status === 'FULL' ? 0 : 10}, 2500, ${status}, ${waitlistEnabled})
    RETURNING event_id`;
  return rows[0].event_id as string;
}

/** GET a page to bootstrap a CSRF token + session cookie. */
async function bootstrapCsrf(cookie?: string): Promise<{ csrf: string; sid: string }> {
  const { app } = await import('../app.js');
  const resp = await app.request('http://localhost/login', { headers: cookie ? { Cookie: cookie } : {} });
  const setCookie = resp.headers.get('set-cookie') ?? '';
  const sid = (cookie?.match(/sid=([^;]+)/)?.[1]) ?? setCookie.match(/sid=([^;]+)/)?.[1] ?? '';
  const csrf = (await resp.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] ?? '';
  return { csrf, sid };
}

async function runTests() {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => Promise<void>) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}:`, e instanceof Error ? e.message : String(e)); failed++; }
  }

  console.log('\n=== I3: Checkout & Shadow Accounts ===\n');

  // ── findOrCreateShadowUser (AC-I3 ①, ②) ──
  await test('creates a shadow row for a new email', async () => {
    await deleteUser('newguest@example.com');
    const u = await userService.findOrCreateShadowUser('NewGuest@Example.com', 'New Guest');
    assertEqual(u.accountStatus, 'shadow', 'account_status shadow');
    assertEqual(u.passwordHash, null, 'no password');
    assertEqual(u.isVerified, false, 'unverified');
    assertEqual(u.email, 'newguest@example.com', 'email lowercased on create');
    await deleteUser('newguest@example.com');
  });

  await test('repeat guest checkout reuses the same shadow row, never re-naming it', async () => {
    await deleteUser('repeat@example.com');
    const a = await userService.findOrCreateShadowUser('repeat@example.com', 'First Name');
    const b = await userService.findOrCreateShadowUser('repeat@example.com', 'Totally Different');
    assertEqual(a.id, b.id, 'same shadow row reused');
    assertEqual(b.displayName, 'First Name', 'display_name set on create only');
    await deleteUser('repeat@example.com');
  });

  await test('never mutates an existing ACTIVE account', async () => {
    await deleteUser('active@example.com');
    const hash = await authService.hashPassword('realpassword');
    await testSql`INSERT INTO users (email, password_hash, display_name, is_verified, account_status) VALUES ('active@example.com', ${hash}, 'Real Person', TRUE, 'active')`;
    const u = await userService.findOrCreateShadowUser('Active@Example.com', 'Imposter Name');
    assertEqual(u.accountStatus, 'active', 'still active');
    assertEqual(u.displayName, 'Real Person', 'display_name untouched');
    assertEqual(u.passwordHash, hash, 'password untouched');
    assertEqual(u.isVerified, true, 'still verified');
    await deleteUser('active@example.com');
  });

  // ── Activation flip (AC-I3 ④) ──
  await test('resetPassword activates a shadow account (active + verified + password)', async () => {
    await deleteUser('activate@example.com');
    const shadow = await userService.findOrCreateShadowUser('activate@example.com', 'Guest');
    const newHash = await authService.hashPassword('brand-new-pw');
    await userService.resetPassword(shadow.id, newHash);
    const after = await userService.findById(shadow.id);
    assertEqual(after!.accountStatus, 'active', 'now active');
    assertEqual(after!.isVerified, true, 'now verified');
    assertEqual(after!.passwordHash, newHash, 'password set');
    await deleteUser('activate@example.com');
  });

  // ── forgot-password issues to shadow, not to locked (AC-I3 ④, ⑤) ──
  await test('forgot-password issues a reset token to a shadow account, generically', async () => {
    await deleteUser('shadowreset@example.com');
    const shadow = await userService.findOrCreateShadowUser('shadowreset@example.com', 'Guest');
    const { app } = await import('../app.js');
    const { csrf, sid } = await bootstrapCsrf();
    const resp = await app.request('http://localhost/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `sid=${sid}` },
      body: new URLSearchParams({ email: 'shadowreset@example.com', _csrf: csrf }).toString(),
    });
    const body = await resp.text();
    assert(body.includes('Check Your Email') || body.includes('check your email') || resp.status === 200, 'generic response');
    const row = await testSql`SELECT password_reset_token FROM users WHERE id = ${shadow.id}`;
    assert(row[0].password_reset_token !== null, 'reset token issued to shadow');
    await deleteUser('shadowreset@example.com');
  });

  await test('forgot-password refuses a LOCKED shadow account (no token)', async () => {
    await deleteUser('lockedshadow@example.com');
    const shadow = await userService.findOrCreateShadowUser('lockedshadow@example.com', 'Guest');
    await testSql`UPDATE users SET is_locked = TRUE WHERE id = ${shadow.id}`;
    const { app } = await import('../app.js');
    const { csrf, sid } = await bootstrapCsrf();
    await app.request('http://localhost/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `sid=${sid}` },
      body: new URLSearchParams({ email: 'lockedshadow@example.com', _csrf: csrf }).toString(),
    });
    const row = await testSql`SELECT password_reset_token FROM users WHERE id = ${shadow.id}`;
    assertEqual(row[0].password_reset_token, null, 'no token for locked account');
    await deleteUser('lockedshadow@example.com');
  });

  // ── Full J3 chain at the DB/HTTP layer (AC-I3 ④ payoff) ──
  await test('reset completes activation and reveals the guest purchase by user_id', async () => {
    await truncateTables();
    await deleteUser('payoff@example.com');
    const shadow = await userService.findOrCreateShadowUser('payoff@example.com', 'Guest');
    const eventId = await createEvent('OPEN');
    // A guest registration already bound to the shadow user (as checkout would).
    await testSql`
      INSERT INTO registrations (event_id, user_id, email, first_name, last_name, gross_amount_cents, status, confirmed_at)
      VALUES (${eventId}, ${shadow.id}, 'payoff@example.com', 'Pay', 'Off', 2500, 'CONFIRMED', now())`;
    // Issue a known reset token, then complete the reset over HTTP.
    const { raw, hashed } = authService.generateToken();
    await userService.setPasswordResetToken(shadow.id, hashed, new Date(Date.now() + 3600_000));
    const { app } = await import('../app.js');
    const { csrf, sid } = await bootstrapCsrf();
    const resp = await app.request('http://localhost/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `sid=${sid}` },
      body: new URLSearchParams({ token: raw, password: 'my-new-password', confirmPassword: 'my-new-password', _csrf: csrf }).toString(),
    });
    assertEqual(resp.status, 302, 'reset redirects on success');
    const after = await userService.findById(shadow.id);
    assertEqual(after!.accountStatus, 'active', 'activated');
    assertEqual(after!.isVerified, true, 'verified');
    // The J3 payoff: the guest purchase is bound to the now-active account.
    const regs = await testSql`SELECT registration_id FROM registrations WHERE user_id = ${shadow.id} AND status = 'CONFIRMED'`;
    assertEqual(regs.length, 1, 'guest purchase visible by user_id');
    await truncateTables();
    await deleteUser('payoff@example.com');
  });

  // ── Email double-entry over HTTP (AC-I3 ①, ③) ──
  await test('guest checkout with mismatched emails returns 400 email_mismatch', async () => {
    const eventId = await createEvent('OPEN');
    const { app } = await import('../app.js');
    const { csrf, sid } = await bootstrapCsrf();
    const resp = await app.request(`http://localhost/events/${eventId}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `sid=${sid}`, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ firstName: 'A', lastName: 'B', email: 'a@example.com', emailConfirm: 'different@example.com' }),
    });
    assertEqual(resp.status, 400, 'mismatch rejected');
    assertEqual((await resp.json()).error, 'email_mismatch', 'email_mismatch code');
    await testSql`DELETE FROM events WHERE event_id = ${eventId}`;
  });

  await test('logged-in checkout ignores email mismatch (session wins, no 400)', async () => {
    await deleteUser('loggedin@example.com');
    const hash = await authService.hashPassword('pw');
    const u = await testSql`INSERT INTO users (email, password_hash, display_name, is_verified, account_status) VALUES ('loggedin@example.com', ${hash}, 'LoggedIn', TRUE, 'active') RETURNING id`;
    const userId = u[0].id as string;
    const { signedSid } = await createSession({ userId }, userId);
    const eventId = await createEvent('OPEN');
    const { app } = await import('../app.js');
    const { csrf } = await bootstrapCsrf(`sid=${signedSid}`);
    const resp = await app.request(`http://localhost/events/${eventId}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `sid=${signedSid}`, 'X-CSRF-Token': csrf },
      // No emailConfirm and a different email — session must win, so NOT a 400 mismatch.
      body: JSON.stringify({ firstName: 'A', lastName: 'B', email: 'someoneelse@example.com' }),
    });
    assert(resp.status !== 400, `session should win, got ${resp.status}`);
    await testSql`DELETE FROM events WHERE event_id = ${eventId}`;
    await deleteUser('loggedin@example.com');
  });

  // ── Waitlist confirm + D6 gate (AC-I3 ⑥, D6) ──
  await test('waitlist guest mismatch re-renders the form with an error', async () => {
    const eventId = await createEvent('FULL', true);
    const { app } = await import('../app.js');
    const { csrf, sid } = await bootstrapCsrf();
    const resp = await app.request(`http://localhost/events/${eventId}/waitlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `sid=${sid}` },
      body: new URLSearchParams({ firstName: 'A', lastName: 'B', email: 'x@example.com', emailConfirm: 'y@example.com', _csrf: csrf }).toString(),
    });
    const body = await resp.text();
    assert(body.includes('do not match'), 'mismatch error shown');
    await testSql`DELETE FROM events WHERE event_id = ${eventId}`;
  });

  await test('waitlist is gated when waitlist_enabled is false (D6)', async () => {
    const eventId = await createEvent('FULL', false);
    const { app } = await import('../app.js');
    const get = await app.request(`http://localhost/events/${eventId}/waitlist`);
    assert((await get.text()).includes('Waitlist closed'), 'GET shows closed');
    await testSql`DELETE FROM events WHERE event_id = ${eventId}`;
  });

  // ── V7: live waitlist position (capability URL) ──
  await test('V7: /waitlist/:id shows the live position; 404 for unknown', async () => {
    await truncateTables();
    const eventId = await createEvent('FULL', true);
    const entry = await testSql`
      INSERT INTO waitlist_entries (event_id, email, first_name, last_name)
      VALUES (${eventId}, 'wl@example.com', 'Wait', 'List') RETURNING waitlist_entry_id`;
    const id = entry[0].waitlist_entry_id as string;
    const { app } = await import('../app.js');
    const r = await app.request(`http://localhost/waitlist/${id}`);
    assertEqual(r.status, 200, 'position page renders');
    const body = await r.text();
    assert(body.includes('Waitlist status') && body.includes('#1'), 'shows position #1');
    const missing = await app.request('http://localhost/waitlist/00000000-0000-0000-0000-000000000000');
    assertEqual(missing.status, 404, 'unknown entry 404s');
    await truncateTables();
  });

  await truncateTables();
  console.log(`\n=== Checkout-Shadow: ${passed} passed, ${failed} failed ===`);
  await testSql.end();
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
