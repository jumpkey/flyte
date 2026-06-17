/**
 * I1 — status-pill + money helpers (AC-I1 ⑤; WK §5 / §2.3).
 *
 * The status→variant mapping is the single source of truth for status color
 * across the whole site, so it gets an exhaustive snapshot: every registration,
 * event, and account status the system can show — plus the derived REFUNDED
 * display status (site map §7) — pinned to its WK §5 variant, asserted both at
 * the helper level and through the rendered partial. money() is pinned too.
 *
 * Run: npx tsx src/web/testing/status-pill.test.ts
 */
import 'dotenv/config';
import ejs from 'ejs';
import path from 'path';
import { fileURLToPath } from 'url';
import { statusPill, displayStatus, money, viewHelpers } from '../view-helpers.js';
import type { PillVariant } from '../view-helpers.js';
import { assert, assertEqual } from '../../registration/testing/test-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PARTIAL = path.resolve(__dirname, '../views/partials/status-pill.ejs');

// The WK §5 / §2.3 table, exhaustively. Keys cover registration statuses, event
// statuses, account statuses, refund-request statuses, the LOCKED defense pill,
// and the derived REFUNDED.
const EXPECTED: Record<string, PillVariant> = {
  // success
  CONFIRMED: 'success', OPEN: 'success', active: 'success',
  // info
  PENDING_CAPTURE: 'info', REFUNDED: 'info', FULL: 'info', APPROVED: 'info',
  // warning
  PENDING_PAYMENT: 'warning', CLOSED: 'warning', shadow: 'warning', REQUESTED: 'warning',
  // danger
  PAYMENT_FAILED: 'danger', CANCELLED: 'danger', DENIED: 'danger', LOCKED: 'danger',
  // neutral
  EXPIRED: 'neutral', DRAFT: 'neutral',
};

async function runTests() {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => void | Promise<void>) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}:`, e instanceof Error ? e.message : String(e)); failed++; }
  }

  console.log('\n=== I1: Status-Pill + Money Helpers ===\n');

  // ── Helper-level: every status maps to its WK §5 variant ──
  for (const [status, variant] of Object.entries(EXPECTED)) {
    await test(`statusPill(${status}) → ${variant}`, () => {
      const pill = statusPill(status);
      assertEqual(pill.variant, variant, `variant for ${status}`);
      assertEqual(pill.cssClass, `pill pill-${variant}`, `cssClass for ${status}`);
    });
  }

  // ── Partial render snapshot: each status produces the exact pill markup ──
  await test('partial renders the exact pill markup for each status', async () => {
    for (const [status, variant] of Object.entries(EXPECTED)) {
      const html = (await ejs.renderFile(PARTIAL, { status, ...viewHelpers })).trim();
      const label = statusPill(status).label;
      const expected = `<span class="pill pill-${variant}">${label}</span>`;
      assertEqual(html, expected, `rendered pill for ${status}`);
    }
  });

  // ── Derived REFUNDED (site map §7) ──
  await test('displayStatus derives REFUNDED for a refunded cancellation', () => {
    assertEqual(displayStatus({ status: 'CANCELLED', refunded_amount_cents: 2500 }), 'REFUNDED', 'cancelled+refund → REFUNDED');
    assertEqual(displayStatus({ status: 'CANCELLED', refunded_amount_cents: 0 }), 'CANCELLED', 'cancelled, no refund → CANCELLED');
    assertEqual(displayStatus({ status: 'CANCELLED' }), 'CANCELLED', 'cancelled, null refund → CANCELLED');
    assertEqual(displayStatus({ status: 'CONFIRMED', refunded_amount_cents: 0 }), 'CONFIRMED', 'confirmed unchanged');
    // And the derived status pills info, per the table.
    assertEqual(statusPill(displayStatus({ status: 'CANCELLED', refunded_amount_cents: 2500 })).variant, 'info', 'REFUNDED pills info');
  });

  // ── Fail-safe: unknown status never throws, renders neutral ──
  await test('unknown status falls back to neutral, never throws', () => {
    assertEqual(statusPill('SOMETHING_NEW').variant, 'neutral', 'unknown → neutral');
    assertEqual(statusPill('').label, 'Unknown', 'empty → Unknown label');
    assertEqual(statusPill(null).variant, 'neutral', 'null → neutral');
  });

  // ── money() ──
  await test('money formats cents as grouped dollars with two decimals', () => {
    assertEqual(money(0), '$0.00', 'zero');
    assertEqual(money(2500), '$25.00', 'whole dollars');
    assertEqual(money(123450), '$1,234.50', 'thousands grouping');
    assertEqual(money(99), '$0.99', 'sub-dollar');
    assertEqual(money(null), '$0.00', 'null → $0.00');
  });

  console.log(`\n=== Status-Pill: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
