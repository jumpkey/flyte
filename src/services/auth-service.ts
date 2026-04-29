import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { config } from '../config.js';

const transporter = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
});

export const authService = {
  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, config.bcryptRounds);
  },

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  },

  generateToken(): { raw: string; hashed: string } {
    const raw = crypto.randomBytes(32).toString('hex');
    const hashed = crypto.createHash('sha256').update(raw).digest('hex');
    return { raw, hashed };
  },

  async sendVerificationEmail(email: string, token: string): Promise<void> {
    const url = `${config.appDomain}/verify-email?token=${token}`;
    await transporter.sendMail({
      from: config.smtp.from,
      to: email,
      subject: 'Verify your Flyte account',
      html: `<p>Please verify your email address by clicking the link below:</p><p><a href="${url}">${url}</a></p><p>This link expires in ${config.verificationTokenTtlHours} hour${config.verificationTokenTtlHours !== 1 ? 's' : ''}.</p>`,
      text: `Please verify your email address: ${url}\n\nThis link expires in ${config.verificationTokenTtlHours} hour${config.verificationTokenTtlHours !== 1 ? 's' : ''}.`,
    });
  },

  async sendPasswordResetEmail(email: string, token: string): Promise<void> {
    const url = `${config.appDomain}/reset-password?token=${token}`;
    await transporter.sendMail({
      from: config.smtp.from,
      to: email,
      subject: 'Reset your Flyte password',
      html: `<p>Click the link below to reset your password:</p><p><a href="${url}">${url}</a></p><p>This link expires in 1 hour.</p>`,
      text: `Reset your password: ${url}\n\nThis link expires in 1 hour.`,
    });
  },
};
