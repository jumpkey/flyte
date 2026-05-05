import 'dotenv/config';
import { truncateTables, createTestEvent, testSql, TEST_EVENT_ID, assert, assertEqual } from './test-helpers.js';

async function runTests() {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => Promise<void>) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}:`, e instanceof Error ? e.message : e); failed++; }
  }

  console.log('\n=== Increment 1: DB Schema Tests ===\n');

  await truncateTables();
  await createTestEvent({ totalCapacity: 5 });

  await test('capacity_invariant rejects invalid insert', async () => {
    try {
      await testSql.unsafe(`
        INSERT INTO events (event_id, name, event_date, total_capacity, confirmed_count, available_slots, registration_fee_cents)
        VALUES ('00000000-0000-0000-0000-000000000099', 'Bad Event', now() + interval '1 day', 10, 3, 5, 1000)
      `);
      assert(false, 'Should have thrown capacity_invariant violation');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      assert(msg.includes('capacity_invariant'), `Expected capacity_invariant error, got: ${msg}`);
    }
  });

  await test('sp_initiate_registration happy path', async () => {
    const rows = await testSql.unsafe(`
      SELECT * FROM sp_initiate_registration(
        '${TEST_EVENT_ID}'::UUID,
        'alice@example.com',
        'Alice',
        'Smith',
        NULL,
        '{}'::JSONB,
        10000,
        'pi_test_001'
      )
    `);
    assertEqual(rows[0].result_code, 'SUCCESS', 'result_code');
    assert(rows[0].registration_id != null, 'registration_id should be set');
  });

  await test('sp_initiate_registration duplicate check', async () => {
    const rows = await testSql.unsafe(`
      SELECT * FROM sp_initiate_registration(
        '${TEST_EVENT_ID}'::UUID,
        'alice@example.com',
        'Alice',
        'Smith',
        NULL,
        '{}'::JSONB,
        10000,
        'pi_test_002'
      )
    `);
    assertEqual(rows[0].result_code, 'ALREADY_REGISTERED', 'result_code');
  });

  await test('sp_initiate_registration event not found', async () => {
    const rows = await testSql.unsafe(`
      SELECT * FROM sp_initiate_registration(
        '00000000-0000-0000-0000-000000000099'::UUID,
        'bob@example.com',
        'Bob',
        'Jones',
        NULL,
        '{}'::JSONB,
        10000,
        'pi_test_003'
      )
    `);
    assertEqual(rows[0].result_code, 'EVENT_NOT_FOUND', 'result_code');
  });

  await test('sp_acquire_slot_and_stage_capture happy path', async () => {
    const rows = await testSql.unsafe(`
      SELECT * FROM sp_acquire_slot_and_stage_capture('pi_test_001')
    `);
    assertEqual(rows[0].result_code, 'SLOT_ACQUIRED', 'result_code');
    assert(rows[0].registration_id != null, 'registration_id should be set');

    // Verify event counts updated
    const eventRows = await testSql.unsafe(`SELECT * FROM events WHERE event_id = '${TEST_EVENT_ID}'`);
    assertEqual(eventRows[0].available_slots, 4, 'available_slots decremented');
    assertEqual(eventRows[0].confirmed_count, 1, 'confirmed_count incremented');
  });

  await test('sp_acquire_slot_and_stage_capture idempotent replay', async () => {
    const rows = await testSql.unsafe(`
      SELECT * FROM sp_acquire_slot_and_stage_capture('pi_test_001')
    `);
    assertEqual(rows[0].result_code, 'IDEMPOTENT_REPLAY', 'result_code');
  });

  await test('sp_finalize_registration success', async () => {
    const rows = await testSql.unsafe(`
      SELECT * FROM sp_finalize_registration('pi_test_001', 9700)
    `);
    assertEqual(rows[0].result_code, 'SUCCESS', 'result_code');

    // Verify status updated
    const regRows = await testSql.unsafe(`SELECT status, net_amount_cents FROM registrations WHERE payment_intent_id = 'pi_test_001'`);
    assertEqual(regRows[0].status, 'CONFIRMED', 'status');
    assertEqual(regRows[0].net_amount_cents, 9700, 'net_amount_cents');
  });

  await test('capacity_invariant still holds after slot acquisition', async () => {
    const eventRows = await testSql.unsafe(`SELECT total_capacity, confirmed_count, available_slots FROM events WHERE event_id = '${TEST_EVENT_ID}'`);
    const ev = eventRows[0];
    assertEqual(
      ev.available_slots + ev.confirmed_count,
      ev.total_capacity,
      'capacity invariant'
    );
  });

  await test('waitlist unique constraint', async () => {
    await testSql.unsafe(`
      INSERT INTO waitlist_entries (event_id, email, first_name, last_name)
      VALUES ('${TEST_EVENT_ID}', 'charlie@example.com', 'Charlie', 'Brown')
    `);
    try {
      await testSql.unsafe(`
        INSERT INTO waitlist_entries (event_id, email, first_name, last_name)
        VALUES ('${TEST_EVENT_ID}', 'charlie@example.com', 'Charlie', 'Brown')
      `);
      assert(false, 'Should have thrown unique constraint violation');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      assert(msg.includes('unique') || msg.includes('duplicate') || msg.includes('waitlist_unique_email_event'), `Expected unique violation, got: ${msg}`);
    }
  });

  await testSql.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
