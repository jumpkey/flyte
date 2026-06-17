/**
 * Demo data seeder — site-wide scale (run: npm run seed:demo).
 *
 * Populates every UI surface the I1–I10 build exposes with realistic, time-spread
 * data: a mix of active/shadow/locked users + an admin; events in all lifecycle
 * states across past and future dates; registrations in every payment state with
 * confirmations spread over weeks (so booking curves, daily-revenue, velocity and
 * the funnel all look real); waitlists; refunds (refund_log) + refund requests in
 * all states; and login + action history so the activity feed and user-detail
 * pages have something to show.
 *
 * Idempotent: clears its own demo data (events + registration tables are
 * truncated; users tagged @demo.flyte.test are removed) and reseeds. The seed
 * admin and any non-demo users are preserved. Refuses to run in NODE_ENV=production
 * unless SEED_DEMO_FORCE=1 (this writes a lot of data).
 */
import 'dotenv/config';
import postgres from 'postgres';
import bcrypt from 'bcryptjs';

const sql = postgres(process.env.DATABASE_URL ?? 'postgres://flyte:flyte@localhost:5432/flyte', { onnotice: () => {} });

const DEMO_DOMAIN = 'demo.flyte.test';
const DEMO_PASSWORD = 'demo1234';
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

// ── helpers ────────────────────────────────────────────────────────────────
const rnd = (min: number, max: number) => min + Math.random() * (max - min);
const rndInt = (min: number, max: number) => Math.floor(rnd(min, max + 1));
const pick = <T>(a: T[]) => a[rndInt(0, a.length - 1)];
const chance = (p: number) => Math.random() < p;
const daysAgo = (n: number) => new Date(NOW - n * DAY);
const inDays = (n: number) => new Date(NOW + n * DAY);
const between = (a: Date, b: Date) => new Date(a.getTime() + Math.random() * (b.getTime() - a.getTime()));
function shuffle<T>(arr: T[]): T[] { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = rndInt(0, i); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const fee = (gross: number) => Math.max(0, gross - Math.round(gross * 0.029) - (gross > 0 ? 30 : 0)); // Stripe-style net
const ip = () => `203.0.113.${rndInt(1, 254)}`;

const FIRST = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Frank', 'Grace', 'Heidi', 'Ivan', 'Judy', 'Mallory', 'Niaj', 'Olivia', 'Peggy', 'Rupert', 'Sybil', 'Trent', 'Uma', 'Victor', 'Wendy', 'Xavier', 'Yara', 'Zane', 'Nina', 'Omar', 'Priya', 'Quinn', 'Rosa', 'Sam', 'Tariq', 'Ursula', 'Vikram', 'Willa', 'Yusuf', 'Zoë', 'Aditi', 'Bruno', 'Chloe', 'Diego', 'Esme'];
const LAST = ['Adams', 'Brooks', 'Chen', 'Diaz', 'Evans', 'Ford', 'Gomez', 'Huang', 'Ibarra', 'Jones', 'Khan', 'Lopez', 'Mehta', 'Novak', 'Okafor', 'Park', 'Quinn', 'Rossi', 'Singh', 'Tanaka', 'Ueda', 'Voss', 'Walsh', 'Xu', 'Yates', 'Zito'];

let piCounter = 1000;
const nextPi = () => `pi_demo_${piCounter++}`;
let reCounter = 5000;
const nextRe = () => `re_demo_${reCounter++}`;

interface Person { id: string; email: string; first: string; last: string; status: 'active' | 'shadow'; locked: boolean; admin: boolean; }

async function main() {
  if (process.env.NODE_ENV === 'production' && process.env.SEED_DEMO_FORCE !== '1') {
    throw new Error('Refusing to seed demo data in production. Set SEED_DEMO_FORCE=1 to override.');
  }
  console.log(`Seeding demo data → ${(process.env.DATABASE_URL ?? 'localhost').replace(/:[^:@/]+@/, ':***@')}\n`);

  // ── clean prior demo data ─────────────────────────────────────────────────
  await sql`TRUNCATE TABLE refund_requests, refund_log, waitlist_entries, registrations, events RESTART IDENTITY CASCADE`;
  const demoIds = (await sql`SELECT id FROM users WHERE email LIKE ${'%@' + DEMO_DOMAIN}`).map((r) => r.id as string);
  if (demoIds.length) {
    await sql`DELETE FROM login_events WHERE user_id = ANY(${demoIds})`;
    await sql`DELETE FROM user_action_events WHERE user_id = ANY(${demoIds})`;
    await sql`DELETE FROM sessions WHERE user_id = ANY(${demoIds})`;
    await sql`DELETE FROM users WHERE id = ANY(${demoIds})`;
  }
  // also clear audit rows from a prior admin demo run so the activity feed is fresh
  await sql`DELETE FROM user_action_events WHERE action IN ('event_status_changed','event_capacity_changed','refund_issued','refund_request_approved','refund_request_denied','user_locked','user_unlocked') AND created_at > now() - interval '120 days'`;

  // ── admin ─────────────────────────────────────────────────────────────────
  const adminHash = await bcrypt.hash('admin1234', 12);
  const adminRows = await sql`
    INSERT INTO users (email, display_name, password_hash, is_verified, is_admin, account_status, created_at, last_login_at)
    VALUES (${'admin@' + DEMO_DOMAIN}, 'Demo Admin', ${adminHash}, TRUE, TRUE, 'active', ${daysAgo(120)}, ${daysAgo(0)})
    RETURNING id`;
  const adminId = adminRows[0].id as string;

  // ── people pool ───────────────────────────────────────────────────────────
  const people: Person[] = [];
  const usedEmails = new Set<string>();
  const POOL = 80;
  const activeHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  for (let i = 0; i < POOL; i++) {
    const first = FIRST[i % FIRST.length];
    const last = LAST[(i * 7) % LAST.length];
    let email = `${first.toLowerCase()}.${last.toLowerCase()}@${DEMO_DOMAIN}`;
    let n = 1; while (usedEmails.has(email)) email = `${first.toLowerCase()}.${last.toLowerCase()}${n++}@${DEMO_DOMAIN}`;
    usedEmails.add(email);
    // First 9 are the "named" set; index 8 is the locked user. ~60% of the rest active.
    const isNamed = i < 8;
    const locked = i === 8;
    const status: 'active' | 'shadow' = isNamed || locked ? 'active' : (chance(0.6) ? 'active' : 'shadow');
    const rows = await sql`
      INSERT INTO users (email, display_name, password_hash, is_verified, is_admin, is_locked, account_status, failed_login_count, created_at, last_login_at)
      VALUES (${email}, ${first + ' ' + last}, ${status === 'active' ? activeHash : null}, ${status === 'active'}, FALSE, ${locked},
              ${status}, ${locked ? 5 : 0}, ${daysAgo(rndInt(20, 110))}, ${status === 'active' && !locked && chance(0.8) ? daysAgo(rndInt(0, 20)) : null})
      RETURNING id`;
    people.push({ id: rows[0].id as string, email, first, last, status, locked, admin: false });
  }

  // ── events ────────────────────────────────────────────────────────────────
  interface EventCfg {
    name: string; location: string; fee: number; capacity: number; status: string;
    openedDaysAgo: number; eventInDays: number; confirmed: number; waitlist?: number;
    refunds?: number; imageUrl?: string | null; description?: string;
  }
  const EVENTS: EventCfg[] = [
    { name: 'Indie Film Night', location: 'The Rialto, Downtown', fee: 1800, capacity: 50, status: 'CLOSED', openedDaysAgo: 60, eventInDays: -30, confirmed: 42, refunds: 3 },
    { name: 'Summer Jazz in the Park', location: 'Riverside Bandshell', fee: 0, capacity: 40, status: 'CANCELLED', openedDaysAgo: 40, eventInDays: 10, confirmed: 28, refunds: 28 },
    { name: 'Hands-on Pottery Workshop', location: 'Clay Studio 12', fee: 6500, capacity: 30, status: 'OPEN', openedDaysAgo: 25, eventInDays: 20, confirmed: 22 },
    { name: 'Startup Pitch Night', location: 'Innovation Hub', fee: 2500, capacity: 60, status: 'OPEN', openedDaysAgo: 30, eventInDays: 5, confirmed: 16 },
    { name: 'Sourdough Masterclass', location: 'The Flour Mill', fee: 8900, capacity: 12, status: 'FULL', openedDaysAgo: 20, eventInDays: 12, confirmed: 12, waitlist: 8 },
    { name: '5K Charity Fun Run', location: 'Lakeside Trail', fee: 3500, capacity: 60, status: 'OPEN', openedDaysAgo: 35, eventInDays: 8, confirmed: 55 },
    { name: 'Natural Wine Tasting', location: 'Cellar 9', fee: 4500, capacity: 40, status: 'OPEN', openedDaysAgo: 1, eventInDays: 30, confirmed: 3 },
    { name: 'Coding Bootcamp Info Session', location: 'Online', fee: 0, capacity: 50, status: 'CLOSED', openedDaysAgo: 15, eventInDays: 7, confirmed: 31 },
    { name: 'New Year Holiday Gala', location: 'The Grand Ballroom', fee: 12000, capacity: 150, status: 'DRAFT', openedDaysAgo: 0, eventInDays: 60, confirmed: 0 },
    { name: 'Farmers Market Walking Tour', location: 'Old Town Square', fee: 1500, capacity: 20, status: 'FULL', openedDaysAgo: 18, eventInDays: 14, confirmed: 20, waitlist: 5 },
    { name: 'Golden Hour Photography Walk', location: 'Botanical Gardens', fee: 3000, capacity: 25, status: 'OPEN', openedDaysAgo: 10, eventInDays: 25, confirmed: 10, imageUrl: 'https://images.example.com/photo-walk.jpg' },
    { name: 'Open Mic Night', location: 'The Back Room', fee: 1000, capacity: 30, status: 'CLOSED', openedDaysAgo: 50, eventInDays: -5, confirmed: 24 },
  ];

  for (const cfg of EVENTS) {
    const openedAt = cfg.openedDaysAgo > 0 ? daysAgo(cfg.openedDaysAgo) : null;
    const eventDate = inDays(cfg.eventInDays);
    const createdAt = openedAt ? new Date(openedAt.getTime() - DAY) : daysAgo(2);
    const available = Math.max(0, cfg.capacity - cfg.confirmed);
    const evRows = await sql`
      INSERT INTO events (name, description, event_date, location, total_capacity, confirmed_count, available_slots,
                          registration_fee_cents, status, image_url, waitlist_enabled, opened_at, created_at)
      VALUES (${cfg.name}, ${cfg.description ?? sampleDescription(cfg.name)}, ${eventDate}, ${cfg.location},
              ${cfg.capacity}, ${cfg.confirmed}, ${available}, ${cfg.fee}, ${cfg.status}, ${cfg.imageUrl ?? null},
              ${chance(0.8)}, ${openedAt}, ${createdAt})
      RETURNING event_id`;
    const eventId = evRows[0].event_id as string;
    if (cfg.confirmed === 0) continue;

    const curveEnd = new Date(Math.min(NOW, eventDate.getTime()));
    const curveStart = openedAt ?? createdAt;
    const isCancelledEvent = cfg.status === 'CANCELLED';
    const attendees = shuffle(people).slice(0, cfg.confirmed);

    // CONFIRMED (or CANCELLED-via-event-cancel) registrations spread across the curve.
    for (const person of attendees) {
      const confirmedAt = between(curveStart, curveEnd);
      const createdRegAt = new Date(confirmedAt.getTime() - rndInt(2, 90) * 60 * 1000);
      const gross = cfg.fee;
      const refunded = isCancelledEvent ? fee(gross) : 0;
      const status = isCancelledEvent ? 'CANCELLED' : 'CONFIRMED';
      const rid = await insertReg({
        eventId, person, gross, status,
        createdAt: createdRegAt, confirmedAt,
        cancelledAt: isCancelledEvent ? between(confirmedAt, curveEnd) : null,
        refunded, stripeRefundId: isCancelledEvent ? nextRe() : null,
      });
      if (isCancelledEvent) {
        await sql`INSERT INTO refund_log (registration_id, event_id, stripe_refund_id, refund_type, amount_cents, reason, created_at)
                  VALUES (${rid}, ${eventId}, ${nextRe()}, 'FULL', ${Math.max(refunded, 1)}, 'event_cancelled', ${between(confirmedAt, curveEnd)})`;
      }
    }

    // Individual refunds (full + partial) on a few CONFIRMED-then-refunded rows (don't affect counters).
    const refundCount = cfg.refunds && !isCancelledEvent ? cfg.refunds : 0;
    for (let i = 0; i < refundCount; i++) {
      const person = pick(people);
      const confirmedAt = between(curveStart, curveEnd);
      const gross = cfg.fee;
      const partial = chance(0.4) && gross > 0;
      const refunded = partial ? Math.round(fee(gross) * rnd(0.3, 0.6)) : fee(gross);
      const rid = await insertReg({
        eventId, person, gross, status: 'CANCELLED',
        createdAt: new Date(confirmedAt.getTime() - 30 * 60 * 1000), confirmedAt,
        cancelledAt: between(confirmedAt, curveEnd), refunded: Math.max(refunded, partial ? 1 : 0),
        stripeRefundId: nextRe(), email: `refunded+${piCounter}@${DEMO_DOMAIN}`,
      });
      await sql`INSERT INTO refund_log (registration_id, event_id, stripe_refund_id, refund_type, amount_cents, reason, created_at)
                VALUES (${rid}, ${eventId}, ${nextRe()}, ${partial ? 'PARTIAL' : 'FULL'}, ${Math.max(refunded, 1)}, ${partial ? 'partial_goodwill' : 'admin_initiated'}, ${between(confirmedAt, curveEnd)})`;
    }

    // Abandoned / failed checkouts (funnel realism) — terminal states, NULL user.
    if (!isCancelledEvent && cfg.status !== 'CLOSED' && cfg.fee > 0) {
      for (const st of ['PENDING_PAYMENT', 'PAYMENT_FAILED', 'EXPIRED']) {
        if (chance(0.85)) {
          const t = between(curveStart, curveEnd);
          await insertReg({
            eventId, person: null, gross: cfg.fee, status: st,
            createdAt: t, confirmedAt: null, cancelledAt: null, refunded: 0, stripeRefundId: null,
            email: `guest+${piCounter}@${DEMO_DOMAIN}`,
          });
        }
      }
    }

    // Waitlist for FULL events.
    if (cfg.waitlist) {
      const wlPeople = shuffle(people).slice(0, cfg.waitlist);
      let order = 0;
      for (const person of wlPeople) {
        await sql`INSERT INTO waitlist_entries (event_id, user_id, email, first_name, last_name, created_at)
                  VALUES (${eventId}, ${person.id}, ${person.email}, ${person.first}, ${person.last}, ${between(curveStart, curveEnd)})
                  ON CONFLICT (event_id, email) DO NOTHING`;
        order++;
      }
    }
  }

  // ── refund requests (all states) — chosen post-hoc so each queue tab populates ──
  const openTargets = await sql`
    SELECT r.registration_id FROM registrations r JOIN events e ON e.event_id = r.event_id
    WHERE r.status='CONFIRMED' AND e.status='OPEN' ORDER BY random() LIMIT 3`;
  for (const t of openTargets) {
    await sql`INSERT INTO refund_requests (registration_id, reason, status, requested_at)
              VALUES (${t.registration_id}, ${pick(['Schedule conflict came up', 'Can no longer attend', 'Bought the wrong date', 'Family emergency'])}, 'REQUESTED', ${daysAgo(rndInt(1, 6))})`;
  }
  const approvedTargets = await sql`
    SELECT registration_id FROM registrations WHERE status='CANCELLED' AND refunded_amount_cents > 0 ORDER BY random() LIMIT 2`;
  for (const t of approvedTargets) {
    await sql`INSERT INTO refund_requests (registration_id, reason, status, requested_at, resolved_at, resolved_by, resolution_note)
              VALUES (${t.registration_id}, 'Could not make it', 'APPROVED', ${daysAgo(rndInt(8, 20))}, ${daysAgo(rndInt(2, 7))}, ${adminId}, 'Approved — refund issued')`;
  }
  const deniedTarget = await sql`
    SELECT r.registration_id FROM registrations r JOIN events e ON e.event_id = r.event_id
    WHERE r.status='CONFIRMED' AND r.registration_id NOT IN (SELECT registration_id FROM refund_requests)
    ORDER BY random() LIMIT 1`;
  if (deniedTarget.length) {
    await sql`INSERT INTO refund_requests (registration_id, reason, status, requested_at, resolved_at, resolved_by, resolution_note)
              VALUES (${deniedTarget[0].registration_id}, 'Changed my mind', 'DENIED', ${daysAgo(9)}, ${daysAgo(7)}, ${adminId}, 'Outside the refund window — the event had already taken place.')`;
  }

  // ── login + action history ─────────────────────────────────────────────────
  const loggables = people.filter((p) => p.status === 'active').slice(0, 18);
  for (const p of loggables) {
    const sessions = rndInt(2, 9);
    for (let i = 0; i < sessions; i++) {
      const at = daysAgo(rndInt(0, 45));
      await sql`INSERT INTO login_events (user_id, email_attempted, success, ip_address, user_agent, created_at)
                VALUES (${p.id}, ${p.email}, ${!p.locked}, ${ip()}, 'Mozilla/5.0 (demo)', ${at})`;
      if (chance(0.2)) {
        await sql`INSERT INTO login_events (user_id, email_attempted, success, failure_reason, ip_address, user_agent, created_at)
                  VALUES (${p.id}, ${p.email}, FALSE, 'invalid_password', ${ip()}, 'Mozilla/5.0 (demo)', ${new Date(at.getTime() - 60000)})`;
      }
    }
  }
  // the locked user's failed-login burst that led to the lock
  const locked = people.find((p) => p.locked);
  if (locked) {
    for (let i = 0; i < 6; i++) {
      await sql`INSERT INTO login_events (user_id, email_attempted, success, failure_reason, ip_address, created_at)
                VALUES (${locked.id}, ${locked.email}, FALSE, 'invalid_password', ${ip()}, ${daysAgo(rndInt(10, 14))})`;
    }
  }
  // a sprinkle of anonymous failed attempts (user enumeration probes)
  for (let i = 0; i < 6; i++) {
    await sql`INSERT INTO login_events (email_attempted, success, failure_reason, ip_address, created_at)
              VALUES (${'noone' + i + '@' + DEMO_DOMAIN}, FALSE, 'user_not_found', ${ip()}, ${daysAgo(rndInt(0, 30))})`;
  }
  // user action events: registrations, verifications, password resets
  for (const p of people.slice(0, 35)) {
    await sql`INSERT INTO user_action_events (user_id, action, resource, ip_address, created_at)
              VALUES (${p.id}, 'registration', '/register', ${ip()}, ${daysAgo(rndInt(20, 100))})`;
    if (p.status === 'active' && chance(0.7)) {
      await sql`INSERT INTO user_action_events (user_id, action, resource, ip_address, created_at)
                VALUES (${p.id}, 'email_verified', '/verify-email', ${ip()}, ${daysAgo(rndInt(15, 95))})`;
    }
    if (p.status === 'active' && chance(0.25)) {
      await sql`INSERT INTO user_action_events (user_id, action, resource, ip_address, created_at)
                VALUES (${p.id}, 'password_reset_completed', '/reset-password', ${ip()}, ${daysAgo(rndInt(1, 40))})`;
    }
  }
  // admin actions → activity feed shows operational history
  const adminActions: Array<[string, Record<string, unknown>]> = [
    ['event_status_changed', { from: 'DRAFT', to: 'OPEN' }],
    ['event_status_changed', { from: 'OPEN', to: 'CLOSED' }],
    ['event_capacity_changed', { from: 40, to: 60 }],
    ['refund_issued', { amountCents: 2400, type: 'FULL' }],
    ['refund_issued', { amountCents: 1200, type: 'PARTIAL' }],
    ['refund_request_approved', {}],
    ['refund_request_denied', {}],
    ['user_locked', {}],
  ];
  for (const [action, meta] of adminActions) {
    await sql`INSERT INTO user_action_events (user_id, action, resource, metadata, ip_address, created_at)
              VALUES (${adminId}, ${action}, '/admin', ${sql.json(meta as never)}, ${ip()}, ${daysAgo(rndInt(0, 25))})`;
  }

  // ── summary ─────────────────────────────────────────────────────────────────
  const counts = await sql`SELECT
    (SELECT count(*) FROM users WHERE email LIKE ${'%@' + DEMO_DOMAIN}) AS users,
    (SELECT count(*) FROM events) AS events,
    (SELECT count(*) FROM registrations) AS registrations,
    (SELECT count(*) FROM registrations WHERE status='CONFIRMED') AS confirmed,
    (SELECT count(*) FROM waitlist_entries) AS waitlist,
    (SELECT count(*) FROM refund_log) AS refunds,
    (SELECT count(*) FROM refund_requests) AS refund_requests,
    (SELECT count(*) FROM login_events) AS logins,
    (SELECT count(*) FROM user_action_events) AS actions`;
  const c = counts[0];
  const namedActive = people.filter((p) => p.status === 'active' && !p.locked).slice(0, 4);

  console.log('Demo data seeded:\n');
  console.table({ users: +c.users, events: +c.events, registrations: +c.registrations, confirmed: +c.confirmed, waitlist: +c.waitlist, refunds: +c.refunds, refund_requests: +c.refund_requests, login_events: +c.logins, action_events: +c.actions });
  console.log('\nLog in as:');
  console.log(`  ADMIN     admin@${DEMO_DOMAIN} / admin1234   → /admin (dashboard, events, transactions, refunds, users, activity, analytics)`);
  for (const p of namedActive) console.log(`  customer  ${p.email} / ${DEMO_PASSWORD}   → /dashboard, /account/registrations`);
  console.log(`  locked    ${locked?.email} (cannot log in — shows in /admin/users with the locked filter)`);
  console.log('\nWorth a look: /events (catalog) · /events?when=past · /admin/analytics · /admin/refund-requests · /admin/activity');

  await sql.end();
}

interface InsertRegOpts {
  eventId: string; person: Person | null; gross: number; status: string;
  createdAt: Date; confirmedAt: Date | null; cancelledAt: Date | null;
  refunded: number; stripeRefundId: string | null; email?: string;
}
async function insertReg(o: InsertRegOpts): Promise<string> {
  const email = o.email ?? o.person?.email ?? `guest+${piCounter}@${DEMO_DOMAIN}`;
  const first = o.person?.first ?? 'Guest';
  const last = o.person?.last ?? 'Attendee';
  const net = o.status === 'CONFIRMED' || o.status === 'CANCELLED' ? fee(o.gross) : null;
  const rows = await sql`
    INSERT INTO registrations (event_id, user_id, email, first_name, last_name, phone, gross_amount_cents,
                              net_amount_cents, refunded_amount_cents, stripe_refund_id, payment_intent_id,
                              status, created_at, confirmed_at, cancelled_at, confirmation_email_sent_at)
    VALUES (${o.eventId}, ${o.person?.id ?? null}, ${email}, ${first}, ${last}, ${chance(0.4) ? '555-' + rndInt(1000, 9999) : null},
            ${o.gross}, ${net}, ${o.refunded}, ${o.stripeRefundId}, ${nextPi()}, ${o.status},
            ${o.createdAt}, ${o.confirmedAt}, ${o.cancelledAt}, ${o.confirmedAt})
    RETURNING registration_id`;
  return rows[0].registration_id as string;
}

function sampleDescription(name: string): string {
  return `Join us for ${name}. A great evening out — secure your spot in a couple of minutes, no account needed. Refundable any time before the event.`;
}

main().catch((err) => { console.error('Demo seed failed:', err); process.exit(1); });
