import ejs from 'ejs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Context } from 'hono';
import type { SessionData } from './middleware/session.js';
import type { User } from '../services/user-service.js';
import { viewHelpers } from './view-helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VIEWS_DIR = path.resolve(__dirname, 'views');

interface RenderOptions {
  /** Layout under views/layouts to wrap the view in. Defaults to 'main'. */
  layout?: 'main' | 'admin';
}

export async function renderView(
  c: Context,
  view: string,
  data: Record<string, unknown> = {},
  options: RenderOptions = {},
): Promise<Response> {
  const session = (c.get('session') as SessionData | undefined) ?? {};

  let flashMessage: string | null = null;
  if (session.flashMessage) {
    flashMessage = session.flashMessage;
    session.flashMessage = undefined;
  }

  const viewData = {
    // Shared helpers (statusPill, money, displayStatus) are available to every
    // template and partial as bare locals — the single source of truth for the
    // WK §5 status mapping and money formatting lives in view-helpers.ts.
    ...viewHelpers,
    ...data,
    csrfToken: session.csrfToken ?? '',
    flashMessage,
    user: (c.get('user') as User | undefined) ?? null,
  };

  const layout = options.layout ?? 'main';
  const content = await ejs.renderFile(path.join(VIEWS_DIR, `${view}.ejs`), viewData);
  const html = await ejs.renderFile(path.join(VIEWS_DIR, `layouts/${layout}.ejs`), {
    ...viewData,
    body: content,
  });
  return c.html(html);
}

/**
 * Render a single view (or partial) with no surrounding layout — for HTMX
 * fragment swaps. The shared helpers and csrfToken are still injected so the
 * fragment renders identically to its in-page counterpart.
 */
export async function renderFragment(c: Context, view: string, data: Record<string, unknown> = {}): Promise<Response> {
  const session = (c.get('session') as SessionData | undefined) ?? {};
  const viewData = {
    ...viewHelpers,
    ...data,
    csrfToken: session.csrfToken ?? '',
    user: (c.get('user') as User | undefined) ?? null,
  };
  const content = await ejs.renderFile(path.join(VIEWS_DIR, `${view}.ejs`), viewData);
  return c.html(content);
}
