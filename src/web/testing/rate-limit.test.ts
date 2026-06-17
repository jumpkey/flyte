/**
 * W16 — rate limiting hardening.
 *
 *  - getClientIp trusts the Fly-Client-IP edge header first (it can't be forged
 *    by the client), falling back to the LAST hop of X-Forwarded-For.
 *  - rateLimit answers 429 immediately once over the limit — no sleep-retry loop
 *    that would hold connections open and amplify an attack.
 *
 * Run: npx tsx src/web/testing/rate-limit.test.ts
 */
import 'dotenv/config';
import { Hono } from 'hono';
import { rateLimit } from '../middleware/rate-limit.js';
import { getClientIp } from '../utils/get-client-ip.js';
import { assert, assertEqual } from '../../registration/testing/test-helpers.js';

function fakeCtx(headers: Record<string, string>) {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { req: { header: (name: string) => lower[name.toLowerCase()] } } as any;
}

async function runTests() {
  let passed = 0; let failed = 0;
  async function test(name: string, fn: () => void | Promise<void>) {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}:`, e instanceof Error ? e.message : String(e)); failed++; }
  }

  console.log('\n=== W16: Rate-limit hardening ===\n');

  // ── getClientIp source preference ──
  await test('getClientIp prefers the trusted Fly-Client-IP header', () => {
    const ip = getClientIp(fakeCtx({
      'fly-client-ip': '203.0.113.7',
      'x-forwarded-for': '1.2.3.4, 5.6.7.8',
      'x-real-ip': '9.9.9.9',
    }));
    assertEqual(ip, '203.0.113.7', 'Fly header wins over spoofable XFF/X-Real-IP');
  });

  await test('getClientIp falls back to the LAST hop of X-Forwarded-For', () => {
    // The left-most entry is client-controlled; our proxy appends the real one.
    const ip = getClientIp(fakeCtx({ 'x-forwarded-for': '1.2.3.4, 198.51.100.9' }));
    assertEqual(ip, '198.51.100.9', 'takes the proxy-appended last hop');
  });

  await test('getClientIp falls back to X-Real-IP then localhost', () => {
    assertEqual(getClientIp(fakeCtx({ 'x-real-ip': '9.9.9.9' })), '9.9.9.9', 'x-real-ip');
    assertEqual(getClientIp(fakeCtx({})), '127.0.0.1', 'default when nothing present');
  });

  // ── rateLimit returns 429 immediately, keyed by trusted IP ──
  const app = new Hono();
  app.post('/rl', rateLimit(2, 60_000), (c) => c.text('ok'));

  async function hit(ip: string) {
    return app.request('http://localhost/rl', { method: 'POST', headers: { 'fly-client-ip': ip } });
  }

  await test('over-limit requests get 429 — and fast (no sleep-retry)', async () => {
    const started = Date.now();
    assertEqual((await hit('100.64.0.1')).status, 200, '1st under limit');
    assertEqual((await hit('100.64.0.1')).status, 200, '2nd at limit');
    const third = await hit('100.64.0.1');
    assertEqual(third.status, 429, '3rd over limit → 429');
    assertEqual(await third.text(), 'Too many requests', '429 body');
    const elapsed = Date.now() - started;
    assert(elapsed < 500, `three requests should be near-instant, took ${elapsed}ms (no sleep loop)`);
  });

  await test('a different client IP has its own bucket', async () => {
    assertEqual((await hit('100.64.0.2')).status, 200, 'distinct IP is not limited by another IP');
  });

  console.log(`\n=== Rate-limit: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => { console.error(err); process.exit(1); });
