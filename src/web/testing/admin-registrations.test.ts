/**
 * I5 — Transactions & refund execution (AC-I5 ①–⑥).
 *
 * Guard/CSRF on the new admin routes, the transaction log (all states, filters,
 * pagination, HTMX fragment), the dashboard KPIs reconciling with the log, the
 * payment-detail page, and server-side refund validation. The money-moving
 * refund + Stripe-failure semantics are asserted against RefundService with a
 * mock (the HTTP path can't inject Stripe), plus the open-request auto-resolve.
 *
 * Run: npx tsx src/web/testing/admin-registrations.test.ts
 */
import 'dotenv/config';
import { testSql, truncateTables, assert, assertEqual } from '../../registration/testing/test-helpers.js';
import { authService } from '../../services/auth-service.js';
import { createSession } from '../middleware/session.js';
import { adminRegistrationsService } from '../../services/admin-registrations-service.js';
import { RefundService } from '../../registration/services/RefundService.js';
import { MockStripeClient } from '../../registration/testing/MockStripeClient.js';

const CSRF = 'fedcba9876543210'.repeat(4);
const ADMIN_EMAIL = 'admin-i5@example.com';
const USER_EMAIL = 'user-i5@example.com';

class NoopNotif { async sendRefundConfirmation() {} async sendRegistrationConfirmation() {} async sendWaitlistAcknowledgement() {} }

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

async function makeUser(email: string, isAdmin: boolean): Promise<{ id: string; cookie: string }> {
  const hash = await authService.hashPassword('pw');
  const rows = await testSql`
    INSERT INTO users (email, password_hash, display_name, is_verified, is_admin, account_status)
    VALUES (${email}, ${hash}, 'I5', TRUE, ${isAdmin}, 'active') RETURNING id`;
  const id = rows[0].id as string;
  const { signedSid } = await createSession({ userId: id, csrfToken: CSRF }, id);
  return { id, cookie: `sid=${signedSid}` };
}

async function createEvent(name = 'I5 Event'): Promise<string> {
  const rows = await testSql`
    INSERT INTO events (name, event_date, total_capacity, confirmed_count, available_slots, registration_fee_cents, status)
    VALUES (${name}, now()+interval '20 days', 50, 0, 50, 2500, 'OPEN') RETURNING event_id`;
  return rows[0].event_id as string;
}

async function createReg(eventId: string, opts: { status: string; gross?: number; net?: number | null; refunded?: number; email?: string; pi?: string }): Promise<string> {
  const rows = await testSql`
    INSERT INTO registrations (event_id, email, first_name, last_name, gross_amount_cents, net_amount_cents, refunded_amount_cents, payment_intent_id, status, confirmed_at)
    VALUES (${eventId}, ${opts.email ?? 'cust@example.com'}, 'Cust', 'Omer',
            ${opts.gross ?? 2500}, ${opts.net ?? 2400}, ${opts.refunded ?? 0}, ${opts.pi ?? ('pi_' + Math.random().toString(36).slice(2))},
            ${opts.status}, ${opts.status === 'CONFIRMED' ? new Date() : null})
    RETURNING registration_id`;
  // Keep the event counters consistent for confirmed rows so a later refund's
  // confirmed_count decrement stays within the capacity_invariant CHECK.
  if (opts.status === 'CONFIRMED') {
    await testSql`UPDATE events SET confirmed_count = confirmed_count + 1, available_slots = available_slots - 1 WHERE event_id = ${eventId}::UUID`;
  }
  return rows[0].registration_id as string;
}

async function get(path: string, cookie?: string, headers: Record<string, string> = {}) {
  const { app } = await import('../app.js');
  return app.request(`http://localhost${path}`, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
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

  console.log('\n=== I5: Transactions & Refunds ===\n');

  await cleanupUsers();
  const admin = await makeUser(ADMIN_EMAIL, true);
  const nonAdmin = await makeUser(USER_EMAIL, false);

  // ── Guard + CSRF (AC-I5 ⑤) ──
  await test('admin transaction routes 404 for anon/non-admin, 200 for admin', async () => {
    await truncateTables();
    const id = await createReg(await createEvent(), { status: 'CONFIRMED' });
    assertEqual((await get('/admin/registrations')).status, 404, 'anon list 404');
    assertEqual((await get('/admin/registrations', nonAdmin.cookie)).status, 404, 'non-admin list 404');
    assertEqual((await get('/admin/registrations', admin.cookie)).status, 200, 'admin list 200');
    assertEqual((await get(`/admin/registrations/${id}`, admin.cookie)).status, 200, 'admin detail 200');
    assertEqual((await get(`/admin/registrations/${id}`, nonAdmin.cookie)).status, 404, 'non-admin detail 404');
  });

  await test('refund POST is 403 without CSRF', async () => {
    await truncateTables();
    const id = await createReg(await createEvent(), { status: 'CONFIRMED' });
    assertEqual((await postForm(`/admin/registrations/${id}/refund`, { refundType: 'full' }, admin.cookie, false)).status, 403, 'no csrf → 403');
  });

  // ── Transaction log (AC-I5 ①) ──
  await test('log shows every state including PAYMENT_FAILED and EXPIRED', async () => {
    await truncateTables();
    const ev = await createEvent();
    for (const s of ['CONFIRMED', 'PAYMENT_FAILED', 'EXPIRED', 'PENDING_PAYMENT', 'CANCELLED']) {
      await createReg(ev, { status: s, email: `${s.toLowerCase()}@example.com` });
    }
    const body = await (await get('/admin/registrations', admin.cookie)).text();
    for (const s of ['PAYMENT_FAILED', 'EXPIRED', 'PENDING_PAYMENT']) assert(body.includes(s), `${s} visible in log`);
  });

  await test('filters compose (status + email) and HTMX returns a bare fragment', async () => {
    await truncateTables();
    const ev = await createEvent();
    await createReg(ev, { status: 'CONFIRMED', email: 'alice@example.com' });
    await createReg(ev, { status: 'PAYMENT_FAILED', email: 'bob@example.com' });
    const filtered = await (await get('/admin/registrations?status=CONFIRMED&email=alice', admin.cookie)).text();
    assert(filtered.includes('alice@example.com') && !filtered.includes('bob@example.com'), 'status+email filter composes');
    const frag = await get('/admin/registrations?status=CONFIRMED', admin.cookie, { 'HX-Request': 'true' });
    const fragBody = await frag.text();
    assert(!fragBody.includes('<html'), 'HTMX fragment has no layout');
  });

  await test('log paginates 25/page', async () => {
    await truncateTables();
    const ev = await createEvent();
    for (let i = 0; i < 26; i++) await createReg(ev, { status: 'CONFIRMED', email: `p${i}@example.com` });
    const p1 = await (await get('/admin/registrations', admin.cookie)).text();
    assert(p1.includes('Page 1 of 2'), 'two pages for 26 rows');
  });

  // ── Dashboard KPIs (AC-I5 ⑥) ──
  await test('dashboard KPIs reconcile with the data', async () => {
    await truncateTables();
    const ev = await createEvent();
    await createReg(ev, { status: 'CONFIRMED', gross: 2500, email: 'd1@example.com' });
    await createReg(ev, { status: 'CONFIRMED', gross: 4000, email: 'd2@example.com' });
    await createReg(ev, { status: 'PAYMENT_FAILED', email: 'd3@example.com' });
    const body = await (await get('/admin', admin.cookie)).text();
    assert(body.includes('Dashboard'), 'dashboard renders');
    assert(body.includes('$65.00'), 'revenue 30d = $65.00 (2500+4000)');
  });

  // ── Refund validation (AC-I5 ③) ──
  async function refundedOf(id: string): Promise<number> {
    return (await testSql`SELECT refunded_amount_cents FROM registrations WHERE registration_id=${id}::UUID`)[0].refunded_amount_cents as number;
  }
  async function refundLogCount(id: string): Promise<number> {
    return (await testSql`SELECT count(*)::int AS n FROM refund_log WHERE registration_id=${id}::UUID`)[0].n as number;
  }

  await test('over-amount partial refund is rejected server-side (no money moves)', async () => {
    await truncateTables();
    const id = await createReg(await createEvent(), { status: 'CONFIRMED', net: 2400, refunded: 0 });
    const r = await postForm(`/admin/registrations/${id}/refund`, { refundType: 'partial', amount: '100.00' }, admin.cookie); // $10000 ≫ $24
    assertEqual(r.status, 302, 'redirects');
    assertEqual(await refundedOf(id), 0, 'nothing refunded');
    assertEqual(await refundLogCount(id), 0, 'no refund_log row');
  });

  await test('zero / non-CONFIRMED refunds are rejected', async () => {
    await truncateTables();
    const ev = await createEvent();
    const confirmed = await createReg(ev, { status: 'CONFIRMED' });
    await postForm(`/admin/registrations/${confirmed}/refund`, { refundType: 'partial', amount: '0' }, admin.cookie);
    assertEqual(await refundLogCount(confirmed), 0, 'zero amount → no refund');
    const failed = await createReg(ev, { status: 'PAYMENT_FAILED' });
    await postForm(`/admin/registrations/${failed}/refund`, { refundType: 'full' }, admin.cookie);
    assertEqual(await refundLogCount(failed), 0, 'non-CONFIRMED → no refund');
  });

  // ── Refund execution + failure (AC-I5 ②, ④) via the service ──
  await test('full refund moves money: refund_log row, status flip, amount tracked', async () => {
    await truncateTables();
    const id = await createReg(await createEvent(), { status: 'CONFIRMED', net: 2400, pi: 'pi_ok_full' });
    const svc = new RefundService(new MockStripeClient() as never, new NoopNotif() as never);
    const res = await svc.refundRegistration({ registrationId: id, refundType: 'FULL', reason: 'admin_initiated' });
    assertEqual(res.outcome, 'REFUND_ISSUED', 'refund issued');
    assertEqual(await refundLogCount(id), 1, 'refund_log written');
    const row = (await testSql`SELECT status, refunded_amount_cents FROM registrations WHERE registration_id=${id}::UUID`)[0];
    assertEqual(row.status, 'CANCELLED', 'status flipped');
    assertEqual(row.refunded_amount_cents, 2400, 'refunded the net amount');
  });

  await test('Stripe failure → no refund_log row, status unchanged', async () => {
    await truncateTables();
    const id = await createReg(await createEvent(), { status: 'CONFIRMED', pi: 'pi_fail' });
    const svc = new RefundService(new MockStripeClient({ refundShouldError: true }) as never, new NoopNotif() as never);
    const res = await svc.refundRegistration({ registrationId: id, refundType: 'FULL', reason: 'admin_initiated' });
    assertEqual(res.outcome, 'STRIPE_ERROR', 'stripe error');
    assertEqual(await refundLogCount(id), 0, 'no refund_log on failure');
    assertEqual((await testSql`SELECT status FROM registrations WHERE registration_id=${id}::UUID`)[0].status, 'CONFIRMED', 'status unchanged');
  });

  // ── Auto-resolve open refund request (site map §4.3) ──
  await test('a direct refund auto-resolves an open refund request', async () => {
    await truncateTables();
    const id = await createReg(await createEvent(), { status: 'CONFIRMED' });
    await testSql`INSERT INTO refund_requests (registration_id, status, reason) VALUES (${id}, 'REQUESTED', 'change of plans')`;
    await adminRegistrationsService.resolveOpenRefundRequests(id, admin.id);
    const req = (await testSql`SELECT status, resolved_by, resolution_note FROM refund_requests WHERE registration_id=${id}::UUID`)[0];
    assertEqual(req.status, 'APPROVED', 'request approved');
    assertEqual(req.resolved_by, admin.id, 'resolver stamped');
    await testSql`DELETE FROM refund_requests WHERE registration_id=${id}::UUID`;
  });

  // ── A7: CSV exports ──
  await test('A7: transactions.csv honors filters, attachment headers, guarded', async () => {
    await truncateTables();
    const ev = await createEvent();
    await createReg(ev, { status: 'CONFIRMED', email: 'csv-a@example.com', gross: 2500 });
    await createReg(ev, { status: 'PAYMENT_FAILED', email: 'csv-b@example.com' });
    assertEqual((await get('/admin/registrations.csv', nonAdmin.cookie)).status, 404, 'non-admin 404');
    const resp = await get('/admin/registrations.csv?status=CONFIRMED', admin.cookie);
    assertEqual(resp.status, 200, 'admin 200');
    assert((resp.headers.get('content-disposition') || '').includes('attachment'), 'attachment header');
    assert((resp.headers.get('content-type') || '').includes('text/csv'), 'csv content-type');
    const body = await resp.text();
    assert(body.includes('Created,Event') && body.includes('csv-a@example.com') && !body.includes('csv-b@example.com'), 'filtered rows + header');
  });

  await test('A7: roster.csv and waitlist.csv export the event lists', async () => {
    await truncateTables();
    const ev = await createEvent();
    await createReg(ev, { status: 'CONFIRMED', email: 'roster1@example.com' });
    await testSql`INSERT INTO waitlist_entries (event_id, email, first_name, last_name) VALUES (${ev}, 'wl1@example.com', 'Wait', 'One')`;
    const roster = await get(`/admin/events/${ev}/roster.csv`, admin.cookie);
    assertEqual(roster.status, 200, 'roster 200');
    assert((await roster.text()).includes('roster1@example.com'), 'roster row present');
    const wl = await get(`/admin/events/${ev}/waitlist.csv`, admin.cookie);
    assert((await wl.text()).includes('wl1@example.com'), 'waitlist row present');
  });

  await truncateTables();
  await cleanupUsers();
  console.log(`\n=== Admin Registrations: ${passed} passed, ${failed} failed ===`);
  await testSql.end();
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
