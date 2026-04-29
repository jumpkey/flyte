import type { Context } from 'hono';
import crypto from 'crypto';
import pino from 'pino';
import { renderView } from '../render.js';
import { userService } from '../../services/user-service.js';
import { authService } from '../../services/auth-service.js';
import { eventService } from '../../services/event-service.js';
import { createSession, destroySession, destroyUserSessions } from '../middleware/session.js';
import type { SessionData } from '../middleware/session.js';
import { config } from '../../config.js';
import { getClientIp } from '../utils/get-client-ip.js';

const logger = pino({ level: 'info' });

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export const authController = {
  async loginForm(c: Context): Promise<Response> {
    const session = c.get('session') as SessionData | undefined;
    if (session?.userId) return c.redirect('/dashboard');
    return renderView(c, 'login', { title: 'Sign In' });
  },

  async login(c: Context): Promise<Response> {
    const body = (c.get('parsedBody') as Record<string, string | File> | undefined) ?? await c.req.parseBody();
    const email = ((body['email'] as string) ?? '').trim().toLowerCase();
    const password = (body['password'] as string) ?? '';
    const ip = getClientIp(c);
    const userAgent = c.req.header('user-agent') ?? null;

    const user = await userService.findByEmail(email);

    if (!user) {
      await eventService.logLogin({ emailAttempted: email, success: false, failureReason: 'user_not_found', ipAddress: ip, userAgent });
      return renderView(c, 'login', { title: 'Sign In', error: 'Invalid email or password' });
    }

    const passwordValid = await authService.verifyPassword(password, user.passwordHash);

    if (!passwordValid || !user.isVerified || user.isLocked) {
      let failureReason = 'invalid_password';
      if (!user.isVerified) failureReason = 'not_verified';
      else if (user.isLocked) failureReason = 'locked';

      await eventService.logLogin({ userId: user.id, emailAttempted: email, success: false, failureReason, ipAddress: ip, userAgent });

      if (!passwordValid && !user.isLocked) {
        await userService.incrementFailedLogins(user.id);
        const updated = await userService.findById(user.id);
        if (updated && updated.failedLoginCount >= config.accountLockThreshold) {
          await userService.lockAccount(user.id);
        }
      }

      return renderView(c, 'login', { title: 'Sign In', error: 'Invalid email or password' });
    }

    await userService.resetFailedLogins(user.id);
    await userService.updateLastLogin(user.id);
    await eventService.logLogin({ userId: user.id, emailAttempted: email, success: true, ipAddress: ip, userAgent });

    const session = c.get('session') as SessionData | undefined;
    const { signedSid, sid } = await createSession({ userId: user.id, csrfToken: session?.csrfToken }, user.id);
    c.set('sessionId', sid);
    c.set('session', { userId: user.id, csrfToken: session?.csrfToken });
    c.set('sessionCookie', signedSid);

    return c.redirect('/dashboard');
  },

  async registerForm(c: Context): Promise<Response> {
    const session = c.get('session') as SessionData | undefined;
    if (session?.userId) return c.redirect('/dashboard');
    return renderView(c, 'register', { title: 'Create Account' });
  },

  async register(c: Context): Promise<Response> {
    const body = (c.get('parsedBody') as Record<string, string | File> | undefined) ?? await c.req.parseBody();
    const ip = getClientIp(c);
    const email = ((body['email'] as string) ?? '').trim().toLowerCase();
    const displayName = ((body['displayName'] as string) ?? '').trim();
    const password = (body['password'] as string) ?? '';
    const confirmPassword = (body['confirmPassword'] as string) ?? '';

    const errors: string[] = [];
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Valid email is required');
    if (!displayName || displayName.length < 2) errors.push('Display name must be at least 2 characters');
    if (!password || password.length < 8) errors.push('Password must be at least 8 characters');
    if (password !== confirmPassword) errors.push('Passwords do not match');

    if (errors.length > 0) {
      return renderView(c, 'register', { title: 'Create Account', errors, formData: { email, displayName } });
    }

    const taken = await userService.isEmailTaken(email);
    if (taken) {
      return renderView(c, 'register', { title: 'Create Account', errors: ['Email is already registered'], formData: { email, displayName } });
    }

    const passwordHash = await authService.hashPassword(password);
    const { raw, hashed } = authService.generateToken();

    const newUser = await userService.createUser(email, displayName, passwordHash, hashed);

    try {
      await authService.sendVerificationEmail(email, raw);
    } catch (err) {
      logger.error({ err }, 'Failed to send verification email');
    }

    await eventService.logAction({
      userId: newUser.id,
      sessionId: null,
      action: 'registration',
      resource: '/register',
      ipAddress: ip,
    });

    return renderView(c, 'verify-email-sent', { title: 'Check Your Email', email });
  },

  async verifyEmail(c: Context): Promise<Response> {
    const token = c.req.query('token') ?? '';
    if (!token) {
      return renderView(c, 'verify-email-error', { title: 'Verification Failed', error: 'Invalid verification link' });
    }

    const hashed = hashToken(token);
    const user = await userService.findByVerificationToken(hashed);
    if (!user) {
      return renderView(c, 'verify-email-error', { title: 'Verification Failed', error: 'Invalid or expired verification link' });
    }

    await userService.verifyUser(user.id);

    await eventService.logAction({
      userId: user.id,
      sessionId: null,
      action: 'email_verified',
      resource: '/verify-email',
      ipAddress: getClientIp(c),
    });

    const session = c.get('session') as SessionData | undefined;
    const { signedSid, sid } = await createSession({ userId: user.id, csrfToken: session?.csrfToken }, user.id);
    c.set('sessionId', sid);
    c.set('session', { userId: user.id, csrfToken: session?.csrfToken });
    c.set('sessionCookie', signedSid);

    return c.redirect('/dashboard');
  },

  async checkEmail(c: Context): Promise<Response> {
    const body = (c.get('parsedBody') as Record<string, string | File> | undefined) ?? await c.req.parseBody();
    const email = ((body['email'] as string) ?? '').trim().toLowerCase();

    if (!email) {
      return c.html('<span></span>');
    }

    const taken = await userService.isEmailTaken(email);
    if (taken) {
      return c.html('<span style="color: red;">&#x2717; Email already registered</span>');
    }
    return c.html('<span style="color: green;">&#x2713; Email available</span>');
  },

  async forgotPasswordForm(c: Context): Promise<Response> {
    return renderView(c, 'forgot-password', { title: 'Forgot Password' });
  },

  async forgotPassword(c: Context): Promise<Response> {
    const body = (c.get('parsedBody') as Record<string, string | File> | undefined) ?? await c.req.parseBody();
    const email = ((body['email'] as string) ?? '').trim().toLowerCase();

    const start = Date.now();
    const ip = getClientIp(c);
    const user = await userService.findByEmail(email);
    if (user && user.isVerified && !user.isLocked) {
      const { raw, hashed } = authService.generateToken();
      const expiresAt = new Date(Date.now() + config.passwordResetTokenTtlHours * 60 * 60 * 1000);
      await userService.setPasswordResetToken(user.id, hashed, expiresAt);
      try {
        await authService.sendPasswordResetEmail(email, raw);
      } catch (err) {
        logger.error({ err }, 'Failed to send password reset email');
      }
      await eventService.logAction({
        userId: user.id,
        sessionId: c.get('sessionId') as string | null,
        action: 'password_reset_requested',
        resource: '/forgot-password',
        ipAddress: ip,
      });
    }

    const elapsed = Date.now() - start;
    const minTime = 200 + Math.random() * 300;
    if (elapsed < minTime) {
      await new Promise(resolve => setTimeout(resolve, minTime - elapsed));
    }

    return renderView(c, 'forgot-password-sent', { title: 'Check Your Email' });
  },

  async resetPasswordForm(c: Context): Promise<Response> {
    const token = c.req.query('token') ?? '';
    if (!token) {
      return renderView(c, 'reset-password-error', { title: 'Reset Failed', error: 'Invalid reset link' });
    }

    const hashed = hashToken(token);
    const user = await userService.findByPasswordResetToken(hashed);
    if (!user) {
      return renderView(c, 'reset-password-error', { title: 'Reset Failed', error: 'Invalid or expired reset link' });
    }

    return renderView(c, 'reset-password', { title: 'Reset Password', token });
  },

  async resetPassword(c: Context): Promise<Response> {
    const body = (c.get('parsedBody') as Record<string, string | File> | undefined) ?? await c.req.parseBody();
    const token = (body['token'] as string) ?? '';
    const password = (body['password'] as string) ?? '';
    const confirmPassword = (body['confirmPassword'] as string) ?? '';

    if (!token) {
      return renderView(c, 'reset-password-error', { title: 'Reset Failed', error: 'Invalid reset link' });
    }

    const hashed = hashToken(token);
    const user = await userService.findByPasswordResetToken(hashed);
    if (!user) {
      return renderView(c, 'reset-password-error', { title: 'Reset Failed', error: 'Invalid or expired reset link' });
    }

    if (!password || password.length < 8) {
      return renderView(c, 'reset-password', { title: 'Reset Password', token, error: 'Password must be at least 8 characters' });
    }

    if (password !== confirmPassword) {
      return renderView(c, 'reset-password', { title: 'Reset Password', token, error: 'Passwords do not match' });
    }

    const newPasswordHash = await authService.hashPassword(password);
    await userService.resetPassword(user.id, newPasswordHash);
    await destroyUserSessions(user.id);

    await eventService.logAction({
      userId: user.id,
      sessionId: null,
      action: 'password_reset_completed',
      resource: '/reset-password',
      ipAddress: getClientIp(c),
    });

    const session = c.get('session') as SessionData | undefined;
    const newSession: SessionData = { csrfToken: session?.csrfToken, flashMessage: 'Password reset successfully. Please sign in.' };
    const { signedSid, sid } = await createSession(newSession);
    c.set('sessionId', sid);
    c.set('session', newSession);
    c.set('sessionCookie', signedSid);

    return c.redirect('/login');
  },

  async logout(c: Context): Promise<Response> {
    const sessionId = c.get('sessionId') as string | null;
    if (sessionId) {
      await destroySession(sessionId);
    }
    c.set('session', {});
    c.set('sessionId', null);
    const securePart = config.isProduction ? '; Secure' : '';
    c.header('Set-Cookie', `sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${securePart}`);
    return c.redirect('/');
  },
};
