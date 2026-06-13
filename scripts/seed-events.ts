import 'dotenv/config';
import postgres from 'postgres';

// Pilot harness (Document 7 §3): seeds four events shaped for the Stripe
// test protocol. Idempotent — re-running updates nothing; events are keyed
// by name and skipped if present.
const sql = postgres(process.env.DATABASE_URL ?? 'postgres://flyte:flyte@localhost:5432/flyte');

const DAY = 24 * 60 * 60 * 1000;

const events = [
  {
    name: 'Live-Mode Smoke Test',
    description: 'One-dollar event for the live-mode proof (protocol row 8). Buy it with a real card, then refund it.',
    days: 30, location: 'The Internet', capacity: 100, fee: 100, status: 'OPEN',
  },
  {
    name: 'Intro to Sailing',
    description: 'Learn the ropes — literally. A relaxed morning on the water for complete beginners; all gear provided.',
    days: 14, location: 'Marina Bay, Dock C', capacity: 50, fee: 2500, status: 'OPEN',
  },
  {
    name: 'Founders Dinner',
    description: 'Nearly sold out: exactly one slot, for testing the sold-out flip and the waitlist path mid-protocol.',
    days: 21, location: 'The Press Room', capacity: 1, fee: 8000, status: 'OPEN',
  },
  {
    name: 'Spring Gala',
    description: 'CLOSED event — verifies closed-state rendering and that registration is refused.',
    days: 45, location: 'Grand Hall', capacity: 180, fee: 12000, status: 'CLOSED',
  },
];

async function seed() {
  for (const ev of events) {
    const existing = await sql`SELECT event_id FROM events WHERE name = ${ev.name}`;
    if (existing.length > 0) {
      console.log(`= exists   ${ev.name} (${existing[0]!['event_id']})`);
      continue;
    }
    const rows = await sql`
      INSERT INTO events (name, description, event_date, location,
                          total_capacity, confirmed_count, available_slots,
                          registration_fee_cents, status)
      VALUES (${ev.name}, ${ev.description}, ${new Date(Date.now() + ev.days * DAY)},
              ${ev.location}, ${ev.capacity}, 0, ${ev.capacity}, ${ev.fee}, ${ev.status})
      RETURNING event_id
    `;
    console.log(`+ created  ${ev.name} ($${(ev.fee / 100).toFixed(2)}, cap ${ev.capacity}, ${ev.status}) → ${rows[0]!['event_id']}`);
  }
  await sql.end();
}

seed().catch((err) => { console.error(err); process.exit(1); });
