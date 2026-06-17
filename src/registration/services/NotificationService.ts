import nodemailer from 'nodemailer';
import { config } from '../../config.js';
import type { INotificationService } from '../interfaces.js';
import type { RegistrationRecord, WaitlistEntry } from '../types.js';
import { wrapEmail } from './email-template.js';

const transporter = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
});

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// Registrant-supplied fields (and event names) are interpolated into HTML
// email bodies; escape them so markup in a name field cannot inject content
// into mail sent from our trusted sender address (WK-EML-3 / S4).
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const P = 'margin:0 0 12px 0;';
function row(label: string, value: string): string {
  return `<tr><td style="padding:6px 0;color:#64748B;font-size:13px;">${label}</td><td style="padding:6px 0;text-align:right;font-variant-numeric:tabular-nums;font-weight:600;">${value}</td></tr>`;
}

export class NotificationService implements INotificationService {
  async sendRegistrationConfirmation(registration: RegistrationRecord, eventName: string): Promise<void> {
    const amount = formatCents(registration.grossAmountCents);
    const url = `${config.appDomain}/registration/${registration.registrationId}/confirmed`;
    const bodyHtml = `
      <p style="${P}">Dear ${escapeHtml(registration.firstName)} ${escapeHtml(registration.lastName)},</p>
      <p style="${P}">Your registration for <strong>${escapeHtml(eventName)}</strong> is confirmed.</p>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px 0;border-top:1px solid #E2E8F0;border-bottom:1px solid #E2E8F0;">
        ${row('Amount paid', amount)}
        ${row('Registration ID', registration.registrationId)}
      </table>
      <p style="${P}">Plans changed? You can request a refund any time before the event from your confirmation page.</p>`;
    await transporter.sendMail({
      from: config.smtp.from,
      to: registration.email,
      subject: `Registration confirmed: ${eventName}`,
      html: wrapEmail({ heading: 'Registration confirmed', bodyHtml, cta: { label: 'View your registration', url }, preheader: `You're registered for ${eventName}` }),
      text: `Registration confirmed: ${eventName}\n\nDear ${registration.firstName} ${registration.lastName},\n\nYour registration for ${eventName} is confirmed.\n\nAmount paid: ${amount}\nRegistration ID: ${registration.registrationId}\n\nView your registration: ${url}`,
    });
  }

  async sendWaitlistAcknowledgement(entry: WaitlistEntry, position: number, eventName: string): Promise<void> {
    const url = `${config.appDomain}/waitlist/${entry.waitlistEntryId}`;
    const bodyHtml = `
      <p style="${P}">Dear ${escapeHtml(entry.firstName)} ${escapeHtml(entry.lastName)},</p>
      <p style="${P}">You are <strong>#${position}</strong> on the waitlist for <strong>${escapeHtml(eventName)}</strong>.</p>
      <p style="${P}">If a spot opens up we'll email you. No payment is required at this time.</p>`;
    await transporter.sendMail({
      from: config.smtp.from,
      to: entry.email,
      subject: `You're on the waitlist: ${eventName}`,
      html: wrapEmail({ heading: "You're on the waitlist", bodyHtml, cta: { label: 'Check your live position', url } }),
      text: `You're on the Waitlist\n\nDear ${entry.firstName} ${entry.lastName},\n\nYou are #${position} on the waitlist for ${eventName}.\n\nIf a spot opens up, we will contact you. No payment is required at this time.\n\nCheck your live position: ${url}`,
    });
  }

  async sendRefundConfirmation(registration: RegistrationRecord, refundedAmountCents: number, eventName: string): Promise<void> {
    const amount = formatCents(refundedAmountCents);
    const bodyHtml = `
      <p style="${P}">Dear ${escapeHtml(registration.firstName)} ${escapeHtml(registration.lastName)},</p>
      <p style="${P}">A refund of <strong>${amount}</strong> has been issued for your registration to <strong>${escapeHtml(eventName)}</strong>.</p>
      <p style="${P}">Registration ID: ${registration.registrationId}. Please allow 5–10 business days for it to appear on your statement.</p>`;
    await transporter.sendMail({
      from: config.smtp.from,
      to: registration.email,
      subject: `Refund processed: ${eventName}`,
      html: wrapEmail({ heading: 'Refund processed', bodyHtml, cta: { label: 'Browse events', url: `${config.appDomain}/events` } }),
      text: `Refund Processed\n\nDear ${registration.firstName} ${registration.lastName},\n\nA refund of ${amount} has been issued for your registration to ${eventName}.\n\nRegistration ID: ${registration.registrationId}\n\nPlease allow 5-10 business days for the refund to appear on your statement.`,
    });
  }

  /** Customer acknowledgement that a refund request was received (J4). */
  async sendRefundRequestReceived(registration: RegistrationRecord, eventName: string): Promise<void> {
    const url = `${config.appDomain}/registration/${registration.registrationId}/confirmed`;
    const bodyHtml = `
      <p style="${P}">Dear ${escapeHtml(registration.firstName)} ${escapeHtml(registration.lastName)},</p>
      <p style="${P}">We've received your refund request for <strong>${escapeHtml(eventName)}</strong> and will review it shortly. You'll get another email once it's processed.</p>
      <p style="${P}">Registration ID: ${registration.registrationId}</p>`;
    await transporter.sendMail({
      from: config.smtp.from,
      to: registration.email,
      subject: `Refund request received: ${eventName}`,
      html: wrapEmail({ heading: 'Refund request received', bodyHtml, cta: { label: 'View your registration', url } }),
      text: `Refund Request Received\n\nDear ${registration.firstName} ${registration.lastName},\n\nWe've received your refund request for ${eventName} and will review it shortly.\n\nRegistration ID: ${registration.registrationId}`,
    });
  }

  /** Admin alert that a new refund request was filed. The reason is escaped (S4). */
  async sendRefundRequestAdminAlert(registration: RegistrationRecord, eventName: string, reason: string | null): Promise<void> {
    const bodyHtml = `
      <p style="${P}"><strong>Event:</strong> ${escapeHtml(eventName)}</p>
      <p style="${P}"><strong>Customer:</strong> ${escapeHtml(registration.firstName)} ${escapeHtml(registration.lastName)} (${escapeHtml(registration.email)})</p>
      <p style="${P}"><strong>Reason:</strong> ${reason ? escapeHtml(reason) : '<em>none given</em>'}</p>
      <p style="${P}"><strong>Registration ID:</strong> ${registration.registrationId}</p>`;
    await transporter.sendMail({
      from: config.smtp.from,
      to: config.adminEmail,
      subject: `New refund request: ${eventName}`,
      html: wrapEmail({ heading: 'New refund request', bodyHtml, cta: { label: 'Open the refund queue', url: `${config.appDomain}/admin/refund-requests` } }),
      text: `New Refund Request\n\nEvent: ${eventName}\nCustomer: ${registration.firstName} ${registration.lastName} (${registration.email})\nReason: ${reason ?? 'none given'}\nRegistration ID: ${registration.registrationId}`,
    });
  }

  /** Email a guest the confirmation (capability) links for their registrations (V1). */
  async sendRegistrationLinks(email: string, items: Array<{ eventName: string; url: string }>): Promise<void> {
    const listHtml = items.map((i) => `<p style="${P}"><strong>${escapeHtml(i.eventName)}</strong><br><a href="${i.url}" style="color:#C2410C;">${i.url}</a></p>`).join('');
    const listText = items.map((i) => `${i.eventName}: ${i.url}`).join('\n');
    await transporter.sendMail({
      from: config.smtp.from,
      to: email,
      subject: 'Your Flyte registrations',
      html: wrapEmail({ heading: 'Your registrations', bodyHtml: `<p style="${P}">Here are the registrations linked to this email address. Each opens your confirmation and lets you request a refund.</p>${listHtml}` }),
      text: `Your Registrations\n\nHere are your registration links:\n\n${listText}\n\nEach link opens your confirmation and lets you request a refund.`,
    });
  }

  /** Notify the customer that a refund request was denied. The note is escaped (S4). */
  async sendRefundDenied(registration: RegistrationRecord, eventName: string, note: string): Promise<void> {
    const bodyHtml = `
      <p style="${P}">Dear ${escapeHtml(registration.firstName)} ${escapeHtml(registration.lastName)},</p>
      <p style="${P}">After review, we're unable to approve your refund request for <strong>${escapeHtml(eventName)}</strong>.</p>
      <p style="${P}"><strong>Note from our team:</strong> ${escapeHtml(note)}</p>
      <p style="${P}">If you have questions, just reply to this email.</p>`;
    await transporter.sendMail({
      from: config.smtp.from,
      to: registration.email,
      subject: `Update on your refund request: ${eventName}`,
      html: wrapEmail({ heading: 'Refund request update', bodyHtml, cta: { label: 'Contact us', url: `${config.appDomain}/contact` } }),
      text: `Refund Request Update\n\nDear ${registration.firstName} ${registration.lastName},\n\nAfter review, we're unable to approve your refund request for ${eventName}.\n\nNote from our team: ${note}\n\nIf you have questions, just reply to this email.`,
    });
  }
}
