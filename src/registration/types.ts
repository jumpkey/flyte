// ─── Identifiers ─────────────────────────────────────────────────────────────

export type EventId          = string;  // UUID
export type RegistrationId   = string;  // UUID
export type WaitlistEntryId  = string;  // UUID
export type PaymentIntentId  = string;  // Stripe pi_xxx
export type RefundId         = string;  // Stripe re_xxx

// ─── Enumerations ─────────────────────────────────────────────────────────────

export type RegistrationStatus =
  | 'PENDING_PAYMENT'
  | 'PENDING_CAPTURE'
  | 'CONFIRMED'
  | 'PAYMENT_FAILED'
  | 'EXPIRED'
  | 'CANCELLED';

export type RegistrationOutcome =
  | 'SUCCESS'
  | 'AVAILABILITY_EXHAUSTED'
  | 'ALREADY_REGISTERED'
  | 'PAYMENT_FAILED'
  | 'CAPTURE_FAILED'
  | 'PAYMENT_INTENT_EXPIRED'
  | 'STRIPE_TIMEOUT'
  | 'STRIPE_ERROR'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'IDEMPOTENT_REPLAY'
  | 'INTERNAL_ERROR';

export type RefundOutcome =
  | 'REFUND_ISSUED'
  | 'PARTIAL_REFUND_ISSUED'
  | 'ALREADY_REFUNDED'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'AMOUNT_EXCEEDS_BALANCE'
  | 'STRIPE_ERROR'
  | 'INTERNAL_ERROR';

export type RefundType = 'FULL' | 'PARTIAL';

// ─── Core Domain Objects ──────────────────────────────────────────────────────

export interface EventAvailability {
  eventId:           EventId;
  totalCapacity:     number;
  confirmedCount:    number;
  availableSlots:    number;
  waitlistCount:     number;
  status:            string;
  updatedAt:         Date;
}

export interface RegistrationRecord {
  registrationId:           RegistrationId;
  eventId:                  EventId;
  email:                    string;
  firstName:                string;
  lastName:                 string;
  phone:                    string | null;
  attributes:               Record<string, string>;
  status:                   RegistrationStatus;
  paymentIntentId:          PaymentIntentId | null;
  grossAmountCents:         number;
  netAmountCents:           number | null;
  refundedAmountCents:      number;
  stripeRefundId:           RefundId | null;
  captureAttemptCount:      number;
  lastCaptureAttemptAt:     Date | null;
  confirmationEmailSentAt:  Date | null;
  createdAt:                Date;
  updatedAt:                Date;
  confirmedAt:              Date | null;
  cancelledAt:              Date | null;
}

export interface WaitlistEntry {
  waitlistEntryId: WaitlistEntryId;
  eventId:         EventId;
  email:           string;
  firstName:       string;
  lastName:        string;
  phone:           string | null;
  createdAt:       Date;
}

// ─── Input Shapes ─────────────────────────────────────────────────────────────

export interface RegistrationFormData {
  eventId:          EventId;
  email:            string;
  firstName:        string;
  lastName:         string;
  phone?:           string;
  attributes?:      Record<string, string>;
  grossAmountCents: number;
}

export interface WaitlistFormData {
  eventId:   EventId;
  email:     string;
  firstName: string;
  lastName:  string;
  phone?:    string;
}

export interface IndividualRefundRequest {
  registrationId:      RegistrationId;
  refundType:          RefundType;
  partialAmountCents?: number;
  reason:              string;
}

export interface BulkRefundRequest {
  eventId:    EventId;
  refundType: 'FULL';
  reason:     string;
}

// ─── Result Shapes ────────────────────────────────────────────────────────────

export interface RegistrationInitResult {
  outcome:             RegistrationOutcome;
  registrationId?:     RegistrationId;
  stripeClientSecret?: string;
  paymentIntentId?:    PaymentIntentId;
  message?:            string;
}

export interface AuthorizationProcessResult {
  outcome:         RegistrationOutcome;
  registrationId?: RegistrationId;
  message?:        string;
}

export interface RefundResult {
  outcome:              RefundOutcome;
  registrationId?:      RegistrationId;
  stripeRefundId?:      RefundId;
  refundedAmountCents?: number;
  message?:             string;
}

export interface BulkRefundResult {
  eventId:        EventId;
  totalProcessed: number;
  totalSucceeded: number;
  totalFailed:    number;
  results:        Array<{ registrationId: RegistrationId; result: RefundResult }>;
}

export interface ReconciliationResult {
  expiredCount:            number;
  captureRetriedCount:     number;
  captureRestoredCount:    number;
  webhookRecoveredCount:   number;
  emailResentCount:        number;
  errorCount:              number;
  expiredRegistrationIds:  RegistrationId[];
  restoredRegistrationIds: RegistrationId[];
}
