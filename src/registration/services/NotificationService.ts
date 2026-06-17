import nodemailer from 'nodemailer';
import { config } from '../../config.js';
import type { INotificationService } from '../interfaces.js';
import type { RegistrationRecord, WaitlistEntry } from '../types.js';

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
// into mail sent from our trusted sender address.
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export class NotificationService implements INotificationService {
  async sendRegistrationConfirmation(registration: RegistrationRecord, eventName: string): Promise<void> {
    const amount = formatCents(registration.grossAmountCents);
    await transporter.sendMail({
      from: config.smtp.from,
      to: registration.email,
      subject: `Registration Confirmed: ${eventName}`,
      html: `
        <h2>Registration Confirmed!</h2>
        <p>Dear ${escapeHtml(registration.firstName)} ${escapeHtml(registration.lastName)},</p>
        <p>Your registration for <strong>${escapeHtml(eventName)}</strong> has been confirmed.</p>
        <ul>
          <li><strong>Registration ID:</strong> ${registration.registrationId}</li>
          <li><strong>Amount Charged:</strong> ${amount}</li>
        </ul>
        <p>If you need to cancel, please contact us with your Registration ID. Full refunds are available subject to our cancellation policy.</p>
        <p>Thank you!</p>
      `,
      text: `Registration Confirmed!\n\nDear ${registration.firstName} ${registration.lastName},\n\nYour registration for ${eventName} has been confirmed.\n\nRegistration ID: ${registration.registrationId}\nAmount Charged: ${amount}\n\nIf you need to cancel, please contact us with your Registration ID.`,
    });
  }

  async sendWaitlistAcknowledgement(entry: WaitlistEntry, position: number, eventName: string): Promise<void> {
    await transporter.sendMail({
      from: config.smtp.from,
      to: entry.email,
      subject: `You're on the waitlist: ${eventName}`,
      html: `
        <h2>You're on the Waitlist</h2>
        <p>Dear ${escapeHtml(entry.firstName)} ${escapeHtml(entry.lastName)},</p>
        <p>You are #${position} on the waitlist for <strong>${escapeHtml(eventName)}</strong>.</p>
        <p>If a spot opens up, we will contact you at this email address. No payment is required at this time.</p>
        <p><a href="${config.appDomain}/waitlist/${entry.waitlistEntryId}">Check your live waitlist position</a></p>
      `,
      text: `You're on the Waitlist\n\nDear ${entry.firstName} ${entry.lastName},\n\nYou are #${position} on the waitlist for ${eventName}.\n\nIf a spot opens up, we will contact you. No payment is required at this time.\n\nCheck your live position: ${config.appDomain}/waitlist/${entry.waitlistEntryId}`,
    });
  }

  async sendRefundConfirmation(registration: RegistrationRecord, refundedAmountCents: number, eventName: string): Promise<void> {
    const amount = formatCents(refundedAmountCents);
    await transporter.sendMail({
      from: config.smtp.from,
      to: registration.email,
      subject: `Refund Processed: ${eventName}`,
      html: `
        <h2>Refund Processed</h2>
        <p>Dear ${escapeHtml(registration.firstName)} ${escapeHtml(registration.lastName)},</p>
        <p>A refund of <strong>${amount}</strong> has been issued for your registration to <strong>${escapeHtml(eventName)}</strong>.</p>
        <p><strong>Registration ID:</strong> ${registration.registrationId}</p>
        <p>Please allow 5–10 business days for the refund to appear on your statement.</p>
      `,
      text: `Refund Processed\n\nDear ${registration.firstName} ${registration.lastName},\n\nA refund of ${amount} has been issued for your registration to ${eventName}.\n\nRegistration ID: ${registration.registrationId}\n\nPlease allow 5-10 business days for the refund to appear on your statement.`,
    });
  }

  /** Customer acknowledgement that a refund request was received (J4). */
  async sendRefundRequestReceived(registration: RegistrationRecord, eventName: string): Promise<void> {
    await transporter.sendMail({
      from: config.smtp.from,
      to: registration.email,
      subject: `Refund request received: ${eventName}`,
      html: `
        <h2>Refund Request Received</h2>
        <p>Dear ${escapeHtml(registration.firstName)} ${escapeHtml(registration.lastName)},</p>
        <p>We've received your refund request for <strong>${escapeHtml(eventName)}</strong> and will review it shortly. You'll get another email once it's processed.</p>
        <p><strong>Registration ID:</strong> ${registration.registrationId}</p>
      `,
      text: `Refund Request Received\n\nDear ${registration.firstName} ${registration.lastName},\n\nWe've received your refund request for ${eventName} and will review it shortly.\n\nRegistration ID: ${registration.registrationId}`,
    });
  }

  /** Admin alert that a new refund request was filed. The reason is escaped (S4). */
  async sendRefundRequestAdminAlert(registration: RegistrationRecord, eventName: string, reason: string | null): Promise<void> {
    await transporter.sendMail({
      from: config.smtp.from,
      to: config.adminEmail,
      subject: `New refund request: ${eventName}`,
      html: `
        <h2>New Refund Request</h2>
        <p><strong>Event:</strong> ${escapeHtml(eventName)}</p>
        <p><strong>Customer:</strong> ${escapeHtml(registration.firstName)} ${escapeHtml(registration.lastName)} (${escapeHtml(registration.email)})</p>
        <p><strong>Reason:</strong> ${reason ? escapeHtml(reason) : '<em>none given</em>'}</p>
        <p><strong>Registration ID:</strong> ${registration.registrationId}</p>
      `,
      text: `New Refund Request\n\nEvent: ${eventName}\nCustomer: ${registration.firstName} ${registration.lastName} (${registration.email})\nReason: ${reason ?? 'none given'}\nRegistration ID: ${registration.registrationId}`,
    });
  }

  /** Notify the customer that a refund request was denied. The note is escaped (S4). */
  async sendRefundDenied(registration: RegistrationRecord, eventName: string, note: string): Promise<void> {
    await transporter.sendMail({
      from: config.smtp.from,
      to: registration.email,
      subject: `Update on your refund request: ${eventName}`,
      html: `
        <h2>Refund Request Update</h2>
        <p>Dear ${escapeHtml(registration.firstName)} ${escapeHtml(registration.lastName)},</p>
        <p>After review, we're unable to approve your refund request for <strong>${escapeHtml(eventName)}</strong>.</p>
        <p><strong>Note from our team:</strong> ${escapeHtml(note)}</p>
        <p>If you have questions, just reply to this email.</p>
      `,
      text: `Refund Request Update\n\nDear ${registration.firstName} ${registration.lastName},\n\nAfter review, we're unable to approve your refund request for ${eventName}.\n\nNote from our team: ${note}\n\nIf you have questions, just reply to this email.`,
    });
  }
}
