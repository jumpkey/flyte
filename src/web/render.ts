import ejs from 'ejs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Context } from 'hono';
import type { SessionData } from './middleware/session.js';
import type { User } from '../services/user-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VIEWS_DIR = path.resolve(__dirname, 'views');

export async function renderView(c: Context, view: string, data: Record<string, unknown> = {}): Promise<Response> {
  const session = (c.get('session') as SessionData | undefined) ?? {};

  let flashMessage: string | null = null;
  if (session.flashMessage) {
    flashMessage = session.flashMessage;
    session.flashMessage = undefined;
  }

  const viewData = {
    ...data,
    csrfToken: session.csrfToken ?? '',
    flashMessage,
    user: (c.get('user') as User | undefined) ?? null,
  };

  const content = await ejs.renderFile(path.join(VIEWS_DIR, `${view}.ejs`), viewData);
  const html = await ejs.renderFile(path.join(VIEWS_DIR, 'layouts/main.ejs'), {
    ...viewData,
    body: content,
  });
  return c.html(html);
}
