import { sql } from '../../services/db.js';
import type { IEventAvailabilityService } from '../interfaces.js';
import type { EventId, EventAvailability } from '../types.js';

export class EventAvailabilityService implements IEventAvailabilityService {
  async getAvailability(eventId: EventId): Promise<EventAvailability | null> {
    const rows = await sql<Array<{
      event_id: string;
      total_capacity: number;
      confirmed_count: number;
      available_slots: number;
      status: string;
      updated_at: Date;
    }>>`
      SELECT event_id, total_capacity, confirmed_count, available_slots, status, updated_at
      FROM events
      WHERE event_id = ${eventId}
    `;

    if (rows.length === 0) return null;
    const ev = rows[0];

    const waitlistRows = await sql<Array<{count: string}>>`
      SELECT COUNT(*) as count FROM waitlist_entries WHERE event_id = ${eventId}
    `;

    return {
      eventId:        ev.event_id,
      totalCapacity:  ev.total_capacity,
      confirmedCount: ev.confirmed_count,
      availableSlots: ev.available_slots,
      waitlistCount:  parseInt(waitlistRows[0].count, 10),
      status:         ev.status,
      updatedAt:      ev.updated_at,
    };
  }
}
