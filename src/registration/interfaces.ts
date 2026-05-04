import type {
  EventId, RegistrationId, WaitlistEntryId, PaymentIntentId,
  EventAvailability, RegistrationRecord, WaitlistEntry,
  RegistrationFormData, WaitlistFormData,
  IndividualRefundRequest, BulkRefundRequest,
  RegistrationInitResult, AuthorizationProcessResult,
  RefundResult, BulkRefundResult, ReconciliationResult
} from './types.js';

export interface StripeClient {
  paymentIntents: {
    create(params: Record<string, unknown>, options?: unknown): Promise<{id: string; client_secret: string; status: string; amount: unknown; currency: unknown; capture_method: string}>;
    retrieve(id: string): Promise<{id: string; status: string; amount_received?: number; latest_charge?: {amount_captured: number}; metadata?: Record<string, string>}>;
    capture(id: string, params?: Record<string, unknown>, options?: unknown): Promise<{id: string; status: string; amount_received?: number; latest_charge?: {amount_captured: number}}>;
    cancel(id: string, params?: Record<string, unknown>, options?: unknown): Promise<{id: string; status: string}>;
  };
  refunds: {
    create(params: Record<string, unknown>, options?: unknown): Promise<{id: string; amount: unknown; status: string}>;
  };
  webhooks: {
    constructEvent(payload: string | Buffer, sig: string, secret: string): Record<string, unknown>;
  };
}

export interface IEventAvailabilityService {
  getAvailability(eventId: EventId): Promise<EventAvailability | null>;
}

export interface IRegistrationService {
  initiateRegistration(formData: RegistrationFormData): Promise<RegistrationInitResult>;
  handleAuthorizationWebhook(paymentIntentId: PaymentIntentId, stripeEventPayload: Record<string, unknown>): Promise<AuthorizationProcessResult>;
  confirmRegistrationFromClient(paymentIntentId: PaymentIntentId): Promise<AuthorizationProcessResult>;
  handlePaymentAuthorized(paymentIntentId: PaymentIntentId, grossAmountCents: number): Promise<AuthorizationProcessResult>;
  handlePaymentFailed(paymentIntentId: PaymentIntentId, stripeEventPayload: Record<string, unknown>): Promise<AuthorizationProcessResult>;
  getRegistration(registrationId: RegistrationId): Promise<RegistrationRecord | null>;
  getRegistrationByPaymentIntent(paymentIntentId: PaymentIntentId): Promise<RegistrationRecord | null>;
  getConfirmedRegistrations(eventId: EventId): Promise<RegistrationRecord[]>;
}

export interface IRefundService {
  refundRegistration(request: IndividualRefundRequest): Promise<RefundResult>;
  refundEvent(request: BulkRefundRequest): Promise<BulkRefundResult>;
}

export interface IWaitlistService {
  addToWaitlist(formData: WaitlistFormData): Promise<WaitlistEntry>;
  getWaitlist(eventId: EventId): Promise<WaitlistEntry[]>;
  getWaitlistPosition(eventId: EventId, email: string): Promise<number | null>;
  removeFromWaitlist(waitlistEntryId: WaitlistEntryId): Promise<boolean>;
}

export interface IReconciliationService {
  reconcilePendingRegistrations(ttlMinutes?: number): Promise<ReconciliationResult>;
}

export interface INotificationService {
  sendRegistrationConfirmation(registration: RegistrationRecord, eventName: string): Promise<void>;
  sendWaitlistAcknowledgement(entry: WaitlistEntry, position: number, eventName: string): Promise<void>;
  sendRefundConfirmation(registration: RegistrationRecord, refundedAmountCents: number, eventName: string): Promise<void>;
}
