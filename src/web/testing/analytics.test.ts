/**
 * I10 — Analytics (A1/A2/A4, projection §3.1, SVG charts §6).
 *
 * Pure: projection bands + honesty rules, and the SVG chart helpers. HTTP: the
 * sales dashboard (guard, KPI reconciliation, funnel, activation rate, HTMX
 * range swap), event performance (projection headline, 404), and the events-list
 * pace column.
 *
 * Run: npx tsx src/web/testing/analytics.test.ts
 */
import 'dotenv/config';
import { testSql, truncateTables, assert, assertEqual } from '../../registration/testing/test-helpers.js';
import { authService } from '../../services/auth-service.js';
import { createSession } from '../middleware/session.js';
import { computeProjection } from '../../services/analytics-projection.js';
import { barChart, funnel, bookingCurve, sparkline } from '../utils/svg-charts.js';

const ADMIN_EMAIL = 'admin-i10@example.com';
const DAY = 24 * 60 * 60 * 1000;

async function cleanup() {
  const ids = (await testSql`SELECT id FROM users WHERE email = ${ADMIN_EMAIL}`).map((r) => r.id as string);
  if (ids.length) {
    await testSql`DELETE FROM user_action_events WHERE user_id = ANY(${ids})`;
    await testSql`DELETE FROM sessions WHERE user_id = ANY(${ids})`;
    await testSql`DELETE FROM users WHERE id = ANY(${ids})`;
  }
  await testSql`DELETE FROM users WHERE email LIKE 'buyer-i10-%@example.com'`;
}
async function get(path: string, cookie?: string, headers: Record<string, string> = {}) {
  const { app } = await import('../app.js');
  return app.request(`http://localhost${path}`, { headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });
}

async function runTests() {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => Promise<void> | void) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}:`, e instanceof Error ? e.message : String(e)); failed++; }
  }

  console.log('\n=== I10: Analytics ===\n');
  const now = new Date('2026-06-17T12:00:00Z');

  // ── Projection math (§3.1) ──
  await test('projection: sold out when no slots remain', () => {
    const p = computeProjection({ openedAt: new Date(now.getTime() - 10 * DAY), eventDate: new Date(now.getTime() + 10 * DAY), capacity: 100, confirmed: 100, availableSlots: 0, velocity: 5, now });
    assertEqual(p.band, 'SOLD_OUT', 'band');
  });
  await test('projection: AHEAD when pace index > 1.15', () => {
    const p = computeProjection({ openedAt: new Date(now.getTime() - 10 * DAY), eventDate: new Date(now.getTime() + 10 * DAY), capacity: 100, confirmed: 65, availableSlots: 35, velocity: 5, now });
    assertEqual(p.band, 'AHEAD', `band (pace=${p.paceIndex})`);
  });
  await test('projection: AT RISK when undersell projected', () => {
    const p = computeProjection({ openedAt: new Date(now.getTime() - 10 * DAY), eventDate: new Date(now.getTime() + 10 * DAY), capacity: 100, confirmed: 20, availableSlots: 80, velocity: 1, now });
    assertEqual(p.band, 'AT_RISK', 'band');
  });
  await test('projection: honesty rule — early days, low confidence, no sellout date', () => {
    const p = computeProjection({ openedAt: new Date(now.getTime() - 1 * DAY), eventDate: new Date(now.getTime() + 20 * DAY), capacity: 100, confirmed: 2, availableSlots: 98, velocity: 2, now });
    assert(p.lowConfidence, 'low confidence flagged');
    assert(p.headline.includes('Early days'), 'headline qualified');
  });
  await test('projection: sellout headline names a date when confident', () => {
    const p = computeProjection({ openedAt: new Date(now.getTime() - 10 * DAY), eventDate: new Date(now.getTime() + 10 * DAY), capacity: 100, confirmed: 70, availableSlots: 30, velocity: 6, now });
    assert(!p.lowConfidence && p.projectedSelloutDate !== null && p.headline.toLowerCase().includes('sell out'), 'sellout projected');
  });

  // ── SVG charts (§6) ──
  await test('svg helpers emit valid markup with data', () => {
    assert(barChart([1, 2, 3], { line: [1, 2, 3] }).includes('<svg') && barChart([1, 2, 3]).includes('<rect'), 'bar');
    assert(funnel([{ label: 'Initiated', count: 10 }, { label: 'Confirmed', count: 4 }]).includes('Initiated'), 'funnel labels');
    assert(bookingCurve({ cumulative: [1, 3, 6], capacity: 10, projection: [6, 10] }).includes('<polyline'), 'curve');
    assert(sparkline([1, 2, 1, 3]).includes('<svg'), 'sparkline');
  });

  // ── HTTP: dashboard + performance ──
  await truncateTables();
  await cleanup();
  const hash = await authService.hashPassword('pw');
  const adminId = (await testSql`INSERT INTO users (email,password_hash,display_name,is_verified,is_admin,account_status) VALUES (${ADMIN_EMAIL},${hash},'A',TRUE,TRUE,'active') RETURNING id`)[0].id as string;
  const { signedSid } = await createSession({ userId: adminId }, adminId);
  const adminCookie = `sid=${signedSid}`;

  // Seed: an OPEN event with confirmed registrations bound to buyers (1 active, 1 shadow).
  const ev = (await testSql`INSERT INTO events (name,event_date,total_capacity,confirmed_count,available_slots,registration_fee_cents,status,opened_at) VALUES ('Analytics Fest', now()+interval '10 days', 100, 2, 98, 2500, 'OPEN', now()-interval '10 days') RETURNING event_id`)[0].event_id as string;
  const b1 = (await testSql`INSERT INTO users (email,password_hash,display_name,is_verified,account_status) VALUES ('buyer-i10-1@example.com',${hash},'B1',TRUE,'active') RETURNING id`)[0].id as string;
  const b2 = (await testSql`INSERT INTO users (email,password_hash,display_name,is_verified,account_status) VALUES ('buyer-i10-2@example.com',null,'B2',FALSE,'shadow') RETURNING id`)[0].id as string;
  await testSql`INSERT INTO registrations (event_id,user_id,email,first_name,last_name,gross_amount_cents,net_amount_cents,refunded_amount_cents,payment_intent_id,status,confirmed_at) VALUES (${ev},${b1},'buyer-i10-1@example.com','B','One',2500,2400,0,'pi_a1','CONFIRMED',now()-interval '2 days')`;
  await testSql`INSERT INTO registrations (event_id,user_id,email,first_name,last_name,gross_amount_cents,net_amount_cents,refunded_amount_cents,payment_intent_id,status,confirmed_at) VALUES (${ev},${b2},'buyer-i10-2@example.com','B','Two',2500,2400,0,'pi_a2','CONFIRMED',now()-interval '1 days')`;
  await testSql`INSERT INTO registrations (event_id,email,first_name,last_name,gross_amount_cents,payment_intent_id,status) VALUES (${ev},'fail@example.com','F','Ail',2500,'pi_fail','PAYMENT_FAILED')`;

  await test('analytics dashboard is guarded and reconciles gross', async () => {
    assertEqual((await get('/admin/analytics')).status, 404, 'anon 404');
    const resp = await get('/admin/analytics', adminCookie);
    assertEqual(resp.status, 200, 'admin 200');
    const body = await resp.text();
    assert(body.includes('$50.00'), 'gross = 2×$25 = $50.00');
    assert(body.includes('Payment funnel') && body.includes('Initiated'), 'funnel rendered');
    assert(body.includes('shadow→active') || body.includes('Activated buyers'), 'activation metric (A4)');
  });

  await test('dashboard range swap returns a bare HTMX fragment', async () => {
    const frag = await get('/admin/analytics?range=30', adminCookie, { 'HX-Request': 'true' });
    const body = await frag.text();
    assert(!body.includes('<html') && body.includes('Gross revenue'), 'fragment without layout');
  });

  await test('event performance renders the projection headline; 404 for unknown', async () => {
    const resp = await get(`/admin/events/${ev}/performance`, adminCookie);
    assertEqual(resp.status, 200, 'performance 200');
    const body = await resp.text();
    assert(body.includes('Booking curve') && body.includes('Performance'), 'A2 view');
    assert(/of 100 confirmed/.test(body), 'confirmed count shown');
    assertEqual((await get('/admin/events/00000000-0000-0000-0000-000000000000/performance', adminCookie)).status, 404, 'unknown 404');
  });

  await test('events list shows a pace column with a band', async () => {
    const body = await (await get('/admin/events', adminCookie)).text();
    assert(/Ahead|On pace|At risk|Sold out/.test(body), 'pace band present');
    assert(body.includes(`/admin/events/${ev}/performance`), 'pace links to performance');
  });

  await truncateTables();
  await cleanup();
  console.log(`\n=== Analytics: ${passed} passed, ${failed} failed ===`);
  await testSql.end();
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
