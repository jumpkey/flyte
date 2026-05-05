import type { StripeClient } from './interfaces.js';
import { config } from '../config.js';

let _stripe: StripeClient | null = null;

export async function getStripe(): Promise<StripeClient> {
  if (_stripe) return _stripe;
  if (!config.stripe.secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  const { default: Stripe } = await import('stripe');

  // Allow redirecting all Stripe API calls to a local simulator for load
  // testing and integration tests. Set STRIPE_SIMULATOR_HOST (and optionally
  // STRIPE_SIMULATOR_PORT / STRIPE_SIMULATOR_PROTOCOL) to override.
  // Example: STRIPE_SIMULATOR_HOST=localhost STRIPE_SIMULATOR_PORT=12111 STRIPE_SIMULATOR_PROTOCOL=http
  const simHost = process.env['STRIPE_SIMULATOR_HOST'];
  const simPort = process.env['STRIPE_SIMULATOR_PORT'];
  const simProtocol = process.env['STRIPE_SIMULATOR_PROTOCOL'];

  const extraOpts: Record<string, unknown> = {};
  if (simHost) {
    extraOpts['host'] = simHost;
    if (simPort) {
      const port = parseInt(simPort, 10);
      if (port >= 1 && port <= 65535) extraOpts['port'] = port;
    }
    if (simProtocol) extraOpts['protocol'] = simProtocol;
  }

  _stripe = new Stripe(config.stripe.secretKey, {
    apiVersion: '2026-04-22.dahlia' as const,
    timeout: config.stripe.apiTimeoutMs,
    ...extraOpts,
  }) as unknown as StripeClient;
  return _stripe;
}

