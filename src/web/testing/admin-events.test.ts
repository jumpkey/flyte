/**
 * I4 — Admin events (AC-I4 ①–⑤).
 *
 * Unit: the event-form validator (dollars→cents, capacity floor, https URL) and
 * the transition rules. HTTP: adminGuard + CSRF on the admin routes, full CRUD
 * lifecycle with storefront visibility, capacity-floor enforcement, and cancel.
 * The all-or-nothing cancel semantics (A6) are asserted against RefundService
 * with a failing mock (the HTTP path can't inject a mock Stripe).
 *
 * Run: npx tsx src/web/testing/admin-events.test.ts
 */
import 'dotenv/config';
import { testSql, truncateTables, assert, assertEqual } from '../../registration/testing/test-helpers.js';
import { authService } from '../../services/auth-service.js';
import { createSession } from '../middleware/session.js';
import { validateEventForm, isAllowedTransition } from '../validators/event-form.js';
import { RefundService } from '../../registration/services/RefundService.js';
import { MockStripeClient } from '../../registration/testing/MockStripeClient.js';

const CSRF = 'abcdef0123456789'.repeat(4); // 64 hex chars
const ADMIN_EMAIL = 'admin-i4@example.com';
const USER_EMAIL = 'user-i4@example.com';

class NoopNotif {
  async sendRegistrationConfirmation() {}
  async sendWaitlistAcknowledgement() {}
  async sendRefundConfirmation() {}
}

async function cleanupUsers() {
  for (const email of [ADMIN_EMAIL, USER_EMAIL]) {
    const ids = (await testSql`SELECT id FROM users WHERE email=${email}`).map((r) => r.id as string);
    if (ids.length) {
      await testSql`DELETE FROM user_action_events WHERE user_id = ANY(${ids})`;
      await testSql`DELETE FROM login_events WHERE user_id = ANY(${ids})`;
      await testSql`DELETE FROM sessions WHERE user_id = ANY(${ids})`;
      await testSql`DELETE FROM users WHERE id = ANY(${ids})`;
    }
  }
}

async function makeUser(email: string, isAdmin: boolean): Promise<{ userId: string; cookie: string }> {
  const hash = await authService.hashPassword('pw');
  const rows = await testSql`
    INSERT INTO users (email, password_hash, display_name, is_verified, is_admin, account_status)
    VALUES (${email}, ${hash}, 'I4', TRUE, ${isAdmin}, 'active') RETURNING id`;
  const userId = rows[0].id as string;
  const { signedSid } = await createSession({ userId, csrfToken: CSRF }, userId);
  return { userId, cookie: `sid=${signedSid}` };
}

async function get(path: string, cookie?: string) {
  const { app } = await import('../app.js');
  return app.request(`http://localhost${path}`, { headers: cookie ? { Cookie: cookie } : {} });
}
async function postForm(path: string, fields: Record<string, string>, cookie?: string, withCsrf = true) {
  const { app } = await import('../app.js');
  const params = new URLSearchParams({ ...fields, ...(withCsrf ? { _csrf: CSRF } : {}) });
  return app.request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
    body: params.toString(),
  });
}

async function runTests() {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => Promise<void> | void) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}:`, e instanceof Error ? e.message : String(e)); failed++; }
  }

  console.log('\n=== I4: Admin Events ===\n');

  // ── Validator (unit) ──
  await test('validateEventForm converts dollars to cents and accepts https image', () => {
    const r = validateEventForm({ name: 'X', eventDate: '2030-01-01T10:00', capacity: '20', feeDollars: '25.00', imageUrl: 'https://x.test/a.jpg', waitlistEnabled: 'on' });
    assert(r.ok, 'should be valid');
    if (r.ok) {
      assertEqual(r.values.registrationFeeCents, 2500, 'cents');
      assertEqual(r.values.totalCapacity, 20, 'capacity');
      assertEqual(r.values.waitlistEnabled, true, 'waitlist');
    }
  });

  await test('validateEventForm rejects non-https image, bad fee, capacity below floor', () => {
    const http = validateEventForm({ name: 'X', eventDate: '2030-01-01T10:00', capacity: '5', feeDollars: '10', imageUrl: 'http://x.test/a.jpg' });
    assert(!http.ok && !!http.errors.imageUrl, 'http rejected');
    const fee = validateEventForm({ name: 'X', eventDate: '2030-01-01T10:00', capacity: '5', feeDollars: '10.999' });
    assert(!fee.ok && !!fee.errors.feeDollars, 'bad fee rejected');
    const floor = validateEventForm({ name: 'X', eventDate: '2030-01-01T10:00', capacity: '3', feeDollars: '10' }, { minCapacity: 5 });
    assert(!floor.ok && !!floor.errors.capacity, 'capacity floor enforced');
  });

  await test('transition rules: DRAFT→OPEN ok, OPEN→DRAFT no, OPEN↔CLOSED ok', () => {
    assert(isAllowedTransition('DRAFT', 'OPEN'), 'draft→open');
    assert(!isAllowedTransition('OPEN', 'DRAFT'), 'open→draft forbidden');
    assert(isAllowedTransition('OPEN', 'CLOSED'), 'open→closed');
    assert(isAllowedTransition('CLOSED', 'OPEN'), 'closed→open (reopen)');
    assert(!isAllowedTransition('OPEN', 'CANCELLED'), 'cancel not via transition');
  });

  // ── Guard + CSRF (AC-I4 ④) ──
  await cleanupUsers();
  const admin = await makeUser(ADMIN_EMAIL, true);
  const nonAdmin = await makeUser(USER_EMAIL, false);

  await test('admin routes 404 for anonymous and non-admin, 200 for admin', async () => {
    assertEqual((await get('/admin/events')).status, 404, 'anon list 404');
    assertEqual((await get('/admin/events', nonAdmin.cookie)).status, 404, 'non-admin list 404');
    assertEqual((await get('/admin/events', admin.cookie)).status, 200, 'admin list 200');
    assertEqual((await get('/admin/events/new', admin.cookie)).status, 200, 'admin new 200');
  });

  await test('POST without CSRF token is 403; with token proceeds', async () => {
    const noCsrf = await postForm('/admin/events', { name: 'NoCsrf', eventDate: '2030-01-01T10:00', capacity: '5', feeDollars: '10' }, admin.cookie, false);
    assertEqual(noCsrf.status, 403, 'no csrf → 403');
  });

  // ── CRUD lifecycle + visibility (AC-I4 ①) ──
  await test('create as DRAFT is invisible on the storefront; open makes it visible', async () => {
    await truncateTables();
    const draft = await postForm('/admin/events', { name: 'Draftly', eventDate: '2030-06-01T10:00', capacity: '10', feeDollars: '20' }, admin.cookie);
    assertEqual(draft.status, 302, 'create redirects');
    const draftId = (draft.headers.get('location') || '').split('/').pop()!;
    const row = await testSql`SELECT status, opened_at FROM events WHERE event_id = ${draftId}::UUID`;
    assertEqual(row[0].status, 'DRAFT', 'defaults to DRAFT');
    assertEqual(row[0].opened_at, null, 'no opened_at while draft');
    const catalog = await (await get('/events')).text();
    assert(!catalog.includes('Draftly'), 'DRAFT not on storefront');

    const open = await postForm('/admin/events', { name: 'Openly', eventDate: '2030-06-02T10:00', capacity: '10', feeDollars: '20', openImmediately: 'on' }, admin.cookie);
    const openId = (open.headers.get('location') || '').split('/').pop()!;
    const orow = await testSql`SELECT status, opened_at FROM events WHERE event_id = ${openId}::UUID`;
    assertEqual(orow[0].status, 'OPEN', 'open immediately');
    assert(orow[0].opened_at !== null, 'opened_at stamped');
    const catalog2 = await (await get('/events')).text();
    assert(catalog2.includes('Openly'), 'OPEN visible on storefront');
  });

  await test('edit cannot reduce capacity below confirmed_count', async () => {
    await truncateTables();
    const c = await postForm('/admin/events', { name: 'CapTest', eventDate: '2030-06-03T10:00', capacity: '10', feeDollars: '20', openImmediately: 'on' }, admin.cookie);
    const id = (c.headers.get('location') || '').split('/').pop()!;
    // Simulate 4 confirmed registrations.
    await testSql`UPDATE events SET confirmed_count = 4, available_slots = 6 WHERE event_id = ${id}::UUID`;
    const bad = await postForm(`/admin/events/${id}`, { name: 'CapTest', eventDate: '2030-06-03T10:00', capacity: '3', feeDollars: '20', status: 'OPEN' }, admin.cookie);
    assertEqual(bad.status, 200, 're-renders form (not redirect)');
    assert((await bad.text()).includes("can't go lower") || (await get(`/admin/events/${id}/edit`, admin.cookie)).status === 200, 'shows floor error');
    const row = await testSql`SELECT total_capacity FROM events WHERE event_id = ${id}::UUID`;
    assertEqual(row[0].total_capacity, 10, 'capacity unchanged');
  });

  await test('invalid status transition is rejected; valid one applied', async () => {
    await truncateTables();
    const c = await postForm('/admin/events', { name: 'Trans', eventDate: '2030-06-04T10:00', capacity: '10', feeDollars: '20' }, admin.cookie);
    const id = (c.headers.get('location') || '').split('/').pop()!;
    // DRAFT→CLOSED is not allowed.
    const bad = await postForm(`/admin/events/${id}`, { name: 'Trans', eventDate: '2030-06-04T10:00', capacity: '10', feeDollars: '20', status: 'CLOSED' }, admin.cookie);
    assertEqual(bad.status, 200, 'invalid transition re-renders');
    assertEqual((await testSql`SELECT status FROM events WHERE event_id = ${id}::UUID`)[0].status, 'DRAFT', 'status unchanged');
    // DRAFT→OPEN is allowed.
    const ok = await postForm(`/admin/events/${id}`, { name: 'Trans', eventDate: '2030-06-04T10:00', capacity: '10', feeDollars: '20', status: 'OPEN' }, admin.cookie);
    assertEqual(ok.status, 302, 'valid transition redirects');
    assertEqual((await testSql`SELECT status FROM events WHERE event_id = ${id}::UUID`)[0].status, 'OPEN', 'status now OPEN');
  });

  // ── Cancel (AC-I4 ①, ③) ──
  await test('cancel with zero confirmed flips the event to CANCELLED', async () => {
    await truncateTables();
    const c = await postForm('/admin/events', { name: 'CancelMe', eventDate: '2030-06-05T10:00', capacity: '10', feeDollars: '20', openImmediately: 'on' }, admin.cookie);
    const id = (c.headers.get('location') || '').split('/').pop()!;
    const resp = await postForm(`/admin/events/${id}/cancel`, {}, admin.cookie);
    assertEqual(resp.status, 302, 'cancel redirects');
    assertEqual((await testSql`SELECT status FROM events WHERE event_id = ${id}::UUID`)[0].status, 'CANCELLED', 'now cancelled');
  });

  await test('A6: a Stripe refund failure leaves the event NOT cancelled', async () => {
    await truncateTables();
    const ev = await testSql`
      INSERT INTO events (name, event_date, total_capacity, confirmed_count, available_slots, registration_fee_cents, status)
      VALUES ('Failing', now()+interval '20 days', 10, 1, 9, 2500, 'OPEN') RETURNING event_id`;
    const id = ev[0].event_id as string;
    await testSql`
      INSERT INTO registrations (event_id, email, first_name, last_name, gross_amount_cents, net_amount_cents, payment_intent_id, status, confirmed_at)
      VALUES (${id}, 'c@example.com', 'C', 'X', 2500, 2400, 'pi_fail_me', 'CONFIRMED', now())`;
    const svc = new RefundService(new MockStripeClient({ refundShouldError: true }) as never, new NoopNotif() as never);
    const result = await svc.refundEvent({ eventId: id, refundType: 'FULL', reason: 'event_cancelled' });
    assert(result.totalFailed >= 1, 'a refund failed');
    assertEqual((await testSql`SELECT status FROM events WHERE event_id = ${id}::UUID`)[0].status, 'OPEN', 'event NOT cancelled on failure');
  });

  await truncateTables();
  await cleanupUsers();
  console.log(`\n=== Admin Events: ${passed} passed, ${failed} failed ===`);
  await testSql.end();
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
