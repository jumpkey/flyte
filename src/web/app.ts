import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import { sessionMiddleware } from './middleware/session.js';
import { csrfMiddleware } from './middleware/csrf.js';
import { requestLoggerMiddleware } from './middleware/request-logger.js';
import { homeController } from './controllers/home.js';
import { authController } from './controllers/auth.js';
import { dashboardController } from './controllers/dashboard.js';
import { profileController } from './controllers/profile.js';
import { registrationController } from './controllers/registration.js';
import { catalogController } from './controllers/catalog.js';
import { staticController } from './controllers/static-pages.js';
import { webhookController } from './controllers/webhook.js';
import { adminController } from './controllers/admin.js';
import { adminEventsController } from './controllers/admin/events.js';
import { authGuard } from './middleware/auth-guard.js';
import { adminGuard } from './middleware/admin-guard.js';
import { loadUser } from './middleware/load-user.js';
import { rateLimit } from './middleware/rate-limit.js';
import type { SessionData } from './middleware/session.js';
import type { User } from '../services/user-service.js';

type Variables = {
  session: SessionData;
  sessionId: string | null;
  sessionCookie: string | undefined;
  user: User | undefined;
  parsedBody: Record<string, string | File> | undefined;
};

const app = new Hono<{ Variables: Variables }>();

app.use('/public/*', serveStatic({ root: './' }));

// Webhook route MUST be registered before session/csrf middleware
// so it receives the raw unparsed body
app.post('/webhooks/stripe', webhookController.handleStripeWebhook);

app.use('*', secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    // HTMX and the Bootstrap-derived CSS are self-hosted (public/js, public/css)
    // and Inter is self-hosted (public/fonts), so unpkg.com and cdn.jsdelivr.net
    // are off the allowlist entirely (WK-CODE-3). Only Stripe's domains remain.
    scriptSrc: ["'self'", 'https://js.stripe.com'],
    styleSrc: ["'self'", "'unsafe-inline'"],
    // img-src widened to https: for admin-curated event images (D2/S5). Documented
    // tradeoff: a remote image host can see the viewer's IP. Admin-only URLs, and
    // the v2 option is an image proxy.
    imgSrc: ["'self'", 'data:', 'https:'],
    connectSrc: ["'self'", 'https://api.stripe.com', 'https://js.stripe.com', 'https://hooks.stripe.com'],
    fontSrc: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    frameSrc: ["'self'", 'https://js.stripe.com', 'https://hooks.stripe.com'],
    baseUri: ["'self'"],
  },
  crossOriginEmbedderPolicy: false,
}));
app.use('*', requestLoggerMiddleware);
app.use('*', sessionMiddleware);
app.use('*', loadUser);
app.use('*', csrfMiddleware);

app.get('/', homeController.index);
// Public storefront catalog + detail (I2). Detail 404s for DRAFT/CANCELLED.
app.get('/events', catalogController.list);
app.get('/events/:eventId', catalogController.detail);
// Static prose pages (V6)
app.get('/about', staticController.about);
app.get('/contact', staticController.contact);
app.get('/terms', staticController.terms);
app.get('/privacy', staticController.privacy);
app.get('/login', authController.loginForm);
app.post('/login', rateLimit(10, 60000), authController.login);
app.get('/register', authController.registerForm);
app.post('/register', rateLimit(10, 60000), authController.register);
app.get('/verify-email', authController.verifyEmail);
app.post('/api/check-email', rateLimit(20, 60000), authController.checkEmail);
app.get('/forgot-password', authController.forgotPasswordForm);
app.post('/forgot-password', rateLimit(10, 60000), authController.forgotPassword);
app.get('/reset-password', authController.resetPasswordForm);
app.post('/reset-password', rateLimit(10, 60000), authController.resetPassword);

// Admin surface (R1/S1). adminGuard answers 404 for every non-admin; the
// placeholder index is replaced by the WF-07 dashboard in I5.
app.get('/admin', adminGuard, adminController.index);

// Admin events (I4). All gated by adminGuard; POSTs CSRF-protected by middleware.
app.get('/admin/events', adminGuard, adminEventsController.list);
app.get('/admin/events/new', adminGuard, adminEventsController.newForm);
app.post('/admin/events', adminGuard, adminEventsController.create);
app.get('/admin/events/:id', adminGuard, adminEventsController.detail);
app.get('/admin/events/:id/edit', adminGuard, adminEventsController.editForm);
app.post('/admin/events/:id', adminGuard, adminEventsController.update);
app.post('/admin/events/:id/cancel', adminGuard, adminEventsController.cancel);

app.get('/dashboard', authGuard, dashboardController.index);
app.get('/profile', authGuard, profileController.editForm);
app.post('/profile', authGuard, profileController.update);
app.post('/logout', authGuard, authController.logout);

// Registration routes — rate limit POSTs that create Stripe PaymentIntents,
// confirm payments, or insert waitlist rows to prevent abuse.
app.get('/events/:eventId/register', registrationController.showRegistrationForm);
app.post('/events/:eventId/register', rateLimit(60, 60000), registrationController.initiateRegistration);
app.post('/registration/confirm/:paymentIntentId', rateLimit(60, 60000), registrationController.confirmRegistration);
app.get('/registration/:registrationId/confirmed', registrationController.showConfirmed);
app.get('/events/:eventId/waitlist', registrationController.showWaitlistForm);
app.post('/events/:eventId/waitlist', rateLimit(60, 60000), registrationController.addToWaitlist);
// Live waitlist position (V7) — capability URL from the waitlist email.
app.get('/waitlist/:waitlistEntryId', registrationController.showWaitlistPosition);

export { app };
