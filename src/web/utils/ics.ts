/**
 * Minimal RFC-5545 VEVENT for a registration (V2). No dependency: UID is the
 * registration UUID, DTSTART is the event date in UTC, DESCRIPTION carries the
 * confirmation URL. Default 2-hour duration (event end time isn't modelled).
 */

function icsDate(d: Date): string {
  return new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function escapeText(value: string): string {
  return (value ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

export function buildEventIcs(opts: {
  registrationId: string;
  eventName: string;
  eventDate: Date;
  location: string | null;
  confirmationUrl: string;
}): string {
  const start = new Date(opts.eventDate);
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Flyte//Events//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${opts.registrationId}@flyte`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${escapeText(opts.eventName)}`,
    ...(opts.location ? [`LOCATION:${escapeText(opts.location)}`] : []),
    `DESCRIPTION:${escapeText('Your registration: ' + opts.confirmationUrl)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.join('\r\n') + '\r\n';
}
