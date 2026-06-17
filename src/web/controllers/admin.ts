import type { Context } from 'hono';

/**
 * Placeholder admin landing (I1). The real admin dashboard (WF-07) arrives in
 * I5; for now this exists only so adminGuard has a route to protect and the
 * security regression set has a live /admin endpoint to enumerate against.
 */
export const adminController = {
  async index(c: Context): Promise<Response> {
    return c.html('<!doctype html><title>Admin</title><h1>Admin</h1><p>Coming soon.</p>');
  },
};
