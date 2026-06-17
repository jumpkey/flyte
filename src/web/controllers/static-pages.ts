import type { Context } from 'hono';
import { renderView } from '../render.js';
import { config } from '../../config.js';

/**
 * Static prose pages (V6). A payments site without reachable terms/privacy
 * reads as a scam; the footer links them, the refund policy lives on /terms and
 * is excerpted on event detail + checkout.
 */
export const staticController = {
  async about(c: Context): Promise<Response> {
    return renderView(c, 'static/about', { title: 'About' });
  },
  async contact(c: Context): Promise<Response> {
    return renderView(c, 'static/contact', { title: 'Contact', contactEmail: config.smtp.from });
  },
  async terms(c: Context): Promise<Response> {
    return renderView(c, 'static/terms', { title: 'Terms' });
  },
  async privacy(c: Context): Promise<Response> {
    return renderView(c, 'static/privacy', { title: 'Privacy' });
  },
};
