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
import { analyticsService } from '../../services/analytics-service.js';
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
  await test('money bars use a signed domain and zero baseline for refund days', () => {
    const chart = barChart([120, -80, -25], { scale: true, yUnit: '$' });
    const heights = [...chart.matchAll(/height="([\d.]+)"/g)].map((m) => Number(m[1])).filter((n) => n < 100);
    assert(heights.length === 3 && heights.every((n) => n > 0), 'all bars have positive SVG heights');
    assert(chart.includes('−$80'), 'negative axis tick is labeled');
    assert(chart.includes('stroke-width="1.2"'), 'zero baseline is drawn');
  });
  await test('booking projection shares the historical x-domain', () => {
    const chart = bookingCurve({ cumulative: [2, 4, 7], capacity: 20, projection: [7, 11, 15, 18] });
    const projectionPoints = chart.match(/stroke="#C2410C"[^>]*points="([^"]+)"/)?.[1];
    assert(typeof projectionPoints === 'string', 'projection polyline exists');
    const xs = projectionPoints!.split(' ').map((point) => Number(point.split(',')[0]));
    assert(xs.every((x) => x >= 0 && x <= 520), `projected x values fit viewBox: ${xs.join(',')}`);
    assert(xs[xs.length - 1] === 492, 'forecast reaches right edge inside chart');
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
    assert(body.includes('Events · lifetime') && body.includes('Customers · lifetime'), 'lifetime panels are labeled');
    assert(body.includes('View daily values') && body.includes('View funnel counts'), 'chart data has text equivalents');
  });

  await test('dashboard range swap returns a bare HTMX fragment', async () => {
    const frag = await get('/admin/analytics?range=30', adminCookie, { 'HX-Request': 'true' });
    const body = await frag.text();
    assert(!body.includes('<html') && body.includes('Gross sales'), 'fragment without layout');
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

  // ── W17 — net/refund math reconciles over the same population ──
  // Add a third sale that was confirmed in-period then fully refunded: it flips to
  // CANCELLED but keeps confirmed_at and refunded_amount_cents = gross. Previously
  // gross (CONFIRMED-only) excluded it while refunds counted it, so net could go
  // negative and refund-rate exceed 100%.
  const refundedRegId = (await testSql`INSERT INTO registrations (event_id,email,first_name,last_name,gross_amount_cents,net_amount_cents,refunded_amount_cents,payment_intent_id,status,confirmed_at,cancelled_at)
    VALUES (${ev},'refunded-i10@example.com','R','Funded',2500,0,2500,'pi_ref','CANCELLED',now()-interval '1 days',now()) RETURNING registration_id`)[0].registration_id as string;
  await testSql`INSERT INTO refund_log (registration_id,event_id,stripe_refund_id,refund_type,amount_cents,reason,created_at)
    VALUES (${refundedRegId},${ev},'re_test','FULL',2500,'test_refund',now()-interval '1 days')`;

  await test('W17: net ≥ 0 and refund rate ≤ 100% over same population', async () => {
    const d = await analyticsService.getSalesDashboard(90);
    assert(d.kpis.refundedCents > 0, 'refunds counted');
    assert(d.kpis.netCents >= 0, `net ≥ 0 (got ${d.kpis.netCents})`);
    assert(d.kpis.refundRatePct <= 100, `refund rate ≤ 100% (got ${d.kpis.refundRatePct})`);
    // 3 confirmed-in-period sales × $25 gross = $75; refunded $25 → net $50.
    assertEqual(d.kpis.grossCents, 7500, 'gross over same population');
    assertEqual(d.kpis.netCents, 5000, 'net = gross − refunded');
  });

  // A partial refund must reduce lifetime customer net, and refunds against an
  // older sale must not move into a current sales-confirmation cohort.
  await testSql`UPDATE registrations SET refunded_amount_cents=500 WHERE payment_intent_id='pi_a1'`;
  await testSql`INSERT INTO refund_log (registration_id,event_id,stripe_refund_id,refund_type,amount_cents,reason,created_at)
    SELECT registration_id,event_id,'re_partial_i10','PARTIAL',500,'test_partial',now()
    FROM registrations WHERE payment_intent_id='pi_a1'`;
  const oldRegId = (await testSql`INSERT INTO registrations (event_id,email,first_name,last_name,gross_amount_cents,net_amount_cents,refunded_amount_cents,payment_intent_id,status,confirmed_at)
    VALUES (${ev},'old-i10@example.com','Old','Sale',1000,950,0,'pi_old_i10','CONFIRMED',now()-interval '40 days') RETURNING registration_id`)[0].registration_id as string;
  await testSql`UPDATE registrations SET refunded_amount_cents=400 WHERE registration_id=${oldRegId}`;
  await testSql`INSERT INTO refund_log (registration_id,event_id,stripe_refund_id,refund_type,amount_cents,reason,created_at)
    VALUES (${oldRegId},${ev},'re_old_i10','PARTIAL',400,'test_old_refund',now())`;

  await test('partial and late refunds follow the sales-cohort definition', async () => {
    const d = await analyticsService.getSalesDashboard(30);
    const dailyNet = d.dailyRevenue.reduce((sum, value) => sum + value, 0);
    assertEqual(dailyNet, d.kpis.netCents, 'daily sales cohort reconciles to net KPI');
    assert(d.dailyLabels.length === d.dailyRevenue.length, 'dates align with daily values');
    const customer = d.customers.top.find((row) => row.email === 'buyer-i10-1@example.com');
    assert(!!customer, 'partial-refund customer is listed');
    assertEqual(customer!.lifetime_net, 2000, 'lifetime net subtracts partial refund');
    assertEqual(d.kpis.netCents, 4500, 'late refund of an older sale is outside current sales cohort');
  });

  // ── W19 — A1 funnel (5 stages + views) + truly-net daily revenue ──
  // Record storefront views so the top Views stage ≥ Initiated (browse-only),
  // matching the real funnel shape; the seed has 4 created registrations.
  for (let i = 0; i < 6; i++) await analyticsService.recordEventView(ev);

  await test('W19: funnel has Views/Initiated/Authorized/Captured/Confirmed, monotone, conversions ≤ 100', async () => {
    const d = await analyticsService.getSalesDashboard(90);
    const labels = d.paymentFunnel.stages.map((s) => s.label);
    assertEqual(labels.join(','), 'Views,Initiated,Authorized,Captured,Confirmed', 'stage labels');
    const counts = d.paymentFunnel.stages.map((s) => s.count);
    for (let i = 1; i < counts.length; i++) assert(counts[i] <= counts[i - 1], `monotone non-increasing at ${i}`);
    assertEqual(d.paymentFunnel.conversions.length, 4, 'conversions length = stages-1');
    d.paymentFunnel.conversions.forEach((p) => assert(p <= 100, `conversion ≤ 100 (got ${p})`));
  });

  await test('W19: dashboard renders "Daily net revenue"', async () => {
    const body = await (await get('/admin/analytics', adminCookie)).text();
    assert(body.includes('Daily net revenue'), 'daily net revenue label');
  });

  // ── W21 — A2 event performance views + revenue, WF-10 strip ──
  await analyticsService.recordEventView(ev);
  await analyticsService.recordEventView(ev);

  await test('W21: getEventPerformance returns views and net revenue ≥ 0', async () => {
    const perf = await analyticsService.getEventPerformance(ev);
    assert(perf !== null, 'perf present');
    assert(perf!.views >= 2, `views recorded (got ${perf!.views})`);
    assert(perf!.revenue.netCents >= 0, `net ≥ 0 (got ${perf!.revenue.netCents})`);
    assert(perf!.revenue.refundedCents > 0, 'refunds reflected');
  });

  await test('W21: admin event detail shows WF-10 strip (sparkline + projection + Performance link)', async () => {
    const perf = await analyticsService.getEventPerformance(ev);
    const body = await (await get(`/admin/events/${ev}`, adminCookie)).text();
    assert(body.includes('<svg'), 'sparkline svg present');
    assert(body.includes(`/admin/events/${ev}/performance`), 'Performance link');
    assert(body.includes(perf!.projection.headline), 'projection headline text');
  });

  await truncateTables();
  await cleanup();
  console.log(`\n=== Analytics: ${passed} passed, ${failed} failed ===`);
  await testSql.end();
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
