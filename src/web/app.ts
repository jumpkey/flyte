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
import { authGuard } from './middleware/auth-guard.js';
import { rateLimit } from './middleware/rate-limit.js';
import type { SessionData } from './middleware/session.js';
import type { User } from '../services/user-service.js';

type Variables = {
  session: SessionData;
  sessionId: string | null;
  sessionCookie: string | undefined;
  user: User | undefined;
};

const app = new Hono<{ Variables: Variables }>();

app.use('*', secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", 'https://unpkg.com'],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
    imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
    fontSrc: ["'self'", 'https://cdn.jsdelivr.net'],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
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

app.use('/public/*', serveStatic({ root: './' }));

export { app };
