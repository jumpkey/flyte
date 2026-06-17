/**
 * Shared view helpers — the single source of truth for cross-cutting display
 * rules (WK §5 status colors, money formatting). Injected into every template's
 * locals by render.ts, so partials and pages call e.g. statusPill(status) or
 * money(cents) without re-importing. Keeping the logic here (not in EJS) is what
 * makes it testable — see src/web/testing/status-pill.test.ts.
 */

export type PillVariant = 'success' | 'info' | 'warning' | 'danger' | 'neutral';

// WK §2.3 / §5 status → pill variant mapping. Every registration, event, and
// account status the site can show appears here exactly once. The admin FULL
// pill is deliberately info (a sold-out event is good news), not warning.
const PILL_VARIANT: Record<string, PillVariant> = {
  // success
  CONFIRMED: 'success', OPEN: 'success', ACTIVE: 'success',
  // info
  PENDING_CAPTURE: 'info', REFUNDED: 'info', FULL: 'info', APPROVED: 'info',
  // warning
  PENDING_PAYMENT: 'warning', CLOSED: 'warning', SHADOW: 'warning', REQUESTED: 'warning',
  // danger
  PAYMENT_FAILED: 'danger', CANCELLED: 'danger', DENIED: 'danger', LOCKED: 'danger',
  // neutral
  EXPIRED: 'neutral', DRAFT: 'neutral',
};

// Human labels where a title-cased token would read poorly. Anything not listed
// falls back to Title-casing the underscored status (PENDING_CAPTURE → Pending
// capture).
const PILL_LABEL: Record<string, string> = {
  ACTIVE: 'Active',
  SHADOW: 'Shadow',
  LOCKED: 'Locked',
  FULL: 'Sold out',
};

function titleCase(status: string): string {
  const lower = status.replace(/_/g, ' ').toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export interface Pill {
  variant: PillVariant;
  label: string;
  cssClass: string;
}

/**
 * Resolve a status string to its WK §5 pill. Unknown statuses fall back to the
 * neutral variant (fail safe — never throw in a template) so a future status
 * renders as a plain grey pill rather than crashing the page.
 */
export function statusPill(status: string | null | undefined): Pill {
  const key = (status ?? '').toString().trim().toUpperCase();
  const variant = PILL_VARIANT[key] ?? 'neutral';
  const label = PILL_LABEL[key] ?? (key ? titleCase(key) : 'Unknown');
  return { variant, label, cssClass: `pill pill-${variant}` };
}

/**
 * Derived display status for a registration (site map §7): a CANCELLED row that
 * carries a refund is shown as REFUNDED. Everything else shows its own status.
 */
export function displayStatus(reg: { status: string; refunded_amount_cents?: number | null }): string {
  if (reg.status === 'CANCELLED' && (reg.refunded_amount_cents ?? 0) > 0) {
    return 'REFUNDED';
  }
  return reg.status;
}

/** Cents → "$1,234.50" (tabular, two decimals, grouped). */
export function money(cents: number | null | undefined): string {
  const value = (cents ?? 0) / 100;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Event card / storefront helpers (I2) ───────────────────────────────────

export interface CardEvent {
  status: string;
  available_slots: number;
  total_capacity: number;
  waitlist_enabled?: boolean;
}

export type CardState = 'available' | 'low' | 'sold-out' | 'closed';

export interface EventCardInfo {
  state: CardState;
  /** Fraction of capacity still available, 0..1. */
  fraction: number;
  /** Rounded percentage for the meter width (floored at 4 for visibility). */
  meterPct: number;
  soldOut: boolean;
  /** Sold out AND the admin has the waitlist open (D6). */
  waitlistOpen: boolean;
  /** True for CLOSED/CANCELLED — no booking CTA. */
  noCta: boolean;
}

/**
 * Classify an event for card/detail rendering (AC-I2 ②). Single source of truth
 * for the available / low (<25%) / sold-out / closed states and the availability
 * meter, so the cards and the detail panel can't drift apart. FULL or zero slots
 * is sold out; CLOSED/CANCELLED is closed; otherwise low when under a quarter of
 * capacity remains, else available.
 */
export function eventCardState(ev: CardEvent): EventCardInfo {
  const capacity = ev.total_capacity > 0 ? ev.total_capacity : 0;
  const fraction = capacity > 0 ? Math.max(0, Math.min(1, ev.available_slots / capacity)) : 0;
  const soldOut = ev.status === 'FULL' || ev.available_slots <= 0;
  const closed = ev.status === 'CLOSED' || ev.status === 'CANCELLED';

  let state: CardState;
  if (closed) state = 'closed';
  else if (soldOut) state = 'sold-out';
  else if (fraction < 0.25) state = 'low';
  else state = 'available';

  return {
    state,
    fraction,
    meterPct: Math.max(4, Math.round(fraction * 100)),
    soldOut,
    waitlistOpen: soldOut && !closed && ev.waitlist_enabled !== false,
    noCta: closed,
  };
}

/** Two-letter initials for the image fallback card (WK §6). */
export function eventInitials(name: string): string {
  return (name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase() || '?';
}

/** Short date badge, e.g. "JUN 17". */
export function dateBadge(date: Date | string): string {
  return new Date(date)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    .toUpperCase();
}

/** Longer card meta date, e.g. "Tue, Jun 17". */
export function dateLong(date: Date | string): string {
  return new Date(date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

/** The bundle injected into every template's locals. */
export const viewHelpers = {
  statusPill, displayStatus, money,
  eventCardState, eventInitials, dateBadge, dateLong,
};
