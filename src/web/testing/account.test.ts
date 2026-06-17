/**
 * I7 — Account & dashboard (AC-I7 ①–④).
 *
 * My Registrations scoped to the session user (including guest-era purchases and
 * waitlist entries, #29), ownership enforcement (R3), refund-request eligibility,
 * the empty state, and the dashboard "Your upcoming events" panel.
 *
 * Run: npx tsx src/web/testing/account.test.ts
 */
import 'dotenv/config';
import { testSql, truncateTables, assert, assertEqual } from '../../registration/testing/test-helpers.js';
import { authService } from '../../services/auth-service.js';
import { createSession } from '../middleware/session.js';

const EMAILS = ['acct-a@example.com', 'acct-b@example.com'];

async function cleanup() {
  const ids = (await testSql`SELECT id FROM users WHERE email = ANY(${EMAILS})`).map((r) => r.id as string);
  if (ids.length) {
    await testSql`DELETE FROM registrations WHERE user_id = ANY(${ids})`;
    await testSql`DELETE FROM waitlist_entries WHERE user_id = ANY(${ids})`;
    await testSql`DELETE FROM sessions WHERE user_id = ANY(${ids})`;
    await testSql`DELETE FROM users WHERE id = ANY(${ids})`;
  }
}
async function makeUser(email: string): Promise<{ id: string; cookie: string }> {
  const hash = await authService.hashPassword('pw');
  const rows = await testSql`INSERT INTO users (email,password_hash,display_name,is_verified,account_status) VALUES (${email},${hash},'Acct',TRUE,'active') RETURNING id`;
  const id = rows[0].id as string;
  const { signedSid } = await createSession({ userId: id }, id);
  return { id, cookie: `sid=${signedSid}` };
}
async function createEvent(name: string, daysOut = 20): Promise<string> {
  const rows = await testSql`INSERT INTO events (name,event_date,total_capacity,confirmed_count,available_slots,registration_fee_cents,status) VALUES (${name}, now()+(${daysOut}||' days')::interval, 50, 0, 50, 2500, 'OPEN') RETURNING event_id`;
  return rows[0].event_id as string;
}
async function createReg(eventId: string, userId: string | null, status: string): Promise<string> {
  const rows = await testSql`
    INSERT INTO registrations (event_id,user_id,email,first_name,last_name,gross_amount_cents,net_amount_cents,refunded_amount_cents,payment_intent_id,status,confirmed_at)
    VALUES (${eventId},${userId},'buyer@example.com','Buy','Er',2500,2400,0,${'pi_'+Math.random().toString(36).slice(2)},${status},${status==='CONFIRMED'?new Date():null})
    RETURNING registration_id`;
  return rows[0].registration_id as string;
}
async function get(path: string, cookie?: string) {
  const { app } = await import('../app.js');
  return app.request(`http://localhost${path}`, { headers: cookie ? { Cookie: cookie } : {} });
}

async function runTests() {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => Promise<void>) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}:`, e instanceof Error ? e.message : String(e)); failed++; }
  }

  console.log('\n=== I7: Account & Dashboard ===\n');
  await cleanup();
  const a = await makeUser(EMAILS[0]);
  const b = await makeUser(EMAILS[1]);

  await test('My Registrations lists the user\'s purchases (J3 payoff) and waitlists (#29)', async () => {
    await truncateTables();
    const ev = await createEvent('My Concert');
    await createReg(ev, a.id, 'CONFIRMED');                       // a "guest-era" purchase bound to the user
    const evWl = await createEvent('Waitlisted Gig');
    await testSql`INSERT INTO waitlist_entries (event_id, user_id, email, first_name, last_name) VALUES (${evWl}, ${a.id}, 'buyer@example.com', 'Buy', 'Er')`;
    const body = await (await get('/account/registrations', a.cookie)).text();
    assert(body.includes('My Concert'), 'registration shown');
    assert(body.includes('Waitlists') && body.includes('Waitlisted Gig'), 'waitlist section shown');
  });

  await test('W8: My Registrations shows a "Registrations" heading and roomy tables', async () => {
    await truncateTables();
    const ev = await createEvent('Heading Concert');
    await createReg(ev, a.id, 'CONFIRMED');
    const evWl = await createEvent('Heading Gig');
    await testSql`INSERT INTO waitlist_entries (event_id, user_id, email, first_name, last_name) VALUES (${evWl}, ${a.id}, 'buyer@example.com', 'Buy', 'Er')`;
    const body = await (await get('/account/registrations', a.cookie)).text();
    assert(body.includes('<h2 class="h5 mb-2">Registrations</h2>'), 'Registrations heading present (parity with Waitlists)');
    assert(body.includes('<h2 class="h5 mb-2">Waitlists</h2>'), 'Waitlists heading still present');
    assertEqual((body.match(/table table-roomy/g) ?? []).length, 2, 'both tables use the roomy spacing class');
    await testSql`DELETE FROM waitlist_entries WHERE event_id = ${evWl}`;
  });

  await test('empty state when the user has nothing', async () => {
    await truncateTables();
    const body = await (await get('/account/registrations', b.cookie)).text();
    assert(body.includes('No registrations yet'), 'empty state');
  });

  await test('ownership (R3): another user\'s registration → 404', async () => {
    await truncateTables();
    const ev = await createEvent('Private');
    const aReg = await createReg(ev, a.id, 'CONFIRMED');
    assertEqual((await get(`/account/registrations/${aReg}`, a.cookie)).status, 200, 'owner sees it');
    assertEqual((await get(`/account/registrations/${aReg}`, b.cookie)).status, 404, 'non-owner 404');
  });

  await test('refund CTA only for CONFIRMED rows without an open/approved request (③)', async () => {
    await truncateTables();
    const ev = await createEvent('Refundable');
    const confirmed = await createReg(ev, a.id, 'CONFIRMED');
    const detail1 = await (await get(`/account/registrations/${confirmed}`, a.cookie)).text();
    assert(detail1.includes('/refund-request'), 'CTA present for eligible row');

    // File a request → CTA disappears, status note appears.
    await testSql`INSERT INTO refund_requests (registration_id, status, reason) VALUES (${confirmed}, 'REQUESTED', 'x')`;
    const detail2 = await (await get(`/account/registrations/${confirmed}`, a.cookie)).text();
    assert(!detail2.includes('/refund-request') && detail2.includes('under review'), 'CTA gone once requested');
    await testSql`DELETE FROM refund_requests WHERE registration_id = ${confirmed}::UUID`;

    // A non-CONFIRMED row never offers the CTA.
    const failed = await createReg(ev, a.id, 'PAYMENT_FAILED');
    const detail3 = await (await get(`/account/registrations/${failed}`, a.cookie)).text();
    assert(!detail3.includes('/refund-request'), 'no CTA for non-CONFIRMED');
  });

  await test('dashboard shows upcoming confirmed events, excludes past/non-confirmed', async () => {
    await truncateTables();
    const future = await createEvent('Future Fest', 15);
    await createReg(future, a.id, 'CONFIRMED');
    const past = await createEvent('Past Party', -5);
    await createReg(past, a.id, 'CONFIRMED');
    const pendingEv = await createEvent('Pending One', 10);
    await createReg(pendingEv, a.id, 'PENDING_PAYMENT');
    const body = await (await get('/dashboard', a.cookie)).text();
    assert(body.includes('Your upcoming events') && body.includes('Future Fest'), 'upcoming shown');
    assert(!body.includes('Past Party'), 'past excluded');
    assert(!body.includes('Pending One'), 'non-confirmed excluded');
  });

  await test('W5: My Registrations waitlist row shows the actual position number', async () => {
    await truncateTables();
    const ev = await createEvent('Queued Show');
    // Two earlier entries push user a to position #3.
    await testSql`INSERT INTO waitlist_entries (event_id, email, first_name, last_name, created_at) VALUES (${ev}, 'e1@example.com', 'E', '1', now() - interval '2 minutes')`;
    await testSql`INSERT INTO waitlist_entries (event_id, email, first_name, last_name, created_at) VALUES (${ev}, 'e2@example.com', 'E', '2', now() - interval '1 minute')`;
    const w = await testSql`INSERT INTO waitlist_entries (event_id, user_id, email, first_name, last_name, created_at) VALUES (${ev}, ${a.id}, ${EMAILS[0]}, 'Acct', 'A', now()) RETURNING waitlist_entry_id`;
    const entryId = w[0].waitlist_entry_id as string;
    const body = await (await get('/account/registrations', a.cookie)).text();
    assert(body.includes('Queued Show'), 'waitlisted event shown');
    assert(body.includes('#3'), 'position number rendered');
    assert(body.includes(`/waitlist/${entryId}`), 'link to the entry kept');
    await testSql`DELETE FROM waitlist_entries WHERE event_id = ${ev}`;
  });

  await test('W4: dashboard shows the user\'s waitlists, linked to /waitlist/:entryId', async () => {
    await truncateTables();
    const ev = await createEvent('Dash Waitlisted', 12);
    const w = await testSql`INSERT INTO waitlist_entries (event_id, user_id, email, first_name, last_name) VALUES (${ev}, ${a.id}, ${EMAILS[0]}, 'Acct', 'A') RETURNING waitlist_entry_id`;
    const entryId = w[0].waitlist_entry_id as string;
    const body = await (await get('/dashboard', a.cookie)).text();
    assert(body.includes('Your waitlists') && body.includes('Dash Waitlisted'), 'waitlist panel shown');
    assert(body.includes(`/waitlist/${entryId}`), 'links the waitlist entry');
    await testSql`DELETE FROM waitlist_entries WHERE event_id = ${ev}`;
  });

  await test('W4: dashboard omits the waitlists panel when the user has none', async () => {
    await truncateTables();
    const body = await (await get('/dashboard', b.cookie)).text();
    assert(!body.includes('Your waitlists'), 'no panel without entries');
  });

  await test('account pages require auth (anonymous redirected to login)', async () => {
    const resp = await get('/account/registrations');
    assert(resp.status === 302 || resp.status === 401 || resp.status === 404, `guarded (got ${resp.status})`);
  });

  // ── V2: add-to-calendar (ICS) ──
  await test('V2: calendar.ics returns a VEVENT for a registration; 404 for unknown', async () => {
    await truncateTables();
    const ev = await createEvent('ICS Fest');
    const id = await createReg(ev, a.id, 'CONFIRMED');
    const resp = await get(`/registration/${id}/calendar.ics`);
    assertEqual(resp.status, 200, 'ics ok');
    assert((resp.headers.get('content-type') || '').includes('text/calendar'), 'calendar content-type');
    const body = await resp.text();
    assert(body.includes('BEGIN:VEVENT') && body.includes('SUMMARY:ICS Fest') && body.includes(`UID:${id}@flyte`), 'VEVENT content');
    assertEqual((await get('/registration/00000000-0000-0000-0000-000000000000/calendar.ics')).status, 404, 'unknown 404');
  });

  // ── V1: find my registration ──
  await test('V1: find-registration always acks (anti-enumeration), CSRF-gated', async () => {
    await truncateTables();
    const { app } = await import('../app.js');
    // Bootstrap CSRF from the form.
    const formResp = await app.request('http://localhost/find-registration');
    const sid = (formResp.headers.get('set-cookie') ?? '').match(/sid=([^;]+)/)?.[1] ?? '';
    const csrf = (await formResp.text()).match(/name="_csrf" value="([^"]+)"/)?.[1] ?? '';
    assert(!!csrf && !!sid, 'form provides csrf + session');
    // No CSRF → 403.
    const noCsrf = await app.request('http://localhost/find-registration', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `sid=${sid}` },
      body: 'email=whoever@example.com',
    });
    assertEqual(noCsrf.status, 403, 'no csrf → 403');
    // With CSRF → uniform ack regardless of whether the email exists.
    const resp = await app.request('http://localhost/find-registration', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: `sid=${sid}` },
      body: new URLSearchParams({ email: 'nobody@example.com', _csrf: csrf }).toString(),
    });
    assert((await resp.text()).includes('Check your email'), 'uniform ack');
  });

  await truncateTables();
  await cleanup();
  console.log(`\n=== Account: ${passed} passed, ${failed} failed ===`);
  await testSql.end();
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
