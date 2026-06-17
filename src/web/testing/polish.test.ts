/**
 * I9 — Polish & compliance (the headless-verifiable parts).
 *
 * The WK §9 email template (table layout, inline styles, single CTA), the styled
 * 404, and the a11y scaffolding (favicon, skip-link, landmark). Lighthouse ≥95
 * and the keyboard-only J1/J5 walkthrough (AC-I9 ② ③) need a headed browser and
 * are recorded as owner-run in design/WEBKIT-COMPLIANCE.md.
 *
 * Run: npx tsx src/web/testing/polish.test.ts
 */
import 'dotenv/config';
import { assert, assertEqual } from '../../registration/testing/test-helpers.js';
import { wrapEmail } from '../../registration/services/email-template.js';

async function get(path: string) {
  const { app } = await import('../app.js');
  return app.request(`http://localhost${path}`);
}

async function runTests() {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => Promise<void> | void) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}:`, e instanceof Error ? e.message : String(e)); failed++; }
  }

  console.log('\n=== I9: Polish & Compliance ===\n');

  // ── WK §9 email template (AC-I9 ④) ──
  await test('wrapEmail is table-based, inline-styled, 600px, navy header', () => {
    const html = wrapEmail({ heading: 'Hi', bodyHtml: '<p>Body</p>' });
    assert(html.includes('<table'), 'table layout');
    assert(html.includes('style="') && html.includes('font-family'), 'inline styles');
    assert(html.includes('width:600px') || html.includes('width="600"'), '600px width');
    assert(html.includes('#1F3A5F'), 'navy header band');
    assert(html.includes('Flyte'), 'wordmark');
  });

  await test('wrapEmail renders exactly one CTA button when given, none otherwise', () => {
    const withCta = wrapEmail({ heading: 'H', bodyHtml: '<p>x</p>', cta: { label: 'Go', url: 'https://x.test/y' } });
    // The CTA is now a bordered button — orange text on white with a 1px flare
    // border (#13 recolor). That border is unique to the CTA; the navy header's
    // "Flyte." dot also uses the flare color, so we key off the border.
    const buttons = (withCta.match(/border:1px solid #C2410C/g) ?? []).length;
    assertEqual(buttons, 1, 'one bordered CTA button');
    assert(withCta.includes('href="https://x.test/y"'), 'CTA links to url');
    const noCta = wrapEmail({ heading: 'H', bodyHtml: '<p>x</p>' });
    assertEqual((noCta.match(/border:1px solid #C2410C/g) ?? []).length, 0, 'no button without cta');
  });

  await test('wrapEmail passes through caller-escaped content verbatim (no double-escaping)', () => {
    // Caller is responsible for escapeHtml; wrapEmail must not mangle safe HTML.
    const html = wrapEmail({ heading: 'H', bodyHtml: '<p>Alice &amp; Bob</p>' });
    assert(html.includes('Alice &amp; Bob'), 'content preserved');
  });

  // ── Styled 404 (empty/error states) ──
  await test('unknown route returns a styled 404 (not plain text)', async () => {
    const resp = await get('/this-route-does-not-exist-xyz');
    assertEqual(resp.status, 404, '404 status');
    const body = await resp.text();
    assert(body.includes('Page not found'), 'styled message');
    assert(body.includes('navbar-flyte') || body.includes('/public/css/flyte.css'), 'wrapped in the themed layout');
  });

  // ── a11y scaffolding (WK §8) ──
  await test('home has favicon, skip-link, lang, and a main landmark', async () => {
    const body = await (await get('/')).text();
    assert(body.includes('rel="icon"') && body.includes('/public/favicon.svg'), 'favicon');
    assert(body.includes('class="skip-link"') && body.includes('#main'), 'skip-link');
    assert(body.includes('<html lang="en"'), 'lang set');
    assert(body.includes('id="main"'), 'main landmark');
  });

  console.log(`\n=== Polish: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
