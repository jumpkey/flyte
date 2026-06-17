/**
 * Server-rendered inline SVG charts (addendum §6). No dependency, no CSP impact
 * (SVG is markup, not script). WK tokens: navy series, flare for projection/today
 * markers, muted gridlines. Every chart is the garnish — callers always pair it
 * with the numbers in text (WK-A11Y-3).
 */

const NAVY = '#1F3A5F';
const FLARE = '#C2410C';
const MUTED = '#94A3B8';
const GRID = '#E2E8F0';
const SUCCESS = '#2F9E44';

function px(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

/** Sparkline: a tiny trend line for compact strips (WF-10). */
export function sparkline(values: number[], opts: { width?: number; height?: number } = {}): string {
  const w = opts.width ?? 120; const h = opts.height ?? 28;
  if (values.length === 0) return `<svg width="${w}" height="${h}" role="img" aria-hidden="true"></svg>`;
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const pts = values.map((v, i) => `${px(i * step)},${px(h - (v / max) * (h - 2) - 1)}`).join(' ');
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-hidden="true"><polyline fill="none" stroke="${NAVY}" stroke-width="1.5" points="${pts}"/></svg>`;
}

/** Vertical bar chart with an optional overlaid moving-average line. */
export function barChart(values: number[], opts: { width?: number; height?: number; line?: number[]; labels?: string[] } = {}): string {
  const w = opts.width ?? 480; const h = opts.height ?? 160;
  const pad = 24;
  const innerW = w - pad * 2; const innerH = h - pad * 2;
  const max = Math.max(...values, ...(opts.line ?? []), 1);
  const n = values.length || 1;
  const bw = (innerW / n) * 0.7;
  const gap = (innerW / n) * 0.3;
  const bars = values.map((v, i) => {
    const bh = (v / max) * innerH;
    const x = pad + i * (innerW / n) + gap / 2;
    const y = pad + innerH - bh;
    return `<rect x="${px(x)}" y="${px(y)}" width="${px(bw)}" height="${px(bh)}" fill="${NAVY}" opacity="0.85" rx="1"/>`;
  }).join('');
  let line = '';
  if (opts.line && opts.line.length > 1) {
    const step = innerW / (opts.line.length - 1);
    const pts = opts.line.map((v, i) => `${px(pad + i * step)},${px(pad + innerH - (v / max) * innerH)}`).join(' ');
    line = `<polyline fill="none" stroke="${FLARE}" stroke-width="2" points="${pts}"/>`;
  }
  const baseline = `<line x1="${pad}" y1="${pad + innerH}" x2="${w - pad}" y2="${pad + innerH}" stroke="${GRID}"/>`;
  return `<svg width="100%" viewBox="0 0 ${w} ${h}" role="img" aria-hidden="true">${baseline}${bars}${line}</svg>`;
}

/** Booking curve: cumulative line, dashed capacity ceiling, dotted projection, today marker. */
export function bookingCurve(opts: {
  cumulative: number[]; capacity: number; projection?: number[]; width?: number; height?: number;
}): string {
  const w = opts.width ?? 520; const h = opts.height ?? 200; const pad = 28;
  const innerW = w - pad * 2; const innerH = h - pad * 2;
  const maxY = Math.max(opts.capacity, ...opts.cumulative, ...(opts.projection ?? []), 1);
  const series = opts.cumulative;
  const stepX = series.length > 1 ? innerW / (series.length - 1) : 0;
  const y = (v: number) => pad + innerH - (v / maxY) * innerH;
  const x = (i: number) => pad + i * stepX;

  const capY = y(opts.capacity);
  const ceiling = `<line x1="${pad}" y1="${px(capY)}" x2="${w - pad}" y2="${px(capY)}" stroke="${MUTED}" stroke-width="1.5" stroke-dasharray="5 4"/>`;
  const curve = series.length > 0
    ? `<polyline fill="none" stroke="${SUCCESS}" stroke-width="2.5" points="${series.map((v, i) => `${px(x(i))},${px(y(v))}`).join(' ')}"/>`
    : '';
  let projection = '';
  if (opts.projection && opts.projection.length > 1 && series.length > 0) {
    const startI = series.length - 1;
    const pStep = innerW / (series.length + opts.projection.length - 2 || 1);
    const pts = opts.projection.map((v, i) => `${px(pad + (startI + i) * stepX)},${px(y(v))}`).join(' ');
    projection = `<polyline fill="none" stroke="${FLARE}" stroke-width="2" stroke-dasharray="2 3" points="${pts}"/>`;
  }
  const todayX = x(series.length - 1);
  const todayMarker = series.length > 0 ? `<line x1="${px(todayX)}" y1="${pad}" x2="${px(todayX)}" y2="${pad + innerH}" stroke="${FLARE}" stroke-width="1" opacity="0.5"/>` : '';
  const baseline = `<line x1="${pad}" y1="${pad + innerH}" x2="${w - pad}" y2="${pad + innerH}" stroke="${GRID}"/>`;
  return `<svg width="100%" viewBox="0 0 ${w} ${h}" role="img" aria-hidden="true">${baseline}${ceiling}${todayMarker}${curve}${projection}</svg>`;
}

/** Horizontal funnel: each stage a bar scaled to the first stage. */
export function funnel(stages: Array<{ label: string; count: number }>, opts: { width?: number } = {}): string {
  const w = opts.width ?? 520; const rowH = 34; const labelW = 130;
  const max = Math.max(...stages.map((s) => s.count), 1);
  const barMax = w - labelW - 60;
  const rows = stages.map((s, i) => {
    const bw = (s.count / max) * barMax;
    const y = i * rowH;
    return `<text x="0" y="${y + 21}" font-size="12" fill="${NAVY}">${escapeXml(s.label)}</text>` +
      `<rect x="${labelW}" y="${y + 8}" width="${px(Math.max(bw, 1))}" height="18" fill="${NAVY}" opacity="${1 - i * 0.12}" rx="2"/>` +
      `<text x="${labelW + Math.max(bw, 1) + 6}" y="${y + 21}" font-size="12" fill="${NAVY}" font-weight="600">${s.count}</text>`;
  }).join('');
  return `<svg width="100%" viewBox="0 0 ${w} ${stages.length * rowH}" role="img" aria-hidden="true">${rows}</svg>`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const svgCharts = { sparkline, barChart, bookingCurve, funnel };
