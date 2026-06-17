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

  await truncateTables();
  console.log(`\n=== Catalog: ${passed} passed, ${failed} failed ===`);
  await testSql.end();
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
