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
import { webhookController } from './controllers/webhook.js';
import { authGuard } from './middleware/auth-guard.js';
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
    scriptSrc: ["'self'", 'https://unpkg.com', 'https://js.stripe.com'],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
    imgSrc: ["'self'", 'data:', 'https://*.stripe.com'],
    connectSrc: ["'self'", 'https://api.stripe.com', 'https://js.stripe.com', 'https://hooks.stripe.com'],
    fontSrc: ["'self'", 'https://cdn.jsdelivr.net'],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    frameSrc: ["'self'", 'https://js.stripe.com', 'https://hooks.stripe.com'],
    baseUri: ["'self'"],
  },
  crossOriginEmbedderPolicy: false,
}));
app.use('*', requestLoggerMiddleware);
app.use('*', sessionMiddleware);
app.use('*', csrfMiddleware);

app.get('/', homeController.index);
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

app.get('/dashboard', authGuard, dashboardController.index);
app.get('/profile', authGuard, profileController.editForm);
app.post('/profile', authGuard, profileController.update);
app.post('/logout', authGuard, authController.logout);

// Registration routes
app.get('/events/:eventId/register', registrationController.showRegistrationForm);
app.post('/events/:eventId/register', registrationController.initiateRegistration);
app.post('/registration/confirm/:paymentIntentId', registrationController.confirmRegistration);
app.get('/registration/:registrationId/confirmed', registrationController.showConfirmed);
app.get('/events/:eventId/waitlist', registrationController.showWaitlistForm);
app.post('/events/:eventId/waitlist', registrationController.addToWaitlist);

export { app };
