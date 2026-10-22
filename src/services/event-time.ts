import { config } from '../config.js';

export type WallTimeResult =
  | { ok: true; date: Date }
  | { ok: false; reason: 'invalid' | 'nonexistent' | 'ambiguous' };

interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    formatters.set(timeZone, value);
  }
  return value;
}

function partsAt(instant: Date, timeZone: string): DateParts {
  const values: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values.year, month: values.month, day: values.day,
    hour: values.hour, minute: values.minute, second: values.second,
  };
}

function sameParts(a: DateParts, b: DateParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day &&
    a.hour === b.hour && a.minute === b.minute && a.second === b.second;
}

/**
 * Interpret a `datetime-local` wall time in an IANA zone. A local time can map
 * to zero instants at a spring DST gap or two instants at an autumn overlap;
 * both cases are surfaced instead of silently applying the server timezone.
 */
export function wallTimeToInstant(raw: string, timeZone = config.eventTimeZone): WallTimeResult {
  // HTML datetime-local submits YYYY-MM-DDTHH:mm (seconds/fractions are accepted
  // too for callers that opt into them).
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(raw);
  if (!match) return { ok: false, reason: 'invalid' };
  const desired: DateParts = {
    year: Number(match[1]), month: Number(match[2]), day: Number(match[3]),
    hour: Number(match[4]), minute: Number(match[5]), second: Number(match[6] ?? 0),
  };
  const millis = Number((match[7] ?? '').padEnd(3, '0') || 0);
  if (desired.month < 1 || desired.month > 12 || desired.day < 1 || desired.day > 31 ||
      desired.hour > 23 || desired.minute > 59 || desired.second > 59) {
    return { ok: false, reason: 'invalid' };
  }
  const wallEpoch = Date.UTC(desired.year, desired.month - 1, desired.day, desired.hour, desired.minute, desired.second, millis);
  const checked = new Date(wallEpoch);
  if (checked.getUTCFullYear() !== desired.year || checked.getUTCMonth() + 1 !== desired.month ||
      checked.getUTCDate() !== desired.day || checked.getUTCHours() !== desired.hour ||
      checked.getUTCMinutes() !== desired.minute || checked.getUTCSeconds() !== desired.second) {
    return { ok: false, reason: 'invalid' };
  }

  // Discover offsets on both sides of any nearby DST transition. Then verify
  // each candidate by formatting it back into the requested zone.
  const offsets = new Set<number>();
  for (let delta = -48; delta <= 48; delta += 6) {
    const probe = new Date(wallEpoch + delta * 60 * 60 * 1000);
    const local = partsAt(probe, timeZone);
    const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    offsets.add(localAsUtc - Math.floor(probe.getTime() / 1000) * 1000);
  }
  const candidates = [...offsets]
    .map((offset) => new Date(wallEpoch - offset))
    .filter((candidate) => sameParts(partsAt(candidate, timeZone), desired))
    .sort((a, b) => a.getTime() - b.getTime());

  if (candidates.length === 0) return { ok: false, reason: 'nonexistent' };
  if (candidates.length > 1) return { ok: false, reason: 'ambiguous' };
  return { ok: true, date: candidates[0] };
}

/** Format an instant for an admin `datetime-local` editor in the event zone. */
export function instantToWallTime(instant: Date, timeZone = config.eventTimeZone): string {
  const p = partsAt(instant, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(p.year).padStart(4, '0')}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

export const eventTimeZone = config.eventTimeZone;
