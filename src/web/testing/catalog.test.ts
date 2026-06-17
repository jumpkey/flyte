/**
 * I2 — Storefront catalog (AC-I2 ①–⑤).
 *
 * Card-state classification (helper) + HTTP coverage of the home grid, the
 * /events catalog (filters, pagination, HTMX fragment vs full page), and
 * /events/:id across every status variant, image fallback, and the logged-in
 * "You're registered" state.
 *
 * Run: npx tsx src/web/testing/catalog.test.ts
 */
import 'dotenv/config';
import { testSql, truncateTables, assert, assertEqual } from '../../registration/testing/test-helpers.js';
import { eventCardState } from '../view-helpers.js';
import { authService } from '../../services/auth-service.js';
import { createSession } from '../middleware/session.js';

interface EventOverrides {
  name?: string;
  status?: string;
  daysOut?: number;          // negative → past
  totalCapacity?: number;
  availableSlots?: number;
  feeCents?: number;
  location?: string | null;
  imageUrl?: string | null;
  waitlistEnabled?: boolean;
}

async function createEvent(o: EventOverrides = {}): Promise<string> {
  const total = o.totalCapacity ?? 10;
  const available = o.availableSlots ?? total;
  const confirmed = total - available;
  const rows = await testSql`
    INSERT INTO events (name, event_date, location, total_capacity, confirmed_count, available_slots,
                        registration_fee_cents, status, image_url, waitlist_enabled)
    VALUES (
      ${o.name ?? 'Event'},
      now() + (${o.daysOut ?? 14} || ' days')::interval,
      ${o.location ?? 'Town Hall'},
      ${total}, ${confirmed}, ${available},
      ${o.feeCents ?? 2500},
      ${o.status ?? 'OPEN'},
      ${o.imageUrl ?? null},
      ${o.waitlistEnabled ?? true}
    ) RETURNING event_id`;
  return rows[0].event_id as string;
}

async function get(path: string, cookie?: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const { app } = await import('../app.js');
  const resp = await app.request(`http://localhost${path}`, {
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers },
  });
  return { status: resp.status, body: await resp.text() };
}

async function runTests() {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => Promise<void> | void) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}:`, e instanceof Error ? e.message : String(e)); failed++; }
  }

  console.log('\n=== I2: Storefront Catalog ===\n');

  // ── Card-state helper (AC-I2 ②) ──
  await test('eventCardState classifies available / low / sold-out / closed', () => {
    assertEqual(eventCardState({ status: 'OPEN', available_slots: 8, total_capacity: 10 }).state, 'available', 'available');
    assertEqual(eventCardState({ status: 'OPEN', available_slots: 2, total_capacity: 10 }).state, 'low', 'low (<25%)');
    assertEqual(eventCardState({ status: 'OPEN', available_slots: 0, total_capacity: 10 }).state, 'sold-out', 'zero slots → sold out');
    assertEqual(eventCardState({ status: 'FULL', available_slots: 0, total_capacity: 10 }).state, 'sold-out', 'FULL → sold out');
    assertEqual(eventCardState({ status: 'CLOSED', available_slots: 5, total_capacity: 10 }).state, 'closed', 'closed');
  });

  await test('eventCardState meter floors at 4% and waitlistOpen respects D6 flag', () => {
    assertEqual(eventCardState({ status: 'OPEN', available_slots: 0, total_capacity: 10 }).meterPct, 4, 'meter floor');
    assert(eventCardState({ status: 'FULL', available_slots: 0, total_capacity: 10, waitlist_enabled: true }).waitlistOpen, 'waitlist open');
    assert(!eventCardState({ status: 'FULL', available_slots: 0, total_capacity: 10, waitlist_enabled: false }).waitlistOpen, 'waitlist closed');
  });

  // ── Home (AC-I2 ①) ──
  await test('home shows ≤6 soonest OPEN events, never DRAFT or past', async () => {
    await truncateTables();
    for (let i = 0; i < 7; i++) await createEvent({ name: `Open ${i}`, daysOut: i + 1, status: 'OPEN' });
    await createEvent({ name: 'Draft One', daysOut: 2, status: 'DRAFT' });
    await createEvent({ name: 'Past One', daysOut: -3, status: 'OPEN' });
    const r = await get('/');
    assertEqual(r.status, 200, 'home renders');
    const shown = (r.body.match(/class="event-card/g) ?? []).length;
    assertEqual(shown, 6, 'home caps at 6 cards');
    assert(!r.body.includes('Draft One'), 'DRAFT never on home');
    assert(!r.body.includes('Past One'), 'past never on home');
  });

  await test('home renders an empty state when there are no events', async () => {
    await truncateTables();
    const r = await get('/');
    assertEqual(r.status, 200, 'home renders');
    assert(r.body.includes('No upcoming events'), 'empty state shown');
  });

  // ── Catalog list (AC-I2 ②, ⑤) ──
  await test('/events lists OPEN/FULL/CLOSED upcoming, excludes DRAFT/CANCELLED/past', async () => {
    await truncateTables();
    await createEvent({ name: 'Cat Open', status: 'OPEN' });
    await createEvent({ name: 'Cat Full', status: 'FULL', availableSlots: 0 });
    await createEvent({ name: 'Cat Closed', status: 'CLOSED' });
    await createEvent({ name: 'Cat Draft', status: 'DRAFT' });
    await createEvent({ name: 'Cat Cancelled', status: 'CANCELLED' });
    await createEvent({ name: 'Cat Past', status: 'OPEN', daysOut: -2 });
    const r = await get('/events');
    assertEqual(r.status, 200, 'catalog renders');
    for (const name of ['Cat Open', 'Cat Full', 'Cat Closed']) assert(r.body.includes(name), `${name} visible`);
    for (const name of ['Cat Draft', 'Cat Cancelled', 'Cat Past']) assert(!r.body.includes(name), `${name} hidden`);
  });

  await test('/events text filter matches name or location', async () => {
    await truncateTables();
    await createEvent({ name: 'Jazz Night', location: 'Blue Room' });
    await createEvent({ name: 'Chess Club', location: 'Library' });
    const r = await get('/events?q=jazz');
    assert(r.body.includes('Jazz Night') && !r.body.includes('Chess Club'), 'name filter');
    const r2 = await get('/events?q=library');
    assert(r2.body.includes('Chess Club') && !r2.body.includes('Jazz Night'), 'location filter');
  });

  await test('/events paginates 12/page; HTMX request returns a bare fragment', async () => {
    await truncateTables();
    for (let i = 0; i < 13; i++) await createEvent({ name: `Page Ev ${i}`, daysOut: i + 1 });
    const p1 = await get('/events');
    assertEqual((p1.body.match(/class="event-card/g) ?? []).length, 12, 'page 1 has 12');
    assert(p1.body.includes('Page 1 of 2'), 'pagination indicator');
    assert(p1.body.includes('<html'), 'full page wraps in layout');

    const p2 = await get('/events?page=2', undefined, { 'HX-Request': 'true' });
    assertEqual(p2.status, 200, 'fragment ok');
    assert(!p2.body.includes('<html'), 'HTMX fragment has no layout');
    assertEqual((p2.body.match(/class="event-card/g) ?? []).length, 1, 'page 2 has the 13th');
  });

  // ── Detail variants (AC-I2 ④) ──
  await test('/events/:id OPEN shows the Register CTA and price', async () => {
    await truncateTables();
    const id = await createEvent({ name: 'Detail Open', status: 'OPEN', feeCents: 2500, availableSlots: 8 });
    const r = await get(`/events/${id}`);
    assertEqual(r.status, 200, 'detail renders');
    assert(r.body.includes(`/events/${id}/register`), 'register CTA present');
    assert(r.body.includes('$25.00'), 'price shown');
    assert(r.body.includes('spots left'), 'availability meter');
  });

  await test('/events/:id FULL + waitlist open shows the waitlist CTA', async () => {
    await truncateTables();
    const id = await createEvent({ status: 'FULL', availableSlots: 0, waitlistEnabled: true });
    const r = await get(`/events/${id}`);
    assert(r.body.includes(`/events/${id}/waitlist`), 'waitlist CTA');
    assert(!r.body.includes(`/events/${id}/register`), 'no register CTA when full');
  });

  await test('/events/:id FULL + waitlist closed shows Sold out, no CTA', async () => {
    await truncateTables();
    const id = await createEvent({ status: 'FULL', availableSlots: 0, waitlistEnabled: false });
    const r = await get(`/events/${id}`);
    assert(r.body.includes('Sold out'), 'sold out');
    assert(!r.body.includes(`/events/${id}/waitlist`), 'no waitlist link when closed');
  });

  await test('/events/:id CLOSED shows Registration closed', async () => {
    await truncateTables();
    const id = await createEvent({ status: 'CLOSED' });
    const r = await get(`/events/${id}`);
    assert(r.body.includes('Registration closed'), 'closed state');
  });

  await test('/events/:id 404s for DRAFT, CANCELLED, and unknown', async () => {
    await truncateTables();
    const draft = await createEvent({ status: 'DRAFT' });
    const cancelled = await createEvent({ status: 'CANCELLED' });
    assertEqual((await get(`/events/${draft}`)).status, 404, 'DRAFT 404');
    assertEqual((await get(`/events/${cancelled}`)).status, 404, 'CANCELLED 404');
    assertEqual((await get('/events/00000000-0000-0000-0000-000000000000')).status, 404, 'unknown 404');
  });

  // ── Image handling (AC-I2 ③) ──
  await test('detail renders <img> for an image_url, fallback otherwise', async () => {
    await truncateTables();
    const withImg = await createEvent({ imageUrl: 'https://example.com/x.jpg' });
    const noImg = await createEvent({ imageUrl: null });
    const a = await get(`/events/${withImg}`);
    assert(a.body.includes('src="https://example.com/x.jpg"'), 'img rendered');
    const b = await get(`/events/${noImg}`);
    assert(b.body.includes('event-fallback') && !b.body.includes('<img'), 'fallback only, no img');
  });

  // ── Logged-in "You're registered" state ──
  await test('logged-in holder of an active registration sees "You\'re registered"', async () => {
    await truncateTables();
    const email = 'catalog-holder@example.com';
    await testSql`DELETE FROM login_events WHERE user_id IN (SELECT id FROM users WHERE email=${email})`;
    await testSql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email=${email})`;
    await testSql`DELETE FROM users WHERE email=${email}`;
    const hash = await authService.hashPassword('pw');
    const u = await testSql`INSERT INTO users (email, password_hash, display_name, is_verified, account_status) VALUES (${email}, ${hash}, 'Holder', TRUE, 'active') RETURNING id`;
    const userId = u[0].id as string;
    const id = await createEvent({ status: 'OPEN', availableSlots: 5 });
    await testSql`
      INSERT INTO registrations (event_id, user_id, email, first_name, last_name, gross_amount_cents, status, confirmed_at)
      VALUES (${id}, ${userId}, ${email}, 'Hold', 'Er', 2500, 'CONFIRMED', now())`;
    const { signedSid } = await createSession({ userId }, userId);

    const r = await get(`/events/${id}`, `sid=${signedSid}`);
    assert(r.body.includes("You're registered"), 'shows registered state');
    assert(!r.body.includes(`/events/${id}/register`), 'no register CTA for holder');

    await testSql`DELETE FROM registrations WHERE user_id = ${userId}`;
    await testSql`DELETE FROM sessions WHERE user_id = ${userId}`;
    await testSql`DELETE FROM users WHERE id = ${userId}`;
  });

  // ── W3: logged-in waitlist-aware detail ──
  await test('logged-in waitlist member sees "You\'re on the waitlist (#N)" instead of Join CTA', async () => {
    await truncateTables();
    const email = 'catalog-waiter@example.com';
    await testSql`DELETE FROM waitlist_entries WHERE email=${email}`;
    await testSql`DELETE FROM login_events WHERE user_id IN (SELECT id FROM users WHERE email=${email})`;
    await testSql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email=${email})`;
    await testSql`DELETE FROM users WHERE email=${email}`;
    const hash = await authService.hashPassword('pw');
    const u = await testSql`INSERT INTO users (email, password_hash, display_name, is_verified, account_status) VALUES (${email}, ${hash}, 'Waiter', TRUE, 'active') RETURNING id`;
    const userId = u[0].id as string;
    const id = await createEvent({ status: 'FULL', availableSlots: 0, waitlistEnabled: true });

    // Two earlier entries put our user at position #3.
    await testSql`INSERT INTO waitlist_entries (event_id, email, first_name, last_name, created_at) VALUES (${id}, 'first@example.com', 'A', 'A', now() - interval '2 minutes')`;
    await testSql`INSERT INTO waitlist_entries (event_id, email, first_name, last_name, created_at) VALUES (${id}, 'second@example.com', 'B', 'B', now() - interval '1 minute')`;
    const w = await testSql`INSERT INTO waitlist_entries (event_id, user_id, email, first_name, last_name, created_at) VALUES (${id}, ${userId}, ${email}, 'Wait', 'Er', now()) RETURNING waitlist_entry_id`;
    const entryId = w[0].waitlist_entry_id as string;
    const { signedSid } = await createSession({ userId }, userId);

    const r = await get(`/events/${id}`, `sid=${signedSid}`);
    assert(r.body.includes("You're on the waitlist (#3)"), 'shows waitlist position');
    assert(r.body.includes(`/waitlist/${entryId}`), 'links the waitlist entry');
    assert(!r.body.includes(`/events/${id}/waitlist`), 'no Join the waitlist CTA for a member');

    await testSql`DELETE FROM waitlist_entries WHERE event_id = ${id}`;
    await testSql`DELETE FROM sessions WHERE user_id = ${userId}`;
    await testSql`DELETE FROM users WHERE id = ${userId}`;
  });

  await test('logged-in non-member of a sold-out event still sees the Join CTA', async () => {
    await truncateTables();
    const email = 'catalog-nonwaiter@example.com';
    await testSql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email=${email})`;
    await testSql`DELETE FROM users WHERE email=${email}`;
    const hash = await authService.hashPassword('pw');
    const u = await testSql`INSERT INTO users (email, password_hash, display_name, is_verified, account_status) VALUES (${email}, ${hash}, 'NonWaiter', TRUE, 'active') RETURNING id`;
    const userId = u[0].id as string;
    const id = await createEvent({ status: 'FULL', availableSlots: 0, waitlistEnabled: true });
    const { signedSid } = await createSession({ userId }, userId);

    const r = await get(`/events/${id}`, `sid=${signedSid}`);
    assert(r.body.includes(`/events/${id}/waitlist`), 'Join CTA present for non-member');
    assert(!r.body.includes("You're on the waitlist"), 'no member banner');

    await testSql`DELETE FROM sessions WHERE user_id = ${userId}`;
    await testSql`DELETE FROM users WHERE id = ${userId}`;
  });

  // ── Addendum V3–V6 ──
  await test('V5: /events?when=past shows only past events, in "Held on" style', async () => {
    await truncateTables();
    await createEvent({ name: 'Future Talk', status: 'OPEN', daysOut: 10 });
    await createEvent({ name: 'Old Talk', status: 'CLOSED', daysOut: -10 });
    const upcoming = await get('/events');
    assert(upcoming.body.includes('Future Talk') && !upcoming.body.includes('Old Talk'), 'upcoming excludes past');
    const past = await get('/events?when=past');
    assert(past.body.includes('Old Talk') && !past.body.includes('Future Talk'), 'past excludes future');
    assert(past.body.includes('Held on'), 'past card shows Held on');
  });

  await test('V3: event detail emits Open Graph tags', async () => {
    await truncateTables();
    const id = await createEvent({ name: 'OG Event', imageUrl: 'https://example.com/p.jpg' });
    const r = await get(`/events/${id}`);
    assert(r.body.includes('property="og:title" content="OG Event"'), 'og:title');
    assert(r.body.includes('property="og:image" content="https://example.com/p.jpg"'), 'og:image');
    assert(r.body.includes('rel="canonical"'), 'canonical link');
  });

  await test('V4: event detail with a location shows a Map link', async () => {
    await truncateTables();
    const id = await createEvent({ location: 'Blue Room' });
    const r = await get(`/events/${id}`);
    assert(r.body.includes('google.com/maps/search') && r.body.includes('Map ↗'), 'map link present');
  });

  await test('V6: static pages render and event detail links the refund policy', async () => {
    for (const [path, needle] of [['/about', 'About Flyte'], ['/contact', 'Contact'], ['/terms', 'Refund'], ['/privacy', 'Privacy']]) {
      const r = await get(path);
      assertEqual(r.status, 200, `${path} renders`);
      assert(r.body.includes(needle), `${path} has expected content`);
    }
    await truncateTables();
    const id = await createEvent({ status: 'OPEN' });
    const r = await get(`/events/${id}`);
    assert(r.body.includes('see policy') && r.body.includes('href="/terms"'), 'refund policy line links /terms');
  });

  // ── W6: guest-vs-logged-in checkout copy on the OPEN detail CTA ──
  await test('W6: guest sees "No account needed", logged-in user sees their email', async () => {
    await truncateTables();
    const id = await createEvent({ status: 'OPEN', availableSlots: 8 });
    const guest = await get(`/events/${id}`);
    assert(guest.body.includes('No account needed'), 'guest copy shown');
    assert(!guest.body.includes('checking out as yourself'), 'no logged-in copy for guest');

    const email = 'catalog-w6@example.com';
    await testSql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email=${email})`;
    await testSql`DELETE FROM users WHERE email=${email}`;
    const hash = await authService.hashPassword('pw');
    const u = await testSql`INSERT INTO users (email, password_hash, display_name, is_verified, account_status) VALUES (${email}, ${hash}, 'Wendy Six', TRUE, 'active') RETURNING id`;
    const userId = u[0].id as string;
    const { signedSid } = await createSession({ userId }, userId);
    const loggedIn = await get(`/events/${id}`, `sid=${signedSid}`);
    assert(loggedIn.body.includes('checking out as yourself'), 'logged-in copy shown');
    assert(loggedIn.body.includes(email), 'logged-in email shown');
    assert(!loggedIn.body.includes('No account needed — check out as a guest'), 'no guest copy for logged-in user');

    await testSql`DELETE FROM sessions WHERE user_id = ${userId}`;
    await testSql`DELETE FROM users WHERE id = ${userId}`;
  });

  // ── W7: logged-in registration form prefills First/Last from display_name ──
  await test('W7: register form prefills First/Last for a logged-in user', async () => {
    await truncateTables();
    const id = await createEvent({ status: 'OPEN', availableSlots: 8 });
    const email = 'catalog-w7@example.com';
    await testSql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email=${email})`;
    await testSql`DELETE FROM users WHERE email=${email}`;
    const hash = await authService.hashPassword('pw');
    const u = await testSql`INSERT INTO users (email, password_hash, display_name, is_verified, account_status) VALUES (${email}, ${hash}, 'Ada Grace Lovelace', TRUE, 'active') RETURNING id`;
    const userId = u[0].id as string;
    const { signedSid } = await createSession({ userId }, userId);

    const r = await get(`/events/${id}/register`, `sid=${signedSid}`);
    assertEqual(r.status, 200, 'register form renders');
    assert(r.body.includes('name="firstName" value="Ada"'), 'first name prefilled');
    assert(r.body.includes('name="lastName" value="Grace Lovelace"'), 'last name = remainder');

    // Guest sees empty name fields.
    const guest = await get(`/events/${id}/register`);
    assert(guest.body.includes('name="firstName" value=""'), 'guest first name empty');

    await testSql`DELETE FROM sessions WHERE user_id = ${userId}`;
    await testSql`DELETE FROM users WHERE id = ${userId}`;
  });

  // ── W9: month filter is a dropdown of YYYY-MM options ──
  await test('W9: /events month filter renders a select with YYYY-MM options', async () => {
    await truncateTables();
    await createEvent({ status: 'OPEN' });
    const r = await get('/events');
    assert(r.body.includes('<select class="form-select" id="month" name="month">'), 'month is a select');
    assert(r.body.includes('Any month'), 'has Any month option');
    assert(/<option value="\d{4}-\d{2}"/.test(r.body), 'YYYY-MM option values');
    assert(!r.body.includes('type="month"'), 'no native month input');

    // Selecting a month is preserved.
    const now = new Date();
    const val = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
    const r2 = await get(`/events?month=${val}`);
    assert(r2.body.includes(`value="${val}" selected`), 'selected month preserved');
  });

  // ── W10: Map link only for real physical locations ──
  await test('W10: Map link suppressed for vague/non-physical locations, kept for real ones', async () => {
    await truncateTables();
    const real = await createEvent({ location: '123 Main Street, Springfield' });
    const rReal = await get(`/events/${real}`);
    assert(rReal.body.includes('Map ↗'), 'real address keeps the map link');
    assert(rReal.body.includes('123 Main Street, Springfield'), 'location text shown');

    for (const loc of ['Online', 'Virtual event', 'TBD', 'Zoom', 'Remote']) {
      const id = await createEvent({ location: loc });
      const r = await get(`/events/${id}`);
      assert(r.body.includes(loc), `${loc}: location text kept`);
      assert(!r.body.includes('Map ↗'), `${loc}: no map link`);
    }
  });

  // ── W22: og:type=event + static brand-card fallback for image-less events ──
  await test('W22: image-less event falls back to the brand OG card; og:type is event', async () => {
    await truncateTables();
    const withImage = await createEvent({ name: 'Has Art', imageUrl: 'https://example.com/p.jpg' });
    const rA = await get(`/events/${withImage}`);
    assert(rA.body.includes('property="og:type" content="event"'), 'og:type=event');
    assert(rA.body.includes('content="https://example.com/p.jpg"'), 'real image used when present');
    assert(rA.body.includes('twitter:card" content="summary_large_image"'), 'large card for real art');

    const noImage = await createEvent({ name: 'No Art', imageUrl: null });
    const rB = await get(`/events/${noImage}`);
    assert(rB.body.includes('/public/og-default.svg'), 'brand-card fallback image');
    assert(rB.body.includes('twitter:card" content="summary"') && !rB.body.includes('summary_large_image'),
      'fallback stays a summary card (SVG not rendered large by Twitter)');
  });

  // ── W18: storefront view counter (per-day upsert; ranged + per-event reads) ──
  await test('W18: recordEventView increments a per-day counter that the reads sum', async () => {
    await truncateTables();
    const { analyticsService } = await import('../../services/analytics-service.js');
    const id = await createEvent({ status: 'OPEN' });
    const other = await createEvent({ status: 'OPEN' });
    await analyticsService.recordEventView(id);
    await analyticsService.recordEventView(id);
    await analyticsService.recordEventView(other);

    assertEqual(await analyticsService.viewsByEvent(id), 2, 'per-event total counts both views');
    assertEqual(await analyticsService.viewsByEvent(other), 1, 'other event isolated');
    assertEqual(await analyticsService.viewsInRange(7), 3, 'range sum spans all events');

    // Upsert collapses same-day views into one row.
    const rows = await testSql`SELECT views FROM page_views WHERE event_id = ${id}::UUID`;
    assertEqual(rows.length, 1, 'one counter row per event per day');
    assertEqual(rows[0].views, 2, 'row holds the running count');
  });

  await truncateTables();
  console.log(`\n=== Catalog: ${passed} passed, ${failed} failed ===`);
  await testSql.end();
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
