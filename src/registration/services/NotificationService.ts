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

export class NotificationService implements INotificationService {
  async sendRegistrationConfirmation(registration: RegistrationRecord, eventName: string): Promise<void> {
    const amount = formatCents(registration.grossAmountCents);
    await transporter.sendMail({
      from: config.smtp.from,
      to: registration.email,
      subject: `Registration Confirmed: ${eventName}`,
      html: `
        <h2>Registration Confirmed!</h2>
        <p>Dear ${registration.firstName} ${registration.lastName},</p>
        <p>Your registration for <strong>${eventName}</strong> has been confirmed.</p>
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
        <p>Dear ${entry.firstName} ${entry.lastName},</p>
        <p>You are #${position} on the waitlist for <strong>${eventName}</strong>.</p>
        <p>If a spot opens up, we will contact you at this email address. No payment is required at this time.</p>
      `,
      text: `You're on the Waitlist\n\nDear ${entry.firstName} ${entry.lastName},\n\nYou are #${position} on the waitlist for ${eventName}.\n\nIf a spot opens up, we will contact you. No payment is required at this time.`,
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
        <p>Dear ${registration.firstName} ${registration.lastName},</p>
        <p>A refund of <strong>${amount}</strong> has been issued for your registration to <strong>${eventName}</strong>.</p>
        <p><strong>Registration ID:</strong> ${registration.registrationId}</p>
        <p>Please allow 5–10 business days for the refund to appear on your statement.</p>
      `,
      text: `Refund Processed\n\nDear ${registration.firstName} ${registration.lastName},\n\nA refund of ${amount} has been issued for your registration to ${eventName}.\n\nRegistration ID: ${registration.registrationId}\n\nPlease allow 5-10 business days for the refund to appear on your statement.`,
    });
  }
}
