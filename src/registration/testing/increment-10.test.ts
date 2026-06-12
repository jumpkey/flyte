import 'dotenv/config';
import { truncateTables, createTestEvent, testSql, TEST_EVENT_ID, assert, assertEqual } from './test-helpers.js';
import { WaitlistService } from '../services/WaitlistService.js';

async function runTests() {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => Promise<void>) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}:`, e instanceof Error ? e.message : e); failed++; }
  }

  console.log('\n=== Increment 10: WaitlistService Tests ===\n');

  await truncateTables();
  await createTestEvent();

  const svc = new WaitlistService();

  await test('10-1: addToWaitlist adds entry', async () => {
    const entry = await svc.addToWaitlist({ eventId: TEST_EVENT_ID, email: 'w1@example.com', firstName: 'W', lastName: 'One' });
    assert(entry.waitlistEntryId != null, 'waitlistEntryId set');
    assertEqual(entry.email, 'w1@example.com', 'email');
    assertEqual(entry.eventId, TEST_EVENT_ID, 'eventId');
  });

  await test('10-2: addToWaitlist is idempotent for same email+event', async () => {
    const e1 = await svc.addToWaitlist({ eventId: TEST_EVENT_ID, email: 'w1@example.com', firstName: 'W', lastName: 'One' });
    const e2 = await svc.addToWaitlist({ eventId: TEST_EVENT_ID, email: 'w1@example.com', firstName: 'W', lastName: 'One' });
    assertEqual(e1.waitlistEntryId, e2.waitlistEntryId, 'same entry returned');
  });

  await test('10-3: getWaitlistPosition returns correct position', async () => {
    await svc.addToWaitlist({ eventId: TEST_EVENT_ID, email: 'w2@example.com', firstName: 'W', lastName: 'Two' });
    await svc.addToWaitlist({ eventId: TEST_EVENT_ID, email: 'w3@example.com', firstName: 'W', lastName: 'Three' });

    const pos1 = await svc.getWaitlistPosition(TEST_EVENT_ID, 'w1@example.com');
    assert(pos1 !== null && pos1 >= 1, 'position is valid');

    const pos2 = await svc.getWaitlistPosition(TEST_EVENT_ID, 'w2@example.com');
    assert(pos2 !== null && pos2 > pos1!, 'w2 is after w1');
  });

  await test('10-4: removeFromWaitlist removes entry', async () => {
    const entry = await svc.addToWaitlist({ eventId: TEST_EVENT_ID, email: 'wdel@example.com', firstName: 'Del', lastName: 'Me' });
    const removed = await svc.removeFromWaitlist(entry.waitlistEntryId);
    assert(removed, 'removal returned true');

    const pos = await svc.getWaitlistPosition(TEST_EVENT_ID, 'wdel@example.com');
    assertEqual(pos, null, 'entry no longer found');
  });

  await testSql.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
