export type StripePaymentIntentStatus =
  | 'requires_payment_method'
  | 'requires_confirmation'
  | 'requires_action'
  | 'processing'
  | 'requires_capture'
  | 'canceled'
  | 'succeeded';

export type StripeCaptureErrorType = 'none' | 'transient' | 'permanent';

export interface MockStripeOptions {
  createShouldTimeout?:     boolean;
  createShouldError?:       boolean;
  createDelayMs?:           number;
  retrieveStatus?:          StripePaymentIntentStatus;
  retrieveNetAmountCents?:  number;
  captureErrorType?:        StripeCaptureErrorType;
  captureNetAmountCents?:   number;
  cancelShouldError?:       boolean;
  refundShouldError?:       boolean;
}

export class MockStripeClient {
  options: MockStripeOptions;
  calls: { method: string; args: unknown[] }[] = [];

  constructor(options: MockStripeOptions = {}) {
    this.options = options;
  }

  paymentIntents = {
    create: async (params: Record<string, unknown>, _reqOptions?: unknown) => {
      this.calls.push({ method: 'paymentIntents.create', args: [params] });

      if (params['capture_method'] !== 'manual') {
        throw new Error(
          `MockStripeClient invariant violated: paymentIntents.create called without ` +
          `capture_method: 'manual'. Got: ${params['capture_method']}`
        );
      }

      if (this.options.createShouldTimeout) {
        await new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(Object.assign(new Error('Request timeout'), { type: 'api_error' })),
            this.options.createDelayMs ?? 10001
          )
        );
      }
      if (this.options.createShouldError) {
        throw Object.assign(new Error('Stripe API error (mock)'), { type: 'api_error' });
      }
      const id = `pi_mock_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
      return {
        id,
        client_secret:  `${id}_secret_mock`,
        status:         'requires_payment_method' as StripePaymentIntentStatus,
        amount:         params['amount'],
        currency:       params['currency'],
        capture_method: 'manual',
      };
    },

    retrieve: async (id: string) => {
      this.calls.push({ method: 'paymentIntents.retrieve', args: [id] });
      const net = this.options.retrieveNetAmountCents ?? 9700;
      return {
        id,
        status:          this.options.retrieveStatus ?? 'requires_capture',
        amount_received: net,
        latest_charge:   { amount_captured: net },
      };
    },

    capture: async (id: string) => {
      this.calls.push({ method: 'paymentIntents.capture', args: [id] });
      const errType = this.options.captureErrorType ?? 'none';
      if (errType === 'transient') {
        throw Object.assign(
          new Error('Connection error (mock)'),
          { type: 'api_error', code: 'api_connection_error' }
        );
      }
      if (errType === 'permanent') {
        throw Object.assign(
          new Error('Your card was declined (mock)'),
          { type: 'card_error', code: 'card_declined', decline_code: 'generic_decline' }
        );
      }
      const net = this.options.captureNetAmountCents ?? 9700;
      return {
        id,
        status:          'succeeded' as StripePaymentIntentStatus,
        amount_received: net,
        latest_charge:   { amount_captured: net },
      };
    },

    cancel: async (id: string) => {
      this.calls.push({ method: 'paymentIntents.cancel', args: [id] });
      if (this.options.cancelShouldError) {
        throw Object.assign(new Error('Cancel error (mock)'), { type: 'api_error' });
      }
      return { id, status: 'canceled' as StripePaymentIntentStatus };
    },
  };

  refunds = {
    create: async (params: Record<string, unknown>) => {
      this.calls.push({ method: 'refunds.create', args: [params] });
      if (this.options.refundShouldError) {
        throw Object.assign(new Error('Refund error (mock)'), { type: 'api_error' });
      }
      return {
        id:     `re_mock_${Date.now()}`,
        amount: params['amount'] ?? params['payment_intent'],
        status: 'succeeded',
      };
    },
  };

  webhooks = {
    constructEvent: (payload: string, _sig: string, _secret: string) => {
      return JSON.parse(payload);
    },
  };

  assertCalled(method: string): void {
    if (!this.calls.some(c => c.method === method)) {
      throw new Error(`MockStripeClient: expected ${method} to have been called`);
    }
  }

  assertNotCalled(method: string): void {
    if (this.calls.some(c => c.method === method)) {
      throw new Error(`MockStripeClient: expected ${method} NOT to have been called`);
    }
  }

  reset(): void { this.calls = []; }
}
