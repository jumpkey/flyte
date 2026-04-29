import type { Context } from 'hono';
import { renderView } from '../render.js';
import { userService } from '../../services/user-service.js';
import { authService } from '../../services/auth-service.js';
import { eventService } from '../../services/event-service.js';
import type { User } from '../../services/user-service.js';

export const profileController = {
  async editForm(c: Context): Promise<Response> {
    return renderView(c, 'profile', { title: 'Edit Profile' });
  },

  async update(c: Context): Promise<Response> {
    const body = await c.req.parseBody();
    const displayName = ((body['displayName'] as string) ?? '').trim();
    const currentPassword = (body['currentPassword'] as string) ?? '';
    const newPassword = (body['newPassword'] as string) ?? '';
    const confirmPassword = (body['confirmPassword'] as string) ?? '';

    const user = c.get('user') as User | undefined;
    if (!user) {
      return c.html('<div style="color: red;">Not authenticated</div>');
    }

    const updates: { displayName?: string; passwordHash?: string } = {};
    const errors: string[] = [];

    if (displayName && displayName !== user.displayName) {
      if (displayName.length < 2) {
        errors.push('Display name must be at least 2 characters');
      } else {
        updates.displayName = displayName;
      }
    }

    if (newPassword) {
      if (!currentPassword) {
        errors.push('Current password is required to change password');
      } else {
        const valid = await authService.verifyPassword(currentPassword, user.passwordHash);
        if (!valid) {
          errors.push('Current password is incorrect');
        } else if (newPassword.length < 8) {
          errors.push('New password must be at least 8 characters');
        } else if (newPassword !== confirmPassword) {
          errors.push('Passwords do not match');
        } else {
          updates.passwordHash = await authService.hashPassword(newPassword);
        }
      }
    }

    if (errors.length > 0) {
      return c.html(`<div style="color: red;">${errors.map(e => `<p>${e}</p>`).join('')}</div>`);
    }

    if (Object.keys(updates).length > 0) {
      await userService.updateProfile(user.id, updates);
      const updatedUser = await userService.findById(user.id);
      if (updatedUser) c.set('user', updatedUser);

      const ip = c.req.header('x-forwarded-for') ?? c.req.header('x-real-ip') ?? '127.0.0.1';
      await eventService.logAction({
        userId: user.id,
        sessionId: c.get('sessionId') as string | null,
        action: 'profile_update',
        resource: '/profile',
        ipAddress: ip,
      });
    }

    return c.html('<div style="color: green;">Profile updated successfully</div>');
  },
};
