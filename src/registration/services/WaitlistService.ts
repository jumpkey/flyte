import { sql } from '../../services/db.js';
import type { IWaitlistService } from '../interfaces.js';
import type { WaitlistEntry, WaitlistFormData, EventId, WaitlistEntryId } from '../types.js';

function mapRow(row: Record<string, unknown>): WaitlistEntry {
  return {
    waitlistEntryId: row['waitlist_entry_id'] as string,
    eventId:         row['event_id'] as string,
    email:           row['email'] as string,
    firstName:       row['first_name'] as string,
    lastName:        row['last_name'] as string,
    phone:           row['phone'] as string | null,
    createdAt:       row['created_at'] as Date,
  };
}

export class WaitlistService implements IWaitlistService {
  async addToWaitlist(formData: WaitlistFormData): Promise<WaitlistEntry> {
    const existing = await sql`
      SELECT * FROM waitlist_entries WHERE event_id = ${formData.eventId}::UUID AND email = ${formData.email}
    `;
    if (existing.length > 0) return mapRow(existing[0] as Record<string, unknown>);

    const rows = await sql`
      INSERT INTO waitlist_entries (event_id, email, first_name, last_name, phone)
      VALUES (${formData.eventId}::UUID, ${formData.email}, ${formData.firstName}, ${formData.lastName}, ${formData.phone ?? null})
      RETURNING *
    `;
    return mapRow(rows[0] as Record<string, unknown>);
  }

  async getWaitlist(eventId: EventId): Promise<WaitlistEntry[]> {
    const rows = await sql`
      SELECT * FROM waitlist_entries WHERE event_id = ${eventId}::UUID ORDER BY created_at ASC
    `;
    return (rows as Record<string, unknown>[]).map(mapRow);
  }

  async getWaitlistPosition(eventId: EventId, email: string): Promise<number | null> {
    const rows = await sql<Array<{rn: string}>>`
      SELECT rn FROM (
        SELECT email, ROW_NUMBER() OVER (ORDER BY created_at ASC) as rn
        FROM waitlist_entries WHERE event_id = ${eventId}::UUID
      ) sub WHERE email = ${email}
    `;
    if (rows.length === 0) return null;
    return parseInt(rows[0].rn, 10);
  }

  async removeFromWaitlist(waitlistEntryId: WaitlistEntryId): Promise<boolean> {
    const rows = await sql`
      DELETE FROM waitlist_entries WHERE waitlist_entry_id = ${waitlistEntryId}::UUID RETURNING waitlist_entry_id
    `;
    return rows.length > 0;
  }
}
