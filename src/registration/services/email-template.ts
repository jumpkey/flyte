/**
 * Shared transactional-email layout (WK §9). Table-based, fully inline styles,
 * 600px max width, system font stack (clients don't load Inter), navy header
 * band with the wordmark, white body, muted footer, at most one flare-deep CTA.
 * Email is exempt from the CSP, so inline styles are correct here (WK-CODE-2).
 *
 * Callers pass already-safe HTML for `bodyHtml` (user strings must be escaped by
 * the caller via escapeHtml — WK-EML-3 / S4).
 */

const NAVY = '#1F3A5F';
const INK = '#0F172A';
const MUTED = '#64748B';
const CANVAS = '#F8FAFC';
const BORDER = '#E2E8F0';
const FLARE = '#C2410C';
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export interface EmailParts { html: string; text: string }

export function wrapEmail(opts: {
  heading: string;
  bodyHtml: string;
  cta?: { label: string; url: string };
  preheader?: string;
}): string {
  const ctaBlock = opts.cta
    ? `<tr><td style="padding:8px 32px 28px 32px;">
         <a href="${opts.cta.url}" style="display:inline-block;background-color:${FLARE};color:#ffffff;text-decoration:none;font-family:${FONT};font-size:15px;font-weight:700;padding:12px 22px;border-radius:8px;">${opts.cta.label}</a>
       </td></tr>`
    : '';
  const preheader = opts.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${opts.preheader}</div>`
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background-color:${CANVAS};">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${CANVAS};">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background-color:#ffffff;border:1px solid ${BORDER};border-radius:12px;overflow:hidden;">
      <tr><td style="background-color:${NAVY};padding:18px 32px;">
        <span style="font-family:${FONT};font-size:20px;font-weight:800;color:#ffffff;">Flyte<span style="color:${FLARE};">.</span></span>
      </td></tr>
      <tr><td style="padding:28px 32px 8px 32px;font-family:${FONT};">
        <h1 style="margin:0 0 12px 0;font-size:20px;font-weight:700;color:${INK};">${opts.heading}</h1>
        <div style="font-size:15px;line-height:1.55;color:${INK};">${opts.bodyHtml}</div>
      </td></tr>
      ${ctaBlock}
      <tr><td style="padding:18px 32px;border-top:1px solid ${BORDER};font-family:${FONT};font-size:12px;color:${MUTED};">
        Flyte · Secure checkout powered by Stripe. This is a transactional message about your registration.
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}
