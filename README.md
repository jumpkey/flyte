# Flyte

Flyte is a full-stack TypeScript web application that implements a complete user-account lifecycle. It is designed as a production-ready starting point for any project that needs secure user authentication out of the box.

---

## What Flyte does

Once deployed, Flyte gives end users the following workflow:

1. **Register** — create an account with an email address, display name, and password.
2. **Verify email** — click the verification link sent to the registered address to activate the account.
3. **Log in** — authenticate with email and password; repeated failures trigger an account lock.
4. **Dashboard** — a personalized home screen that serves as the entry point for future feature modules.
5. **Edit profile** — update display name or change password from a single form, with inline HTMX feedback.
6. **Reset a forgotten password** — request a time-limited reset link by email, set a new password, and log back in.
7. **Log out** — invalidate the session securely.

All state-changing actions are protected by CSRF tokens. Login attempts, registrations, and profile changes are recorded in an audit event log backed by PostgreSQL.

---

## Technology stack

| Concern | Choice |
|---|---|
| Runtime | Node.js 20 LTS |
| Language | TypeScript 5 (strict mode) |
| Web framework | [Hono](https://hono.dev/) |
| Templating | EJS (server-rendered HTML) |
| UI interactivity | [HTMX](https://htmx.org/) — no client-side framework |
| CSS | [Pico CSS](https://picocss.com/) (classless) |
| Database | PostgreSQL |
| Database driver | [postgres.js](https://github.com/porsager/postgres) |
| Password hashing | bcrypt (cost >= 12) |
| Sessions | Cookie-based, Postgres-backed |
| Email | Nodemailer (SMTP) |
| Logging | pino (structured JSON) |

---

## Repository layout

```
flyte/
├── db/
│   └── migrations/          # Sequential SQL migration files (001_…, 002_…)
├── public/                  # Static assets (CSS, client-side JS)
├── scripts/
│   ├── migrate.ts           # Migration runner  (npm run migrate)
│   └── seed.ts              # Admin user seeder (npm run seed)
├── src/
│   ├── config.ts            # Centralised env-var config
│   ├── index.ts             # Process entry point
│   ├── services/            # Data services layer (auth, email, users, events)
│   └── web/
│       ├── app.ts           # Hono app, middleware, route registration
│       ├── controllers/     # Route handlers
│       └── views/           # EJS templates
├── .env.example             # Environment variable template
├── Dockerfile               # Multi-stage production image
├── fly.toml                 # fly.io app configuration
├── DEPLOYMENT.md            # fly.io deployment guide
├── LINUX_DEPLOYMENT.md      # Standalone Linux server deployment guide
└── SPECIFICATION.md         # Full project specification (source of truth)
```

---

## Quick start (local development)

**Prerequisites:** Node.js 20, PostgreSQL running on `localhost:5432`.

```bash
# 1. Install dependencies
npm install

# 2. Copy and configure environment variables
cp .env.example .env
# Edit .env — at minimum set DATABASE_URL and SESSION_SECRET

# 3. Create the database (if it doesn't exist yet)
createdb flyte

# 4. Run migrations
npm run migrate

# 5. (Optional) Seed the admin user
npm run seed        # creates admin@flyte.local / changeme123

# 6. Start the dev server with hot-reload
npm run dev         # listens on http://localhost:3000
```

---

## Deployment

| Target | Guide |
|---|---|
| [fly.io](https://fly.io) (managed, zero-ops) | [DEPLOYMENT.md](DEPLOYMENT.md) |
| Self-hosted Linux (Ubuntu, Debian, RHEL, Fedora …) | [LINUX_DEPLOYMENT.md](LINUX_DEPLOYMENT.md) |

---

## Key npm scripts

| Script | What it does |
|---|---|
| `npm run dev` | Start dev server with hot-reload (requires local Postgres) |
| `npm run build` | Compile TypeScript → `dist/`; copy EJS views |
| `npm start` | Run the compiled production build |
| `npm run migrate` | Apply pending SQL migrations |
| `npm run seed` | Seed the default admin user |
