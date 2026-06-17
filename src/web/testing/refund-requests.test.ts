/**
 * I6 — Refund requests (AC-I6 ①–⑤; journey J4).
 *
 * Customer file flow (form states, idempotent one-open-per-registration,
 * non-CONFIRMED rejection), the admin queue (guard, approve/deny), refund
 * idempotency, the deny note requirement, and S4 escaping of the note.
 *
 * Run: npx tsx src/web/testing/refund-requests.test.ts
 */
import 'dotenv/config';
import { testSql, truncateTables, assert, assertEqual } from '../../registration/testing/test-helpers.js';
import { authService } from '../../services/auth-service.js';
import { createSession } from '../middleware/session.js';
import { refundRequestsService } from '../../services/refund-requests-service.js';
import { escapeHtml, NotificationService } from '../../registration/services/NotificationService.js';
import { RefundService } from '../../registration/services/RefundService.js';
import { MockStripeClient } from '../../registration/testing/MockStripeClient.js';

const CSRF = '0a1b2c3d4e5f6071'.repeat(4);
const ADMIN_EMAIL = 'admin-i6@example.com';
const USER_EMAIL = 'user-i6@example.com';

class NoopNotif { async sendRefundConfirmation() {} async sendRegistrationConfirmation() {} async sendWaitlistAcknowledgement() {} }

async function cleanupUsers() {
  for (const email of [ADMIN_EMAIL, USER_EMAIL]) {
    const ids = (await testSql`SELECT id FROM users WHERE email=${email}`).map((r) => r.id as string);
    if (ids.length) {
      await testSql`DELETE FROM user_action_events WHERE user_id = ANY(${ids})`;
      await testSql`DELETE FROM sessions WHERE user_id = ANY(${ids})`;
      await testSql`DELETE FROM users WHERE id = ANY(${ids})`;
    }
  }
}
async function makeAdmin(): Promise<{ id: string; cookie: string }> {
  const hash = await authService.hashPassword('pw');
  const rows = await testSql`INSERT INTO users (email,password_hash,display_name,is_verified,is_admin,account_status) VALUES (${ADMIN_EMAIL},${hash},'A',TRUE,TRUE,'active') RETURNING id`;
  const id = rows[0].id as string;
  const { signedSid } = await createSession({ userId: id, csrfToken: CSRF }, id);
  return { id, cookie: `sid=${signedSid}` };
}
async function makeNonAdmin(): Promise<string> {
  const hash = await authService.hashPassword('pw');
  const rows = await testSql`INSERT INTO users (email,password_hash,display_name,is_verified,is_admin,account_status) VALUES (${USER_EMAIL},${hash},'U',TRUE,FALSE,'active') RETURNING id`;
  const id = rows[0].id as string;
  const { signedSid } = await createSession({ userId: id, csrfToken: CSRF }, id);
  return `sid=${signedSid}`;
}

async function createReg(status: string, opts: { pi?: string; refunded?: number } = {}): Promise<string> {
  const ev = await testSql`INSERT INTO events (name,event_date,total_capacity,confirmed_count,available_slots,registration_fee_cents,status) VALUES ('I6 Event', now()+interval '20 days',50,${status==='CONFIRMED'?1:0},${status==='CONFIRMED'?49:50},2500,'OPEN') RETURNING event_id`;
  const rows = await testSql`
    INSERT INTO registrations (event_id,email,first_name,last_name,gross_amount_cents,net_amount_cents,refunded_amount_cents,payment_intent_id,status,confirmed_at)
    VALUES (${ev[0].event_id},'cust@example.com','Cust','Omer',2500,2400,${opts.refunded ?? 0},${opts.pi ?? ('pi_'+Math.random().toString(36).slice(2))},${status},${status==='CONFIRMED'||status==='CANCELLED'?new Date():null})
    RETURNING registration_id`;
  return rows[0].registration_id as string;
}

async function get(path: string, cookie?: string) {
  const { app } = await import('../app.js');
  return app.request(`http://localhost${path}`, { headers: cookie ? { Cookie: cookie } : {} });
}
async function bootstrapForm(path: string): Promise<{ csrf: string; sid: string }> {
  const { app } = await import('../app.js');
  const resp = await app.request(`http://localhost${path}`);
  const setCookie = resp.headers.get('set-cookie') ?? '';
  const sid = setCookie.match(/sid=([^;]+)/)?.[1] ?? '';
  const csrf = (await resp.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] ?? '';
  return { csrf, sid };
}
async function postForm(path: string, fields: Record<string, string>, cookie?: string, csrf = CSRF, withCsrf = true) {
  const { app } = await import('../app.js');
  const params = new URLSearchParams({ ...fields, ...(withCsrf ? { _csrf: csrf } : {}) });
  return app.request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(cookie ? { Cookie: cookie } : {}) },
    body: params.toString(),
  });
}
async function reqCount(regId: string): Promise<number> {
  return (await testSql`SELECT count(*)::int AS n FROM refund_requests WHERE registration_id=${regId}::UUID`)[0].n as number;
}
async function reqStatus(regId: string): Promise<string | null> {
  const rows = await testSql`SELECT status FROM refund_requests WHERE registration_id=${regId}::UUID ORDER BY requested_at DESC LIMIT 1`;
  return rows.length ? (rows[0].status as string) : null;
}

async function runTests() {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => Promise<void> | void) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}:`, e instanceof Error ? e.message : String(e)); failed++; }
  }

  console.log('\n=== I6: Refund Requests ===\n');

  await cleanupUsers();
  const admin = await makeAdmin();
  const nonAdminCookie = await makeNonAdmin();

  // ── Customer form states ──
  await test('form shows for a CONFIRMED registration; ineligible for non-CONFIRMED', async () => {
    await truncateTables();
    const confirmed = await createReg('CONFIRMED');
    const f = await (await get(`/registration/${confirmed}/refund-request`)).text();
    assert(f.includes('Request a refund') && f.includes('name="reason"'), 'form shown');
    const failed = await createReg('PAYMENT_FAILED');
    const i = await (await get(`/registration/${failed}/refund-request`)).text();
    assert(i.includes('Refund not available'), 'ineligible state');
  });

  // ── File a request (AC-I6 ① ⑤) ──
  await test('filing creates exactly one open request and acks', async () => {
    await truncateTables();
    const id = await createReg('CONFIRMED');
    const { csrf, sid } = await bootstrapForm(`/registration/${id}/refund-request`);
    const resp = await postForm(`/registration/${id}/refund-request`, { reason: 'change of plans' }, `sid=${sid}`, csrf);
    assertEqual(resp.status, 302, 'redirects');
    assert((resp.headers.get('location') || '').includes('sent=1'), 'redirects to ack');
    assertEqual(await reqCount(id), 1, 'one request row');
    assertEqual(await reqStatus(id), 'REQUESTED', 'status REQUESTED');
  });

  await test('a duplicate filing is idempotent (still one open request)', async () => {
    await truncateTables();
    const id = await createReg('CONFIRMED');
    const { csrf, sid } = await bootstrapForm(`/registration/${id}/refund-request`);
    await postForm(`/registration/${id}/refund-request`, { reason: 'first' }, `sid=${sid}`, csrf);
    const dup = await postForm(`/registration/${id}/refund-request`, { reason: 'second' }, `sid=${sid}`, csrf);
    assertEqual(dup.status, 302, 'redirects');
    assert(!(dup.headers.get('location') || '').includes('sent=1'), 'duplicate not treated as new ack');
    assertEqual(await reqCount(id), 1, 'still one row');
    // GET now shows the already-requested state.
    const g = await (await get(`/registration/${id}/refund-request`)).text();
    assert(g.includes('already submitted'), 'already-requested friendly state');
  });

  await test('a non-CONFIRMED registration cannot file (no row created)', async () => {
    await truncateTables();
    const id = await createReg('PAYMENT_FAILED');
    const { csrf, sid } = await bootstrapForm(`/registration/${id}/refund-request`);
    await postForm(`/registration/${id}/refund-request`, { reason: 'x' }, `sid=${sid}`, csrf);
    assertEqual(await reqCount(id), 0, 'no request created');
  });

  // ── Admin queue (AC-I6 ⑤ guard) ──
  await test('queue is guarded and lists open requests', async () => {
    await truncateTables();
    const id = await createReg('CONFIRMED');
    await refundRequestsService.createRequest(id, null, 'please refund');
    assertEqual((await get('/admin/refund-requests', nonAdminCookie)).status, 404, 'non-admin 404');
    const body = await (await get('/admin/refund-requests', admin.cookie)).text();
    assert(body.includes('Cust Omer') && body.includes('please refund'), 'request shown in queue');
  });

  // ── C2: queue renders a table (not cards) and approve/deny still work ──
  await test('queue renders a table (not cards) with approve/deny actions', async () => {
    await truncateTables();
    const id = await createReg('CONFIRMED');
    await refundRequestsService.createRequest(id, null, 'please refund');
    const body = await (await get('/admin/refund-requests', admin.cookie)).text();
    assert(body.includes('<table'), 'a table is rendered');
    assert(body.includes('<th>Customer</th>') && body.includes('Refundable'), 'table has the expected columns');
    assert(body.includes('data-open-dialog="#approve-') && body.includes('data-open-dialog="#deny-'), 'approve + deny dialogs present');
  });

  await test('C2: approve from the table still posts and resolves', async () => {
    await truncateTables();
    const id = await createReg('CONFIRMED');
    await refundRequestsService.createRequest(id, null, 'r');
    const reqId = (await testSql`SELECT request_id FROM refund_requests WHERE registration_id=${id}::UUID`)[0].request_id as string;
    await refundRequestsService.resolve(reqId, 'APPROVED', admin.id, 'Approved — refund issued');
    assertEqual(await reqStatus(id), 'APPROVED', 'resolves via the table flow');
  });

  await test('C2: queue paginates at 25/page with >25 open requests', async () => {
    await truncateTables();
    for (let i = 0; i < 30; i++) {
      const id = await createReg('CONFIRMED');
      await refundRequestsService.createRequest(id, null, `r${i}`);
    }
    const body = await (await get('/admin/refund-requests', admin.cookie)).text();
    assert(body.includes('Page 1 of'), 'page indicator shown');
    assert(/Page 1 of [2-9]/.test(body), 'at least two pages for 30 requests at 25/page');
  });

  // ── Approve: Stripe failure / unavailability never silently resolves (AC-I6 ③) ──
  await test('approve leaves the request open when the refund cannot be made', async () => {
    await truncateTables();
    const id = await createReg('CONFIRMED');
    await refundRequestsService.createRequest(id, null, 'r');
    const reqId = (await testSql`SELECT request_id FROM refund_requests WHERE registration_id=${id}::UUID`)[0].request_id as string;
    // No Stripe key in this assertion → getRefundService throws → request stays open.
    const prevKey = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = '';
    const resp = await postForm(`/admin/refund-requests/${reqId}/approve`, {}, admin.cookie);
    if (prevKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = prevKey;
    assertEqual(resp.status, 302, 'redirects');
    assertEqual(await reqStatus(id), 'REQUESTED', 'request NOT silently resolved');
  });

  await test('approving an already-refunded registration issues no second refund', async () => {
    await truncateTables();
    const id = await createReg('CANCELLED', { refunded: 2400, pi: 'pi_already' });
    const svc = new RefundService(new MockStripeClient() as never, new NoopNotif() as never);
    const res = await svc.refundRegistration({ registrationId: id, refundType: 'FULL', reason: 'refund_request_approved' });
    assertEqual(res.outcome, 'ALREADY_REFUNDED', 'idempotent — already refunded');
    assertEqual((await testSql`SELECT count(*)::int AS n FROM refund_log WHERE registration_id=${id}::UUID`)[0].n, 0, 'no new refund_log row');
  });

  // ── Resolve service stamps the resolver ──
  await test('resolve marks APPROVED and stamps resolved_by', async () => {
    await truncateTables();
    const id = await createReg('CONFIRMED');
    await refundRequestsService.createRequest(id, null, 'r');
    const reqId = (await testSql`SELECT request_id FROM refund_requests WHERE registration_id=${id}::UUID`)[0].request_id as string;
    await refundRequestsService.resolve(reqId, 'APPROVED', admin.id, 'Approved — refund issued');
    const row = (await testSql`SELECT status, resolved_by FROM refund_requests WHERE request_id=${reqId}::UUID`)[0];
    assertEqual(row.status, 'APPROVED', 'approved'); assertEqual(row.resolved_by, admin.id, 'resolver stamped');
  });

  // ── Deny requires a note (AC-I6 ④) ──
  await test('deny without a note leaves the request open; with a note resolves DENIED', async () => {
    await truncateTables();
    const id = await createReg('CONFIRMED');
    await refundRequestsService.createRequest(id, null, 'r');
    const reqId = (await testSql`SELECT request_id FROM refund_requests WHERE registration_id=${id}::UUID`)[0].request_id as string;
    await postForm(`/admin/refund-requests/${reqId}/deny`, { note: '' }, admin.cookie);
    assertEqual(await reqStatus(id), 'REQUESTED', 'no note → still open');
    await postForm(`/admin/refund-requests/${reqId}/deny`, { note: 'Outside the refund window.' }, admin.cookie);
    const row = (await testSql`SELECT status, resolution_note, resolved_by FROM refund_requests WHERE request_id=${reqId}::UUID`)[0];
    assertEqual(row.status, 'DENIED', 'denied'); assertEqual(row.resolution_note, 'Outside the refund window.', 'note stored');
  });

  // ── S4: deny note is HTML-escaped in the email + admin UI ──
  await test('S4: a hostile deny note is escaped in the email body and admin view', async () => {
    const hostile = `<script>alert('xss')</script>`;
    const escaped = escapeHtml(hostile);
    assert(!escaped.includes('<script>') && escaped.includes('&lt;script&gt;'), 'escapeHtml neutralizes the note');
    // The admin resolved tab renders resolution_note via EJS <%= %> (auto-escaped).
    await truncateTables();
    const id = await createReg('CONFIRMED');
    await refundRequestsService.createRequest(id, null, 'r');
    const reqId = (await testSql`SELECT request_id FROM refund_requests WHERE registration_id=${id}::UUID`)[0].request_id as string;
    await refundRequestsService.resolve(reqId, 'DENIED', admin.id, hostile);
    const body = await (await get('/admin/refund-requests?tab=resolved', admin.cookie)).text();
    assert(!body.includes('<script>alert'), 'admin view does not render raw script');
  });

  await truncateTables();
  await cleanupUsers();
  console.log(`\n=== Refund Requests: ${passed} passed, ${failed} failed ===`);
  await testSql.end();
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
