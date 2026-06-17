/**
 * Event sell-through projection (addendum §3.1). Pure and unit-tested. Velocity
 * (regs/day over the trailing window) is computed by the caller; this turns it
 * into a pace band + an honest, plain-words headline. Deliberately naive linear
 * baseline for v1 — the honest qualifiers matter more than the model.
 */

export type PaceBand = 'SOLD_OUT' | 'AHEAD' | 'ON_PACE' | 'AT_RISK';

export interface ProjectionInput {
  openedAt: Date | null;
  eventDate: Date;
  capacity: number;
  confirmed: number;
  availableSlots: number;
  /** Confirmations per day over the trailing window (min(7, days_on_sale)). */
  velocity: number;
  now?: Date;
}

export interface Projection {
  band: PaceBand;
  velocity: number;
  paceIndex: number | null;
  projectedSelloutDate: Date | null;
  projectedFill: number;
  demandOverflow: number;
  lowConfidence: boolean;
  /** One plain-language sentence — the data; the chart is the garnish. */
  headline: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function computeProjection(input: ProjectionInput): Projection {
  const now = input.now ?? new Date();
  const cap = Math.max(input.capacity, 1);
  const remaining = Math.max(input.availableSlots, 0);
  const daysOnSale = input.openedAt ? Math.max(1, (now.getTime() - input.openedAt.getTime()) / DAY_MS) : 1;
  const daysToEvent = Math.max(0, (input.eventDate.getTime() - now.getTime()) / DAY_MS);
  const v = Math.max(input.velocity, 0);

  const lowConfidence = daysOnSale < 3 || input.confirmed < 5;

  // Linear baseline pace.
  const totalWindow = input.openedAt ? (input.eventDate.getTime() - input.openedAt.getTime()) / DAY_MS : 0;
  const expectedFraction = totalWindow > 0 ? Math.min(1, (now.getTime() - (input.openedAt as Date).getTime()) / DAY_MS / totalWindow) : 0;
  const paceIndex = expectedFraction > 0 ? (input.confirmed / cap) / expectedFraction : null;

  const projectedFill = Math.min(cap, input.confirmed + v * daysToEvent);
  const demandOverflow = Math.max(0, v * daysToEvent - remaining);
  const projectedSelloutDate = v > 0 && remaining > 0 ? new Date(now.getTime() + (remaining / v) * DAY_MS) : null;

  // Band.
  let band: PaceBand;
  if (remaining === 0) band = 'SOLD_OUT';
  else if (paceIndex !== null && paceIndex < 0.85) band = 'AT_RISK';
  else if (projectedFill < 0.8 * cap) band = 'AT_RISK';
  else if (paceIndex !== null && paceIndex > 1.15) band = 'AHEAD';
  else band = 'ON_PACE';

  // Headline (honest — §3.1).
  let headline: string;
  const fillPct = Math.round((projectedFill / cap) * 100);
  if (band === 'SOLD_OUT') {
    headline = 'Sold out.';
  } else if (lowConfidence) {
    headline = `Early days — low confidence. ${input.confirmed} of ${cap} confirmed so far.`;
  } else if (projectedSelloutDate && projectedSelloutDate <= input.eventDate) {
    const daysBefore = Math.max(0, Math.round((input.eventDate.getTime() - projectedSelloutDate.getTime()) / DAY_MS));
    headline = `Projected to sell out ${fmt(projectedSelloutDate)} at current pace — ${daysBefore} day${daysBefore === 1 ? '' : 's'} before the event.`;
  } else if (demandOverflow > 0) {
    headline = `Demand is outrunning capacity by ~${Math.round(demandOverflow)} seats at current pace — consider expanding.`;
  } else {
    headline = `At the current pace this event reaches ~${fillPct}% of capacity — consider promotion.`;
  }

  return { band, velocity: v, paceIndex, projectedSelloutDate, projectedFill, demandOverflow, lowConfidence, headline };
}

export function paceBandLabel(band: PaceBand): string {
  return { SOLD_OUT: 'Sold out', AHEAD: 'Ahead', ON_PACE: 'On pace', AT_RISK: 'At risk' }[band];
}

function fmt(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
