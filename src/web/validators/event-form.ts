/**
 * Admin event form validation (I4, WF-09). Pure and unit-testable — the single
 * source of truth for the create/edit rules: dollars→cents, capacity floor on
 * edit, https-only image URLs (S5). Returns normalized values or per-field
 * errors keyed by field name for inline display.
 */

export interface EventFormValues {
  name: string;
  eventDate: Date;
  location: string | null;
  description: string | null;
  totalCapacity: number;
  registrationFeeCents: number;
  imageUrl: string | null;
  waitlistEnabled: boolean;
}

export type EventFormResult =
  | { ok: true; values: EventFormValues }
  | { ok: false; errors: Record<string, string>; values: Partial<EventFormValues> & { feeDollars?: string; eventDateRaw?: string } };

const NAME_MAX = 200;
const LOCATION_MAX = 500;
const DESCRIPTION_MAX = 5000;
const IMAGE_URL_MAX = 2048;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function validateEventForm(
  input: Record<string, unknown>,
  opts: { minCapacity?: number } = {},
): EventFormResult {
  const errors: Record<string, string> = {};

  const name = str(input.name);
  if (!name) errors.name = 'Name is required.';
  else if (name.length > NAME_MAX) errors.name = `Name must be ${NAME_MAX} characters or fewer.`;

  const eventDateRaw = str(input.eventDate);
  let eventDate = new Date(NaN);
  if (!eventDateRaw) {
    errors.eventDate = 'Date and time are required.';
  } else {
    eventDate = new Date(eventDateRaw);
    if (Number.isNaN(eventDate.getTime())) errors.eventDate = 'Enter a valid date and time.';
  }

  const location = str(input.location);
  if (location.length > LOCATION_MAX) errors.location = `Location must be ${LOCATION_MAX} characters or fewer.`;

  const description = str(input.description);
  if (description.length > DESCRIPTION_MAX) errors.description = `Description must be ${DESCRIPTION_MAX} characters or fewer.`;

  // Capacity: positive integer; on edit, never below the confirmed count.
  const capacityRaw = str(input.capacity);
  let totalCapacity = NaN;
  if (!capacityRaw) {
    errors.capacity = 'Capacity is required.';
  } else if (!/^\d+$/.test(capacityRaw)) {
    errors.capacity = 'Capacity must be a whole number.';
  } else {
    totalCapacity = parseInt(capacityRaw, 10);
    if (totalCapacity < 1) errors.capacity = 'Capacity must be at least 1.';
    else if (opts.minCapacity !== undefined && totalCapacity < opts.minCapacity) {
      errors.capacity = `Capacity cannot be below the ${opts.minCapacity} already confirmed.`;
    }
  }

  // Fee: dollars in, cents stored. Accept "25", "25.5", "25.00".
  const feeDollars = str(input.feeDollars);
  let registrationFeeCents = NaN;
  if (feeDollars === '') {
    errors.feeDollars = 'Fee is required (enter 0 for a free event).';
  } else if (!/^\d+(\.\d{1,2})?$/.test(feeDollars)) {
    errors.feeDollars = 'Enter a dollar amount like 25 or 25.00.';
  } else {
    registrationFeeCents = Math.round(parseFloat(feeDollars) * 100);
  }

  // Image URL: optional, https only, length-bounded (S5).
  const imageUrlRaw = str(input.imageUrl);
  let imageUrl: string | null = null;
  if (imageUrlRaw) {
    if (imageUrlRaw.length > IMAGE_URL_MAX) errors.imageUrl = `Image URL must be ${IMAGE_URL_MAX} characters or fewer.`;
    else if (!/^https:\/\/\S+$/i.test(imageUrlRaw)) errors.imageUrl = 'Image URL must start with https://';
    else imageUrl = imageUrlRaw;
  }

  // Checkbox: present (any truthy form value) → true. Default true on a fresh
  // form is handled by the view, not here.
  const waitlistEnabled = input.waitlistEnabled === 'on' || input.waitlistEnabled === 'true' || input.waitlistEnabled === true;

  if (Object.keys(errors).length > 0) {
    return {
      ok: false,
      errors,
      values: {
        name, location: location || null, description: description || null,
        imageUrl, waitlistEnabled, feeDollars, eventDateRaw,
        ...(Number.isNaN(totalCapacity) ? {} : { totalCapacity }),
      },
    };
  }

  return {
    ok: true,
    values: {
      name,
      eventDate,
      location: location || null,
      description: description || null,
      totalCapacity,
      registrationFeeCents,
      imageUrl,
      waitlistEnabled,
    },
  };
}

/**
 * Server-side event status transition rules (WF-08 lifecycle).
 * DRAFT→OPEN, OPEN↔CLOSED. FULL is engine-managed (never an admin choice).
 * CANCELLED only via the cancel action, never this path.
 */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['DRAFT', 'OPEN'],
  OPEN: ['OPEN', 'CLOSED'],
  FULL: ['FULL', 'CLOSED'],   // a sold-out event can still be closed
  CLOSED: ['CLOSED', 'OPEN'],
  CANCELLED: ['CANCELLED'],
};

export function isAllowedTransition(from: string, to: string): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}
