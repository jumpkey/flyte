import type { StripeClient } from './interfaces.js';
import { config } from '../config.js';

let _stripe: StripeClient | null = null;

export async function getStripe(): Promise<StripeClient> {
  if (_stripe) return _stripe;
  if (!config.stripe.secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured');
  }
  const { default: Stripe } = await import('stripe');
  _stripe = new Stripe(config.stripe.secretKey, {
    apiVersion: '2026-04-22.dahlia' as const,
    timeout: config.stripe.apiTimeoutMs,
  }) as unknown as StripeClient;
  return _stripe;
}
