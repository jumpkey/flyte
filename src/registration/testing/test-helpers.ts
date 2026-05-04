import 'dotenv/config';
import postgres from 'postgres';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://flyte:flyte@localhost:5432/flyte';

export const testSql = postgres(TEST_DB_URL, { max: 5, idle_timeout: 10 });

export const TEST_EVENT_ID = '00000000-0000-0000-0000-000000000001';

export async function truncateTables(): Promise<void> {
  await testSql.unsafe(`
    TRUNCATE TABLE refund_log, waitlist_entries, registrations, events RESTART IDENTITY CASCADE
  `);
}

export async function createTestEvent(overrides: {
  eventId?: string;
  name?: string;
  totalCapacity?: number;
  registrationFeeCents?: number;
  availableSlots?: number;
  confirmedCount?: number;
} = {}): Promise<string> {
  const {
    eventId = TEST_EVENT_ID,
    name = 'Test Mahjong Tournament',
    totalCapacity = 10,
    registrationFeeCents = 10000,
    availableSlots = totalCapacity,
    confirmedCount = 0,
  } = overrides;

  await testSql.unsafe(`
    INSERT INTO events (event_id, name, event_date, total_capacity, confirmed_count, available_slots, registration_fee_cents)
    VALUES ('${eventId}', '${name}', now() + interval '30 days', ${totalCapacity}, ${confirmedCount}, ${availableSlots}, ${registrationFeeCents})
    ON CONFLICT (event_id) DO UPDATE SET
      total_capacity = EXCLUDED.total_capacity,
      confirmed_count = EXCLUDED.confirmed_count,
      available_slots = EXCLUDED.available_slots,
      registration_fee_cents = EXCLUDED.registration_fee_cents
  `);

  return eventId;
}

export function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
