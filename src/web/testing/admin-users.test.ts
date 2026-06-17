/**
 * I8 — Admin users & activity (AC-I8 ①–⑤).
 *
 * Search/filter composition, lock (live-session revocation + audit) / unlock,
 * the self-lock guard, the shadow-account label, and the unified activity feed
 * with its filters + pagination.
 *
 * Run: npx tsx src/web/testing/admin-users.test.ts
 */
import 'dotenv/config';
import { testSql, assert, assertEqual } from '../../registration/testing/test-helpers.js';
import { authService } from '../../services/auth-service.js';
import { adminUsersService } from '../../services/admin-users-service.js';
import { createSession } from '../middleware/session.js';

const CSRF = 'a1b2c3d4e5f60718'.repeat(4);
const EMAILS = ['admin-i8@example.com', 'target-i8@example.com', 'shadow-i8@example.com'];

const TIMELINE_EVENT = 'Timeline Test Fest (D2)';

async function cleanup() {
  const ids = (await testSql`SELECT id FROM users WHERE email = ANY(${EMAILS})`).map((r) => r.id as string);
  if (ids.length) {
    // Children before users (FK-safe). refund_log → registrations → events.
    const regIds = (await testSql`SELECT registration_id FROM registrations WHERE user_id = ANY(${ids})`).map((r) => r.registration_id as string);
    if (regIds.length) await testSql`DELETE FROM refund_log WHERE registration_id = ANY(${regIds})`;
    await testSql`DELETE FROM user_action_events WHERE user_id = ANY(${ids})`;
    await testSql`DELETE FROM login_events WHERE user_id = ANY(${ids})`;
    await testSql`DELETE FROM sessions WHERE user_id = ANY(${ids})`;
    await testSql`DELETE FROM waitlist_entries WHERE user_id = ANY(${ids})`;
    await testSql`DELETE FROM registrations WHERE user_id = ANY(${ids})`;
    await testSql`DELETE FROM users WHERE id = ANY(${ids})`;
  }
  await testSql`DELETE FROM events WHERE name = ${TIMELINE_EVENT}`;
}
async function makeUser(email: string, opts: { isAdmin?: boolean; status?: string } = {}): Promise<string> {
  const hash = await authService.hashPassword('pw');
  const rows = await testSql`
    INSERT INTO users (email, password_hash, display_name, is_verified, is_admin, account_status)
    VALUES (${email}, ${opts.status === 'shadow' ? null : hash}, ${email.split('@')[0]}, TRUE, ${opts.isAdmin ?? false}, ${opts.status ?? 'active'})
    RETURNING id`;
  return rows[0].id as string;
}
async function get(path: string, cookie?: string) {
  const { app } = await import('../app.js');
  return app.request(`http://localhost${path}`, { headers: cookie ? { Cookie: cookie } : {} });
}
async function postForm(path: string, cookie: string, withCsrf = true) {
  const { app } = await import('../app.js');
  return app.request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: withCsrf ? `_csrf=${CSRF}` : '',
  });
}

async function runTests() {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => Promise<void>) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}:`, e instanceof Error ? e.message : String(e)); failed++; }
  }

  console.log('\n=== I8: Admin Users & Activity ===\n');
  await cleanup();
  const adminId = await makeUser(EMAILS[0], { isAdmin: true });
  const targetId = await makeUser(EMAILS[1]);
  const shadowId = await makeUser(EMAILS[2], { status: 'shadow' });
  const { signedSid: adminSid } = await createSession({ userId: adminId, csrfToken: CSRF }, adminId);
  const adminCookie = `sid=${adminSid}`;

  // ── Guard ──
  await test('user pages are admin-only', async () => {
    assertEqual((await get('/admin/users')).status, 404, 'anon list 404');
    assertEqual((await get('/admin/users', adminCookie)).status, 200, 'admin list 200');
    assertEqual((await get('/admin/activity', adminCookie)).status, 200, 'admin activity 200');
  });

  // ── Search + filters compose (① ④) ──
  await test('search + status filter compose; shadow label shown on detail', async () => {
    const list = await (await get('/admin/users?q=target-i8&status=active', adminCookie)).text();
    assert(list.includes('target-i8@example.com') && !list.includes('shadow-i8@example.com'), 'search + active filter');
    const lockedNone = await (await get('/admin/users?locked=true', adminCookie)).text();
    assert(!lockedNone.includes('target-i8@example.com'), 'locked filter excludes unlocked');
    const detail = await (await get(`/admin/users/${shadowId}`, adminCookie)).text();
    assert(detail.includes('shadow account'), 'shadow label on detail (④)');
  });

  // ── Lock revokes live sessions + audit (②); unlock reverses ──
  await test('lock revokes the target\'s live session, sets locked, audits; unlock reverses', async () => {
    // Give the target a live session and confirm it works.
    const { signedSid: targetSid } = await createSession({ userId: targetId }, targetId);
    const targetCookie = `sid=${targetSid}`;
    assertEqual((await get('/dashboard', targetCookie)).status, 200, 'target session works before lock');

    const resp = await postForm(`/admin/users/${targetId}/lock`, adminCookie);
    assertEqual(resp.status, 302, 'lock redirects');
    // Session revoked → the old cookie no longer authenticates.
    const after = await get('/dashboard', targetCookie);
    assert(after.status === 302 || after.status === 404, `revoked session no longer valid (got ${after.status})`);
    const row = (await testSql`SELECT is_locked FROM users WHERE id=${targetId}::UUID`)[0];
    assertEqual(row.is_locked, true, 'user locked');
    const sessions = (await testSql`SELECT count(*)::int AS n FROM sessions WHERE user_id=${targetId}::UUID`)[0].n;
    assertEqual(sessions, 0, 'live sessions revoked');
    const audit = (await testSql`SELECT count(*)::int AS n FROM user_action_events WHERE user_id=${adminId}::UUID AND action='user_locked'`)[0].n;
    assert(audit >= 1, 'lock audited');

    await postForm(`/admin/users/${targetId}/unlock`, adminCookie);
    assertEqual((await testSql`SELECT is_locked FROM users WHERE id=${targetId}::UUID`)[0].is_locked, false, 'unlocked');
  });

  // ── Self-lock rejected (③) ──
  await test('an admin cannot lock their own account', async () => {
    await postForm(`/admin/users/${adminId}/lock`, adminCookie);
    assertEqual((await testSql`SELECT is_locked FROM users WHERE id=${adminId}::UUID`)[0].is_locked, false, 'self not locked');
  });

  await test('lock requires CSRF', async () => {
    assertEqual((await postForm(`/admin/users/${targetId}/lock`, adminCookie, false)).status, 403, 'no csrf → 403');
  });

  // ── Activity feed filters + pagination (⑤) ──
  await test('activity feed unions login + action events and filters by type/email', async () => {
    await testSql`INSERT INTO login_events (user_id, email_attempted, success, ip_address) VALUES (${targetId}, ${EMAILS[1]}, TRUE, '1.2.3.4')`;
    await testSql`INSERT INTO user_action_events (user_id, action, ip_address) VALUES (${targetId}, 'profile_updated', '1.2.3.4')`;
    const all = await (await get(`/admin/activity?email=target-i8`, adminCookie)).text();
    assert(all.includes('profile_updated') && all.includes('Signed in'), 'both kinds shown');
    const loginsOnly = await (await get(`/admin/activity?type=login&email=target-i8`, adminCookie)).text();
    assert(loginsOnly.includes('Signed in') && !loginsOnly.includes('profile_updated'), 'type filter composes');
  });

  await test('activity feed paginates at 50/page', async () => {
    // 51 action events for the target → two pages.
    for (let i = 0; i < 51; i++) await testSql`INSERT INTO user_action_events (user_id, action, ip_address) VALUES (${targetId}, ${'evt_'+i}, '9.9.9.9')`;
    const p1 = await (await get(`/admin/activity?type=action&email=target-i8`, adminCookie)).text();
    assert(p1.includes('Page 1 of'), 'paginated');
  });

  // ── C1: users list pagination + sortable headers ──
  await test('users list paginates at 25/page and offers sortable headers', async () => {
    // Seed >25 users so the list spans multiple pages.
    const seeded: string[] = [];
    for (let i = 0; i < 30; i++) seeded.push(await makeUser(`c1-user-${String(i).padStart(2, '0')}@example.com`));
    EMAILS.push(...seeded.map((_, i) => `c1-user-${String(i).padStart(2, '0')}@example.com`));

    const p1 = await (await get('/admin/users?q=c1-user', adminCookie)).text();
    assert(p1.includes('Page 1 of'), 'page indicator shown');
    assert(/Page 1 of [2-9]/.test(p1), 'at least two pages for 30 users at 25/page');
    // A clickable sort link with sort+dir is present.
    assert(p1.includes('sort=email') && p1.includes('dir='), 'sortable header links present');
  });

  await test('?sort=email&dir=asc orders rows ascending by email', async () => {
    const body = await (await get('/admin/users?q=c1-user&sort=email&dir=asc', adminCookie)).text();
    // First seeded email c1-user-00 sorts first ascending; c1-user-29 should NOT
    // appear on page 1 (it's last alphabetically, on page 2).
    const i00 = body.indexOf('c1-user-00@example.com');
    const i01 = body.indexOf('c1-user-01@example.com');
    assert(i00 !== -1 && i01 !== -1 && i00 < i01, 'ascending email order: 00 before 01');
    assert(!body.includes('c1-user-29@example.com'), 'last email is on page 2, not page 1');
  });

  await test('existing user filters still work after pagination change', async () => {
    const list = await (await get('/admin/users?q=target-i8&status=active', adminCookie)).text();
    assert(list.includes('target-i8@example.com') && !list.includes('shadow-i8@example.com'), 'search + active filter still composes');
  });

  // ── Batch D2: unified activity timeline on the user-detail page ──
  // Use a dedicated, uncluttered user so ordering across the union is deterministic
  // (the earlier activity-feed tests bulk-seed events onto targetId).
  const tlEmail = 'timeline-d2@example.com';
  EMAILS.push(tlEmail);
  const tlUserId = await makeUser(tlEmail);

  await test('getTimeline unions all kinds newest-first and counts everything incl. account-created', async () => {
    // A non-CONFIRMED event/registration so we never touch slot counters.
    const eventId = (await testSql`
      INSERT INTO events (name, event_date, total_capacity, confirmed_count, available_slots, registration_fee_cents, status)
      VALUES (${TIMELINE_EVENT}, now() + interval '30 days', 50, 0, 50, 2500, 'OPEN')
      RETURNING event_id`)[0].event_id as string;
    const regId = (await testSql`
      INSERT INTO registrations (event_id, user_id, email, first_name, last_name, gross_amount_cents, status, created_at)
      VALUES (${eventId}, ${tlUserId}, ${tlEmail}, 'Tar', 'Get', 2500, 'PENDING_PAYMENT', now() - interval '5 hours')
      RETURNING registration_id`)[0].registration_id as string;
    await testSql`INSERT INTO refund_log (registration_id, event_id, stripe_refund_id, refund_type, amount_cents, reason, created_at)
      VALUES (${regId}, ${eventId}, 're_d2', 'PARTIAL', 1000, 'test', now() - interval '4 hours')`;
    await testSql`INSERT INTO login_events (user_id, email_attempted, success, ip_address, created_at)
      VALUES (${tlUserId}, ${tlEmail}, TRUE, '1.2.3.4', now() - interval '3 hours')`;
    await testSql`INSERT INTO waitlist_entries (event_id, user_id, email, first_name, last_name, created_at)
      VALUES (${eventId}, ${tlUserId}, ${tlEmail}, 'Tar', 'Get', now() - interval '2 hours')`;
    await testSql`INSERT INTO user_action_events (user_id, action, ip_address, created_at)
      VALUES (${tlUserId}, 'profile_updated_d2', '1.2.3.4', now() - interval '1 hours')`;

    const tl = await adminUsersService.getTimeline(tlUserId, 1, 20);
    const kinds = tl.rows.map((r) => r.kind as string);
    assert(kinds.includes('account'), 'account-created present');
    assert(kinds.includes('registration'), 'registration present');
    assert(kinds.includes('refund'), 'refund present');
    assert(kinds.includes('login'), 'login present');
    assert(kinds.includes('waitlist'), 'waitlist present');
    assert(kinds.includes('action'), 'action present');
    // 5 seeded rows + account-created = 6 total for this fresh user.
    assertEqual(tl.total, 6, 'total counts all rows incl. account-created');
    // Newest-first: the action (1h ago) precedes the login (3h ago), which
    // precedes the registration (5h ago). (Account-created is "now" for this
    // freshly-inserted user, so it sorts first — not asserted here.)
    const iAction = kinds.indexOf('action');
    const iLogin = kinds.indexOf('login');
    const iReg = kinds.indexOf('registration');
    assert(iAction < iLogin && iLogin < iReg, 'newest-first ordering across kinds');
  });

  await test('user-detail page renders an Activity timeline with the seeded entries', async () => {
    const detail = await (await get(`/admin/users/${tlUserId}`, adminCookie)).text();
    assert(detail.includes('Activity timeline'), 'timeline section heading');
    assert(detail.includes('id="user-timeline"'), 'timeline container present');
    assert(detail.includes(TIMELINE_EVENT), 'registration/event row shown');
    assert(detail.includes('profile_updated_d2'), 'action row shown');
    assert(detail.includes('Account created'), 'account-created row shown');
    assert(!detail.includes('Login history') && !detail.includes('Action history'), 'old raw history sections removed');
  });

  await test('timeline paginates at 20/page and the page-2 endpoint returns a bare fragment', async () => {
    for (let i = 0; i < 25; i++) {
      await testSql`INSERT INTO user_action_events (user_id, action, ip_address, created_at)
        VALUES (${tlUserId}, ${'tl_evt_' + i}, '9.9.9.9', now() - interval '10 hours' - (${i} || ' seconds')::interval)`;
    }
    const tl = await adminUsersService.getTimeline(tlUserId, 1, 20);
    assert(tl.totalPages >= 2, `multiple pages (got ${tl.totalPages})`);

    const page1 = await (await get(`/admin/users/${tlUserId}`, adminCookie)).text();
    assert(/Page 1 of [2-9]/.test(page1), 'page indicator on detail');

    const page2 = await (await get(`/admin/users/${tlUserId}/timeline?page=2`, adminCookie)).text();
    assert(!page2.toLowerCase().includes('<html'), 'page 2 is a bare fragment (no layout)');
    assert(page2.includes('Page 2 of'), 'page 2 indicator present');
  });

  await cleanup();
  console.log(`\n=== Admin Users: ${passed} passed, ${failed} failed ===`);
  await testSql.end();
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
