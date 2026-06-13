import { sql } from './db.js';

export const eventService = {
  async logLogin(params: {
    userId?: string | null;
    emailAttempted: string;
    success: boolean;
    failureReason?: string | null;
    ipAddress: string;
    userAgent?: string | null;
  }): Promise<void> {
    await sql`
      INSERT INTO login_events (user_id, email_attempted, success, failure_reason, ip_address, user_agent)
      VALUES (${params.userId ?? null}, ${params.emailAttempted}, ${params.success}, ${params.failureReason ?? null}, ${params.ipAddress}, ${params.userAgent ?? null})
    `;
  },

  async logAction(params: {
    userId: string;
    sessionId?: string | null;
    action: string;
    resource?: string | null;
    metadata?: Record<string, unknown> | null;
    ipAddress: string;
  }): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await sql`
      INSERT INTO user_action_events (user_id, session_id, action, resource, metadata, ip_address)
      VALUES (${params.userId}, ${params.sessionId ?? null}, ${params.action}, ${params.resource ?? null}, ${params.metadata ? sql.json(params.metadata as any) : null}, ${params.ipAddress})
    `;
  },

  async listUpcomingPublic(limit = 6): Promise<Array<Record<string, unknown>>> {
    const rows = await sql`
      SELECT event_id, name, description, event_date, location,
             total_capacity, available_slots, registration_fee_cents, status
      FROM events
      WHERE status IN ('OPEN', 'FULL') AND event_date > now()
      ORDER BY event_date ASC
      LIMIT ${limit}
    `;
    return rows as unknown as Array<Record<string, unknown>>;
  },
};
