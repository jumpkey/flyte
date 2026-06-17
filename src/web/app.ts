import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import { serveStatic } from '@hono/node-server/serve-static';
import pino from 'pino';
import { renderView } from './render.js';
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
import { adminRegistrationsController } from './controllers/admin/registrations.js';
import { adminRefundsController } from './controllers/admin/refunds.js';
import { adminUsersController } from './controllers/admin/users.js';
import { adminActivityController } from './controllers/admin/activity.js';
import { adminAnalyticsController } from './controllers/admin/analytics.js';
import { refundRequestController } from './controllers/refund-request.js';
import { accountController } from './controllers/account.js';
import { findRegistrationController } from './controllers/find-registration.js';
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

const logger = pino({ level: 'info' });

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
// Public uploaded-graphic serve (D1) — registered before :eventId detail.
app.get('/events/:eventId/image', adminEventsController.image);
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
app.get('/admin/events/:id/roster.csv', adminGuard, adminEventsController.rosterCsv);
app.get('/admin/events/:id/waitlist.csv', adminGuard, adminEventsController.waitlistCsv);
app.post('/admin/events/:id', adminGuard, adminEventsController.update);
app.post('/admin/events/:id/cancel', adminGuard, adminEventsController.cancel);

// Admin transactions + refund execution (I5). The .csv export is registered
// before the :id detail route so it isn't captured as a registration id.
app.get('/admin/registrations.csv', adminGuard, adminRegistrationsController.exportCsv);
app.get('/admin/registrations', adminGuard, adminRegistrationsController.list);
app.get('/admin/registrations/:id', adminGuard, adminRegistrationsController.detail);
app.post('/admin/registrations/:id/refund', adminGuard, adminRegistrationsController.refund);

// Refund request queue (I6).
app.get('/admin/refund-requests', adminGuard, adminRefundsController.queue);
app.post('/admin/refund-requests/:id/approve', adminGuard, adminRefundsController.approve);
app.post('/admin/refund-requests/:id/deny', adminGuard, adminRefundsController.deny);

// Admin users & activity (I8).
app.get('/admin/users', adminGuard, adminUsersController.list);
app.get('/admin/users/:id', adminGuard, adminUsersController.detail);
app.post('/admin/users/:id/lock', adminGuard, adminUsersController.lock);
app.post('/admin/users/:id/unlock', adminGuard, adminUsersController.unlock);
app.get('/admin/activity', adminGuard, adminActivityController.list);

// Analytics (I10).
app.get('/admin/analytics', adminGuard, adminAnalyticsController.dashboard);
app.get('/admin/events/:id/performance', adminGuard, adminAnalyticsController.eventPerformance);

app.get('/dashboard', authGuard, dashboardController.index);
// My Registrations (I7) — ownership-checked account pages.
app.get('/account/registrations', authGuard, accountController.registrations);
app.get('/account/registrations/:id', authGuard, accountController.registrationDetail);
app.post('/account/waitlist/:id/remove', authGuard, accountController.removeWaitlist);
app.get('/profile', authGuard, profileController.editForm);
app.post('/profile', authGuard, profileController.update);
app.post('/logout', authGuard, authController.logout);

// Registration routes — rate limit POSTs that create Stripe PaymentIntents,
// confirm payments, or insert waitlist rows to prevent abuse.
app.get('/events/:eventId/register', registrationController.showRegistrationForm);
app.post('/events/:eventId/register', rateLimit(60, 60000), registrationController.initiateRegistration);
app.post('/registration/confirm/:paymentIntentId', rateLimit(60, 60000), registrationController.confirmRegistration);
app.get('/registration/:registrationId/confirmed', registrationController.showConfirmed);
// Add-to-calendar (V2) — capability URL.
app.get('/registration/:registrationId/calendar.ics', registrationController.calendarIcs);
// Find my registration (V1) — public guest recovery, RL(5) on submit.
app.get('/find-registration', findRegistrationController.form);
app.post('/find-registration', rateLimit(5, 60000), findRegistrationController.submit);
// Refund request (J4 / I6) — capability URL from the confirmation page. RL(5) on file.
app.get('/registration/:id/refund-request', refundRequestController.form);
app.post('/registration/:id/refund-request', rateLimit(5, 60000), refundRequestController.create);
app.get('/events/:eventId/waitlist', registrationController.showWaitlistForm);
app.post('/events/:eventId/waitlist', rateLimit(60, 60000), registrationController.addToWaitlist);
// Live waitlist position (V7) — capability URL from the waitlist email.
app.get('/waitlist/:waitlistEntryId', registrationController.showWaitlistPosition);

// Styled 404 + 500 (I9). Admin/JSON callers still get plain text where it matters
// (adminGuard answers c.notFound() which lands here as a styled page — acceptable,
// the route simply doesn't exist for them).
app.notFound((c) => renderView(c, 'error', {
  title: 'Page not found', code: 404, heading: 'Page not found',
  message: "We couldn't find that page. It may have moved, or the link may be incomplete.",
}, { status: 404 }));

app.onError((err, c) => {
  logger.error({ err, path: c.req.path }, 'unhandled error');
  return renderView(c, 'error', {
    title: 'Something went wrong', code: 500, heading: 'Something went wrong',
    message: 'An unexpected error occurred. Please try again — if it keeps happening, let us know.',
  }, { status: 500 });
});

export { app };
