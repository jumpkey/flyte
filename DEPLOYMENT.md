# Flyte — fly.io Deployment Guide

This guide covers the complete lifecycle of deploying Flyte on [fly.io](https://fly.io): from the very first bootstrap through iterative updates (new pages, schema migrations, and other improvements).

---

## Prerequisites

- [fly CLI installed](https://fly.io/docs/flyctl/install/) and authenticated (`fly auth login`)
- A fly.io account
- The repository cloned locally
- `openssl` available in your shell (for secret generation)

---

## Part 1: Bootstrap Deployment

Run these steps once when setting up the project for the first time.

### 1. Create the fly.io app

```bash
fly launch --no-deploy
```

- When prompted, accept or customise the app name (this becomes `<app>.fly.dev`).
- Choose your preferred primary region (e.g. `lhr` for London, `iad` for Virginia).
- Answer **No** to creating a Postgres database — you'll do that in the next step.
- Answer **No** to deploying now.

`fly launch` writes (or updates) `fly.toml`. Commit any changes it makes:

```bash
git add fly.toml
git commit -m "chore: update fly.toml from fly launch"
```

### 2. Create and attach a Postgres cluster

```bash
# Provision a managed Postgres cluster (free shared tier is fine for a PoC)
fly postgres create --name flyte-db

# Attach the database to your app — this automatically sets the DATABASE_URL secret
fly postgres attach flyte-db --app <your-app-name>
```

`fly postgres attach` prints the `DATABASE_URL` it created and sets it as a fly secret automatically.

### 3. Set required secrets

```bash
# Strong session secret — must be at least 64 random hex characters
fly secrets set SESSION_SECRET=$(openssl rand -hex 32) --app <your-app-name>

# Public-facing domain (used in verification/reset email links)
fly secrets set APP_DOMAIN=https://<your-app-name>.fly.dev --app <your-app-name>

# SMTP — example shown for SendGrid; replace with your provider
fly secrets set SMTP_HOST=smtp.sendgrid.net --app <your-app-name>
fly secrets set SMTP_PORT=587 --app <your-app-name>
fly secrets set SMTP_USER=apikey --app <your-app-name>
fly secrets set SMTP_PASS=<your-sendgrid-api-key> --app <your-app-name>
fly secrets set SMTP_FROM=noreply@<your-app-name>.fly.dev --app <your-app-name>
```

> **Dev/staging with Mailhog**: If you want to capture email in a staging environment instead of sending real mail, set `SMTP_HOST` to your Mailhog instance and `SMTP_PORT=1025`. You can also deploy a Mailhog container on fly.io as a private service.

Confirm all secrets are registered:

```bash
fly secrets list --app <your-app-name>
```

### 4. Run database migrations

Migrations are run from your local machine against the fly.io Postgres instance via the fly proxy.

```bash
# Open a WireGuard tunnel to the Postgres cluster
fly proxy 5433:5432 --app flyte-db &

# Run migrations through the tunnel
DATABASE_URL=postgres://flyte:<password>@localhost:5433/flyte npm run migrate
```

> The password is printed when you run `fly postgres attach` and is also available via:
> ```bash
> fly secrets list --app <your-app-name>   # shows DATABASE_URL
> ```

Alternatively, use a one-off fly machine to run migrations in-cluster — this is cleaner for CI/CD:

```bash
fly ssh console --app <your-app-name> --command "node dist/index.js" 2>/dev/null || true
# Or run migrations as a release command (see Part 2 below)
```

### 5. (Optional) Seed the admin user

```bash
DATABASE_URL=postgres://flyte:<password>@localhost:5433/flyte npm run seed
```

This creates `admin@flyte.local` / `changeme123`. Change the password immediately after first login or use the `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` env vars to override.

### 6. Deploy

```bash
fly deploy --app <your-app-name>
```

fly.io will:
1. Build the Docker image using the multi-stage `Dockerfile`
2. Push it to the fly registry
3. Swap the running machine to the new image with zero downtime

Once the deploy finishes, visit `https://<your-app-name>.fly.dev`.

---

## Part 2: Automating Migrations on Every Deploy

Rather than running migrations manually, add a `[deploy]` release command to `fly.toml`. fly.io runs this command inside a temporary machine before swapping traffic to the new version, so the schema is always up to date before the app code goes live.

```toml
# fly.toml — add this section
[deploy]
  release_command = "node dist/index.js --migrate"
```

Because `dist/index.js` is the app entry point (not a migration runner), the cleaner approach is to compile `scripts/migrate.ts` into the image and call it directly:

```toml
[deploy]
  release_command = "node dist/scripts/migrate.js"
```

Ensure the `build` script in `package.json` compiles the scripts directory:

```json
"build": "tsc && cp -r src/web/views dist/web/views"
```

Update `tsconfig.json` to include `scripts/`:

```jsonc
{
  "include": ["src/**/*", "scripts/**/*"]
}
```

Commit, then every subsequent `fly deploy` automatically migrates before serving traffic.

---

## Part 3: Iterative Improvements — Workflow

Follow this pattern whenever you add new features (pages, tables, API endpoints).

### 3a. Add a new database table

1. **Create a migration file** in `db/migrations/` using the next sequential number:

   ```
   db/migrations/005_create_<table_name>.sql
   ```

   Follow the existing format with `-- migrate:up` / `-- migrate:down` sections.

2. **Test locally** before touching production:

   ```bash
   npm run migrate      # applies the new file; skips already-applied ones
   ```

3. **Deploy** — if you have the release command configured (Part 2), migrations run automatically:

   ```bash
   fly deploy --app <your-app-name>
   ```

   If not, run them manually through the proxy first (see Part 1, step 4).

### 3b. Add a new page

1. Add a controller in `src/web/controllers/<name>.ts`
2. Add an EJS view in `src/web/views/<name>.ejs`
3. Register the route in `src/web/app.ts`
4. Build and test locally:

   ```bash
   npm run dev
   ```

5. Deploy:

   ```bash
   fly deploy --app <your-app-name>
   ```

### 3c. Rename or alter an existing column

Always add a new migration — never edit an existing migration file. fly.io's release command will skip already-applied files via the `schema_migrations` tracking table.

```sql
-- db/migrations/006_rename_display_name.sql

-- migrate:up
ALTER TABLE users RENAME COLUMN display_name TO full_name;

-- migrate:down
ALTER TABLE users RENAME COLUMN full_name TO display_name;
```

---

## Part 4: Common fly.io Operations

### View live logs

```bash
fly logs --app <your-app-name>
```

### SSH into a running machine

```bash
fly ssh console --app <your-app-name>
```

### Scale the app

```bash
# Scale to a larger VM
fly scale vm shared-cpu-1x --memory 512 --app <your-app-name>

# Run multiple machines for high availability
fly scale count 2 --app <your-app-name>
```

### Roll back a broken deploy

```bash
# List recent releases
fly releases --app <your-app-name>

# Roll back to a specific version
fly deploy --image registry.fly.io/<your-app-name>:<version>
```

### Update a secret without redeploying

```bash
fly secrets set SMTP_PASS=<new-key> --app <your-app-name>
# fly automatically restarts machines when secrets change
```

### Connect to Postgres directly

```bash
fly postgres connect --app flyte-db
# or via proxy for local tooling (e.g. psql, TablePlus)
fly proxy 5433:5432 --app flyte-db
psql postgres://flyte:<password>@localhost:5433/flyte
```

---

## Part 5: Environment Variable Reference

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | Yes | Set to `production` automatically by the Dockerfile |
| `PORT` | No | Defaults to `3000`; matches `internal_port` in `fly.toml` |
| `DATABASE_URL` | Yes | Set automatically by `fly postgres attach` |
| `SESSION_SECRET` | Yes | 64+ random hex chars; rotate by setting a new secret |
| `APP_DOMAIN` | Yes | Full URL, e.g. `https://flyte.fly.dev` — used in email links |
| `SMTP_HOST` | Yes | SMTP relay hostname |
| `SMTP_PORT` | Yes | Usually `587` (STARTTLS) or `465` (TLS) in production |
| `SMTP_USER` | No | Leave empty if the relay doesn't require auth |
| `SMTP_PASS` | No | |
| `SMTP_FROM` | Yes | Sender address in verification/reset emails |
| `BCRYPT_ROUNDS` | No | Default `12`; increase for stronger hashing (adds CPU cost) |
| `ACCOUNT_LOCK_THRESHOLD` | No | Default `10` failed logins before lockout |
| `VERIFICATION_TOKEN_TTL_HOURS` | No | Default `24` |
| `PASSWORD_RESET_TOKEN_TTL_HOURS` | No | Default `1` |

---

## Troubleshooting

**Deploy fails at image build**
- Check `fly logs --app <your-app-name>` for TypeScript compiler errors.
- Run `npm run build` locally to reproduce the error before pushing.

**App starts but shows 500 errors**
- A missing or misconfigured secret is the most common cause. Run `fly secrets list` and compare against the table above.
- Check logs: `fly logs --app <your-app-name>`.

**Migrations fail during release**
- The release command runs before traffic is switched, so a migration failure stops the deploy — the old version keeps serving traffic.
- SSH in to inspect: `fly ssh console --app <your-app-name> --command "node dist/scripts/migrate.js"`.
- Fix the migration file locally, run `fly deploy` again.

**Emails not arriving**
- Verify SMTP secrets are correct: `fly secrets list`.
- Check that your SMTP provider allows the `SMTP_FROM` address.
- For testing, temporarily set `SMTP_HOST` to a Mailhog or Mailtrap instance.

**Sessions lost after restart**
- Sessions are stored in the `sessions` Postgres table, so they survive machine restarts.
- If you're seeing unexpected logouts, check that `SESSION_SECRET` hasn't changed (rotating it invalidates all existing sessions).
