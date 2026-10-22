/**
 * Minimal RFC-4180 CSV serialization for admin exports (A7). Values are quoted
 * when they contain a comma, quote, or newline; embedded quotes are doubled.
 * Text beginning with spreadsheet formula characters is prefixed with an
 * apostrophe. This deliberately treats exported values as text, including
 * negative-looking strings; genuine numeric columns remain numeric.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else {
    s = String(value);
    // Spreadsheet apps may ignore leading whitespace/control characters before
    // interpreting a formula. Prefixing the whole cell forces literal text.
    if (typeof value === 'string' && /^[\s\u0000-\u001f]*[=+@-]/.test(s)) s = `'${s}`;
  }
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers.map(cell).join(',')];
  for (const row of rows) lines.push(row.map(cell).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** Build a CSV download Response with an attachment filename. */
export function csvResponse(filename: string, body: string): Response {
  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}
