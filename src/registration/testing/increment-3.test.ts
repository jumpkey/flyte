import 'dotenv/config';
import { truncateTables, createTestEvent, testSql, TEST_EVENT_ID, assert, assertEqual } from './test-helpers.js';
import { EventAvailabilityService } from '../services/EventAvailabilityService.js';

async function runTests() {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => Promise<void>) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}:`, e instanceof Error ? e.message : e); failed++; }
  }

  console.log('\n=== Increment 3: EventAvailabilityService Tests ===\n');

  await truncateTables();
  await createTestEvent({ totalCapacity: 10, availableSlots: 7, confirmedCount: 3 });

  const svc = new EventAvailabilityService();

  await test('getAvailability returns correct data', async () => {
    const avail = await svc.getAvailability(TEST_EVENT_ID);
    assert(avail !== null, 'should return availability');
    assertEqual(avail!.eventId, TEST_EVENT_ID, 'eventId');
    assertEqual(avail!.totalCapacity, 10, 'totalCapacity');
    assertEqual(avail!.confirmedCount, 3, 'confirmedCount');
    assertEqual(avail!.availableSlots, 7, 'availableSlots');
    assertEqual(avail!.waitlistCount, 0, 'waitlistCount');
    assertEqual(avail!.status, 'OPEN', 'status');
  });

  await test('getAvailability returns null for nonexistent event', async () => {
    const avail = await svc.getAvailability('00000000-0000-0000-0000-000000000099');
    assertEqual(avail, null, 'should return null');
  });

  await test('getAvailability includes waitlist count', async () => {
    await testSql.unsafe(`
      INSERT INTO waitlist_entries (event_id, email, first_name, last_name)
      VALUES ('${TEST_EVENT_ID}', 'w1@example.com', 'W', 'One'),
             ('${TEST_EVENT_ID}', 'w2@example.com', 'W', 'Two')
    `);
    const avail = await svc.getAvailability(TEST_EVENT_ID);
    assertEqual(avail!.waitlistCount, 2, 'waitlistCount should be 2');
  });

  await testSql.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
