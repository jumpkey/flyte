import { sql } from './db.js';

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  isVerified: boolean;
  isAdmin: boolean;
  isLocked: boolean;
  failedLoginCount: number;
  verificationToken: string | null;
  verificationTokenExpiresAt: Date | null;
  passwordResetToken: string | null;
  passwordResetTokenExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
}

function mapUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    email: row.email as string,
    passwordHash: row.password_hash as string,
    displayName: row.display_name as string,
    isVerified: row.is_verified as boolean,
    isAdmin: row.is_admin as boolean,
    isLocked: row.is_locked as boolean,
    failedLoginCount: row.failed_login_count as number,
    verificationToken: row.verification_token as string | null,
    verificationTokenExpiresAt: row.verification_token_expires_at as Date | null,
    passwordResetToken: row.password_reset_token as string | null,
    passwordResetTokenExpiresAt: row.password_reset_token_expires_at as Date | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
    lastLoginAt: row.last_login_at as Date | null,
  };
}

export const userService = {
  async createUser(email: string, displayName: string, passwordHash: string, verificationToken: string): Promise<User> {
    const rows = await sql`
      INSERT INTO users (email, display_name, password_hash, verification_token, verification_token_expires_at)
      VALUES (${email}, ${displayName}, ${passwordHash}, ${verificationToken}, NOW() + INTERVAL '24 hours')
      RETURNING *
    `;
    return mapUser(rows[0] as Record<string, unknown>);
  },

  async findByEmail(email: string): Promise<User | null> {
    const rows = await sql`SELECT * FROM users WHERE LOWER(email) = LOWER(${email})`;
    if (rows.length === 0) return null;
    return mapUser(rows[0] as Record<string, unknown>);
  },

  async findById(id: string): Promise<User | null> {
    const rows = await sql`SELECT * FROM users WHERE id = ${id}`;
    if (rows.length === 0) return null;
    return mapUser(rows[0] as Record<string, unknown>);
  },

  async findByVerificationToken(tokenHash: string): Promise<User | null> {
    const rows = await sql`SELECT * FROM users WHERE verification_token = ${tokenHash} AND verification_token_expires_at > NOW()`;
    if (rows.length === 0) return null;
    return mapUser(rows[0] as Record<string, unknown>);
  },

  async findByPasswordResetToken(tokenHash: string): Promise<User | null> {
    const rows = await sql`SELECT * FROM users WHERE password_reset_token = ${tokenHash} AND password_reset_token_expires_at > NOW()`;
    if (rows.length === 0) return null;
    return mapUser(rows[0] as Record<string, unknown>);
  },

  async verifyUser(id: string): Promise<void> {
    await sql`UPDATE users SET is_verified = TRUE, verification_token = NULL, verification_token_expires_at = NULL WHERE id = ${id}`;
  },

  async updateProfile(id: string, fields: { displayName?: string; passwordHash?: string }): Promise<void> {
    if (fields.displayName !== undefined && fields.passwordHash !== undefined) {
      await sql`UPDATE users SET display_name = ${fields.displayName}, password_hash = ${fields.passwordHash} WHERE id = ${id}`;
    } else if (fields.displayName !== undefined) {
      await sql`UPDATE users SET display_name = ${fields.displayName} WHERE id = ${id}`;
    } else if (fields.passwordHash !== undefined) {
      await sql`UPDATE users SET password_hash = ${fields.passwordHash} WHERE id = ${id}`;
    }
  },

  async setPasswordResetToken(id: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await sql`UPDATE users SET password_reset_token = ${tokenHash}, password_reset_token_expires_at = ${expiresAt} WHERE id = ${id}`;
  },

  async resetPassword(id: string, newPasswordHash: string): Promise<void> {
    await sql`UPDATE users SET password_hash = ${newPasswordHash}, password_reset_token = NULL, password_reset_token_expires_at = NULL, is_locked = FALSE, failed_login_count = 0 WHERE id = ${id}`;
  },

  async updateLastLogin(id: string): Promise<void> {
    await sql`UPDATE users SET last_login_at = NOW() WHERE id = ${id}`;
  },

  async incrementFailedLogins(id: string): Promise<void> {
    await sql`UPDATE users SET failed_login_count = failed_login_count + 1 WHERE id = ${id}`;
  },

  async resetFailedLogins(id: string): Promise<void> {
    await sql`UPDATE users SET failed_login_count = 0 WHERE id = ${id}`;
  },

  async lockAccount(id: string): Promise<void> {
    await sql`UPDATE users SET is_locked = TRUE WHERE id = ${id}`;
  },

  async isEmailTaken(email: string): Promise<boolean> {
    const rows = await sql`SELECT 1 FROM users WHERE LOWER(email) = LOWER(${email})`;
    return rows.length > 0;
  },
};
