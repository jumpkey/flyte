import type { Context } from 'hono';
import { renderView } from '../render.js';
import { sql } from '../../services/db.js';
import { config } from '../../config.js';
import { NotificationService } from '../../registration/services/NotificationService.js';

let _notif: NotificationService | null = null;
function notif(): NotificationService {
  if (!_notif) _notif = new NotificationService();
  return _notif;
}

async function getBody(c: Context): Promise<Record<string, string | File>> {
  return (c.get('parsedBody') as Record<string, string | File> | undefined) ?? await c.req.parseBody();
}

export const findRegistrationController = {
  /** GET /find-registration — the guest recovery form (V1). */
  async form(c: Context): Promise<Response> {
    return renderView(c, 'find-registration', { title: 'Find my registration' });
  },

  /**
   * POST /find-registration — email the confirmation links. Always renders the
   * same "if that address has registrations…" response (anti-enumeration), with
   * the forgot-password timing pad so existence can't be inferred by latency.
   * RL(5) is applied at the route.
   */
  async submit(c: Context): Promise<Response> {
    const start = Date.now();
    const body = await getBody(c);
    const email = String(body['email'] ?? '').trim().toLowerCase();

    if (email && email.includes('@')) {
      const rows = await sql<{ registration_id: string; event_name: string }[]>`
        SELECT r.registration_id, e.name AS event_name
        FROM registrations r JOIN events e ON e.event_id = r.event_id
        WHERE LOWER(r.email) = ${email} AND r.status = 'CONFIRMED'
        ORDER BY e.event_date DESC
      `;
      if (rows.length > 0) {
        const items = rows.map((r) => ({
          eventName: r.event_name,
          url: `${config.appDomain}/registration/${r.registration_id}/confirmed`,
        }));
        try { await notif().sendRegistrationLinks(email, items); } catch (_) { /* best effort */ }
      }
    }

    // Uniform min-time so a hit and a miss take the same wall-clock time (S6).
    const elapsed = Date.now() - start;
    const minTime = 200 + Math.random() * 300;
    if (elapsed < minTime) await new Promise((r) => setTimeout(r, minTime - elapsed));

    return renderView(c, 'find-registration', { title: 'Find my registration', sent: true });
  },
};
