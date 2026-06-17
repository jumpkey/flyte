/**
 * W20 — admin dashboard attention panel (addendum A5).
 *
 * The panel is a prioritized, deep-linked trigger list: pending refunds,
 * unsent receipts >1h, PENDING_CAPTURE >2h, drafts opening soon, AT-RISK
 * events, and events in the next 7 days. It is calm (an "all clear" line) when
 * nothing is wrong — that quiet is what makes a trigger land when it appears.
 *
 * Run: npx tsx src/web/testing/admin-dashboard.test.ts
 */
import 'dotenv/config';
import { testSql, truncateTables, assert, assertEqual } from '../../registration/testing/test-helpers.js';
import { authService } from '../../services/auth-service.js';
import { createSession } from '../middleware/session.js';
import { adminDashboardService } from '../../services/admin-dashboard-service.js';

const ADMIN_EMAIL = 'admin-w20@example.com';

async function cleanup() {
  const ids = (await testSql`SELECT id FROM users WHERE email = ${ADMIN_EMAIL}`).map((r) => r.id as string);
  if (ids.length) {
    await testSql`DELETE FROM sessions WHERE user_id = ANY(${ids})`;
    await testSql`DELETE FROM users WHERE id = ANY(${ids})`;
  }
}

async function get(path: string, cookie?: string) {
  const { app } = await import('../app.js');
  return app.request(`http://localhost${path}`, { headers: { ...(cookie ? { Cookie: cookie } : {}) } });
}

/** An OPEN, near-future event whose counters satisfy capacity_invariant. */
async function createEvent(o: { status?: string; daysOut?: number; capacity?: number; confirmed?: number; openedDaysAgo?: number } = {}): Promise<string> {
  const cap = o.capacity ?? 10;
  const confirmed = o.confirmed ?? 0;
  const rows = await testSql`
    INSERT INTO events (name, event_date, total_capacity, confirmed_count, available_slots,
                        registration_fee_cents, status, opened_at)
    VALUES ('W20 Event', now() + (${o.daysOut ?? 5}||' days')::interval,
            ${cap}, ${confirmed}, ${cap - confirmed}, 2500, ${o.status ?? 'OPEN'},
            now() - (${o.openedDaysAgo ?? 1}||' days')::interval)
    RETURNING event_id`;
  return rows[0].event_id as string;
}

let _regSeq = 0;
async function insertReg(eventId: string, o: { status: string; confirmedAgo?: string; createdAgo?: string; receiptSent?: boolean }): Promise<string> {
  const email = `cust-w20-${_regSeq++}@example.com`; // unique: one active reg per (email,event)
  const rows = await testSql`
    INSERT INTO registrations (event_id, email, first_name, last_name, gross_amount_cents,
                               net_amount_cents, payment_intent_id, status,
                               created_at, confirmed_at, confirmation_email_sent_at)
    VALUES (${eventId}, ${email}, 'Cu', 'St', 2500, 2500,
            ${'pi_w20_' + Math.random().toString(36).slice(2, 10)}, ${o.status},
            ${o.createdAgo ? testSql`now() - ${o.createdAgo}::interval` : testSql`now()`},
            ${o.confirmedAgo ? testSql`now() - ${o.confirmedAgo}::interval` : null},
            ${o.receiptSent ? testSql`now()` : null})
    RETURNING registration_id`;
  return rows[0].registration_id as string;
}

async function runTests() {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => Promise<void> | void) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}:`, e instanceof Error ? e.message : String(e)); failed++; }
  }

  console.log('\n=== W20: Dashboard attention panel ===\n');

  await cleanup();
  const hash = await authService.hashPassword('pw');
  const adminId = (await testSql`INSERT INTO users (email,password_hash,display_name,is_verified,is_admin,account_status) VALUES (${ADMIN_EMAIL},${hash},'A',TRUE,TRUE,'active') RETURNING id`)[0].id as string;
  const { signedSid } = await createSession({ userId: adminId }, adminId);
  const adminCookie = `sid=${signedSid}`;

  await test('calm when nothing is wrong: empty attention + "All clear" rendered', async () => {
    await truncateTables();
    const data = await adminDashboardService.getDashboard();
    assertEqual(data.attention.length, 0, 'no triggers');
    const body = await (await get('/admin', adminCookie)).text();
    assert(body.includes('All clear'), 'calm line shown');
    assert(!body.includes('Needs attention'), 'no alarm header when calm');
  });

  await test('A2: Recent transactions panel links to the searchable transactions list', async () => {
    await truncateTables();
    const body = await (await get('/admin', adminCookie)).text();
    assert(body.includes('href="/admin/registrations"'), 'view-all / search transactions link present');
  });

  await test('triggers fire, deep-linked and prioritized (danger before warning before info)', async () => {
    await truncateTables();
    const ev = await createEvent({ status: 'OPEN', daysOut: 5 }); // also an event in next 7 days (info)

    // danger: a PENDING_CAPTURE older than 2h
    await insertReg(ev, { status: 'PENDING_CAPTURE', createdAgo: '3 hours' });
    // danger: a pending refund request on a CONFIRMED reg
    const confReg = await insertReg(ev, { status: 'CONFIRMED', confirmedAgo: '3 hours', receiptSent: true });
    await testSql`INSERT INTO refund_requests (registration_id, status) VALUES (${confReg}::UUID, 'REQUESTED')`;
    // warning: a CONFIRMED reg whose receipt is unsent and is older than 1h
    await insertReg(ev, { status: 'CONFIRMED', confirmedAgo: '2 hours', receiptSent: false });
    // warning: a DRAFT event with an event date within 14 days
    await createEvent({ status: 'DRAFT', daysOut: 10 });

    const data = await adminDashboardService.getDashboard();
    const texts = data.attention.map((a) => a.text);
    assert(texts.some((t) => /stuck in capture/.test(t)), 'stuck-capture trigger');
    assert(texts.some((t) => /pending refund request/.test(t)), 'pending-refund trigger');
    assert(texts.some((t) => /receipt.*unsent/.test(t)), 'unsent-receipt trigger');
    assert(texts.some((t) => /draft/.test(t)), 'draft-soon trigger');
    assert(texts.some((t) => /next 7 days/.test(t)), 'events-next-7d trigger');

    // Priority ordering: every danger precedes every warning precedes every info.
    const rank = { danger: 0, warning: 1, info: 2 } as const;
    const ranks = data.attention.map((a) => rank[a.severity]);
    for (let i = 1; i < ranks.length; i++) assert(ranks[i] >= ranks[i - 1], 'severities are non-decreasing (prioritized)');

    // Deep links resolve to real admin destinations.
    for (const a of data.attention) assert(a.href.startsWith('/admin'), `deep link: ${a.href}`);

    const body = await (await get('/admin', adminCookie)).text();
    assert(body.includes('Needs attention'), 'alarm header shown');
    assert(body.includes('/admin/registrations?status=PENDING_CAPTURE'), 'stuck-capture deep link rendered');
    assert(!body.includes('All clear'), 'no calm line when triggers exist');

    await testSql`DELETE FROM refund_requests WHERE registration_id = ${confReg}::UUID`;
  });

  await test('AT-RISK event surfaces as a warning trigger', async () => {
    await truncateTables();
    // Opened 30d ago, big capacity, almost no sales, event soon → projects far
    // under capacity → AT_RISK band.
    await createEvent({ status: 'OPEN', daysOut: 6, capacity: 100, confirmed: 2, openedDaysAgo: 30 });
    const data = await adminDashboardService.getDashboard();
    assert(data.attention.some((a) => a.severity === 'warning' && /at risk/.test(a.text)), 'AT-RISK trigger present');
  });

  await cleanup();
  await truncateTables();
  console.log(`\n=== Admin Dashboard: ${passed} passed, ${failed} failed ===`);
  await testSql.end();
  if (failed > 0) process.exit(1);
}

runTests().catch((err) => { console.error(err); process.exit(1); });
