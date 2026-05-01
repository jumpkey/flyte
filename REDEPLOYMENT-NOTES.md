# Flyte Redeployment Notes

This document captures the full architecture decisions, configuration, and
step-by-step commands to recreate the Flyte deployment stack from scratch.
The current deployment (`flyte`) is a testbed; this checklist targets the
production app recreation.

---

## Architecture Overview

- **5x app machines** — `shared-cpu-1x` / 512MB RAM, Node.js/TypeScript,
  auto-suspend when idle
- **1x Postgres machine** — `shared-cpu-4x` / 1GB RAM, unmanaged
  `postgres-flex`, suspends after 1 hour of no connections via
  `FLY_SCALE_TO_ZERO=1h`
- **Region** — `iad` (Ashburn, VA) for app machines; Postgres currently in
  `ewr` (Newark) — consider aligning to `iad` in production for lower latency
- **Fly proxy** — load balances across app machines, wakes suspended machines
  on incoming requests

### Cost Model

| State | What's running | Cost |
|---|---|---|
| Idle (98% of time) | Nothing | Storage only (~pennies) |
| Warm | Up to 5 app machines + Postgres | Per-second compute |
| Event mode | All 5 machines + Postgres always-on | Full compute, no suspend |

### Cold Start Behavior

- **Suspend/resume** (normal idle): app ~278ms, then DB wake + retry ~2-4s
  total for first request
- **Full cold boot** (first wake after `fly deploy`): app ~1s, DB wake ~2s,
  total 4-5s for first request
- **Subsequent requests** once warm: sub-100ms for DB-hitting endpoints
- The first user after a full idle period absorbs the cold-start cost;
  everyone behind them in a burst gets warm responses

---

## Application Configuration

### fly.toml

```toml
app = '<new-app-name>'
primary_region = 'iad'

[build]

[deploy]
  release_command = 'node dist/scripts/migrate.js'

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = 'suspend'
  auto_start_machines = true
  min_machines_running = 0

  [http_service.checks]
    grace_period = "5s"
    interval = "10s"
    timeout = "5s"
    type = "http"
    path = "/health"
    method = "GET"

[[vm]]
  memory = '512mb'
  cpu_kind = 'shared'
  cpus = 1
```

**Notes:**
- `min_machines_running = 0` — accepts cold-start tradeoff in exchange for
  zero carrying cost when idle
- `cpus = 1` — Node.js is single-threaded; extra CPUs don't help a single
  process
- `auto_stop_machines = 'suspend'` — suspend (not stop) preserves memory
  snapshot for faster resume; same storage-only billing as stopped
- Health check endpoint required — add to your app before deploying:

```typescript
app.get('/health', (req, res) => res.sendStatus(200));
```

---

### Database Connection (db.ts)

```typescript
import postgres from 'postgres';
import { config } from '../config.js';

const CONNECTION_ERRORS = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE']);

const rawSql = postgres(config.databaseUrl, {
  max: 5,               // per-machine pool ceiling; 5 machines x 5 = 25 max connections
  idle_timeout: 10,     // seconds before idle connection closed
  max_lifetime: 60,     // recycle connections every 60 seconds
  connect_timeout: 15,  // generous for cold-chain wake (app + DB both resuming)
});

// retry wrapper handles stale connections after suspend/resume
export async function dbQuery<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    if (CONNECTION_ERRORS.has(err.code)) {
      await new Promise(r => setTimeout(r, 500)); // give Postgres a moment to wake
      return fn();
    }
    throw err;
  }
}

export { rawSql as sql };
```

**Usage in services:**
```typescript
const rows = await dbQuery(sql =>
  sql`SELECT * FROM users WHERE id = ${id}`
);
```

**Notes:**
- `connect_timeout: 15` — allows for both app machine and Postgres machine
  waking simultaneously (cold chain)
- `idle_timeout: 10` — aggressively closes idle connections to minimize stale
  connection errors on resume
- `max_lifetime: 60` — recycles connections frequently given suspend/resume
  cycle
- Retry on `ECONNRESET`/`ECONNREFUSED`/`EPIPE` with 500ms delay handles the
  first-hit-after-idle case transparently; no 500 errors exposed to users
- Do **not** wrap transaction blocks in `dbQuery` — retrying a transaction
  risks double-writes

---

## Redeployment Checklist

### Prerequisites

```sh
# ensure flyctl is current
fly version update

# confirm logged in
fly auth whoami
```

---

### Step 1 — Create the App

```sh
fly apps create <new-app-name>
```

---

### Step 2 — Create the Postgres Instance

```sh
fly pg create \
  --name <new-app-name>-db \
  --region iad \
  --vm-size shared-cpu-4x \
  --volume-size 1 \
  --initial-cluster-size 1
```

> **Save the credentials output.** Username, password, and connection string
> are shown once and not retrievable afterward.

---

### Step 3 — Attach Postgres to the App

```sh
fly pg attach <new-app-name>-db -a <new-app-name>
```

This automatically sets the `DATABASE_URL` secret on the app.

---

### Step 4 — Update Postgres Machine Resources

```sh
# get the machine id
fly machine list -a <new-app-name>-db --json | jq -r '.[].id'

fly machine update <postgres-machine-id> \
  -a <new-app-name>-db \
  --vm-cpus 4 \
  --vm-cpu-kind shared \
  --vm-memory 1024 \
  --yes
```

---

### Step 5 — Set Postgres Scale-to-Zero Window

```sh
fly machine update <postgres-machine-id> \
  -a <new-app-name>-db \
  --env FLY_SCALE_TO_ZERO=1h \
  --yes
```

This is the built-in postgres-flex mechanism that suspends the DB after 1 hour
of no connections. It is separate from fly proxy autostop and is controlled
via this environment variable.

---

### Step 6 — Set App Secrets

```sh
fly secrets set \
  SESSION_SECRET=<value> \
  SMTP_HOST=<value> \
  SMTP_PORT=<value> \
  SMTP_USER=<value> \
  SMTP_PASS=<value> \
  -a <new-app-name>
```

`DATABASE_URL` is already set by Step 3. Add any other secrets your app
requires.

---

### Step 7 — Update fly.toml and Deploy

Edit `fly.toml` — change `app = '<new-app-name>'` and confirm all settings
match the configuration above, then:

```sh
fly deploy
```

The `release_command` runs `node dist/scripts/migrate.js` in a temporary
machine before app machines start. Migrations run against the direct Postgres
connection, not through any pooler.

---

### Step 8 — Scale to 5 Machines

```sh
fly scale count 5 -a <new-app-name>
```

Machine count is operational state, not stored in `fly.toml`. Set it once
after initial deploy; subsequent `fly deploy` runs do not reset it.

---

### Step 9 — Verify

```sh
# app machines
fly machine list -a <new-app-name>

# scale confirmation
fly scale show -a <new-app-name>

# postgres machine state and resources
fly machine list -a <new-app-name>-db --json | \
  jq '.[] | {id: .id, state: .state, guest: .config.guest, env: .config.env}'

# autostop status per app machine
fly machine list -a <new-app-name> --json | \
  jq '.[] | {id: .id, name: .name, autostop: .config.services[0].autostop}'

# secrets present (values not shown)
fly secrets list -a <new-app-name>

# clean logs
fly logs -a <new-app-name>

# health endpoint
curl https://<new-app-name>.fly.dev/health
```

---

## Event Mode

Use this before a registration email blast or any expected traffic spike.
Keeps all machines always-on for the duration of the event, then returns to
suspend-when-idle afterward.

### event-mode.sh

```sh
#!/bin/sh
# Usage: ./event-mode.sh [on|off]
#   on  = all machines always-on, Postgres scale-to-zero disabled
#   off = return to suspend-when-idle mode

APP=<new-app-name>
DB_APP=<new-app-name>-db
MODE=${1:-on}

if [ "$MODE" = "on" ]; then
  echo "Switching to event/always-on mode..."

  DB_MACHINE=$(fly machine list -a $DB_APP --json | jq -r '.[].id')

  # disable Postgres scale-to-zero
  fly machine update $DB_MACHINE -a $DB_APP \
    --env FLY_SCALE_TO_ZERO=off \
    --yes

  # start Postgres
  fly machine start $DB_MACHINE -a $DB_APP

  # set all app machines to always-on and start them
  fly machine list -a $APP --json | jq -r '.[].id' | while read id; do
    fly machine update $id -a $APP \
      --autostop off \
      --yes
    fly machine start $id -a $APP
  done

  echo "Done. Stack is always-on."
  echo "Run '$0 off' to return to suspend mode."

elif [ "$MODE" = "off" ]; then
  echo "Returning to suspend-when-idle mode..."

  DB_MACHINE=$(fly machine list -a $DB_APP --json | jq -r '.[].id')

  # re-enable Postgres scale-to-zero (1 hour idle)
  fly machine update $DB_MACHINE -a $DB_APP \
    --env FLY_SCALE_TO_ZERO=1h \
    --yes

  # return app machines to autosuspend
  fly machine list -a $APP --json | jq -r '.[].id' | while read id; do
    fly machine update $id -a $APP \
      --autostop suspend \
      --yes
  done

  echo "Done. Machines will suspend when idle."

else
  echo "Usage: $0 [on|off]"
  exit 1
fi
```

```sh
chmod +x event-mode.sh
./event-mode.sh on   # run before event
./event-mode.sh off  # run after event
```

> **Warning:** `fly deploy` during an event window resets per-machine autostop
> settings back to `fly.toml` values. If you deploy during an event, re-run
> `./event-mode.sh on` afterward.

---

## Operational Notes

### Checking Machine Status

```sh
# all app machines with autostop status
fly machine list -a <new-app-name> --json | \
  jq '.[] | {id: .id, name: .name, state: .state, autostop: .config.services[0].autostop}'

# postgres env vars (confirms FLY_SCALE_TO_ZERO setting)
fly machine list -a <new-app-name>-db --json | \
  jq '.[] | {id: .id, state: .state, env: .config.env}'

# live postgres connection count (run from inside postgres machine)
fly ssh console -a <new-app-name>-db
# then inside:
psql -c "SELECT count(*), state FROM pg_stat_activity GROUP BY state;"

# postgres config (shared_buffers, max_connections etc)
fly postgres config show -a <new-app-name>-db
```

### After a Deploy (Cold Boot Warning)

The first request after `fly deploy` always triggers a full cold boot rather
than a fast suspend/resume, because the deploy invalidates the Firecracker
memory snapshot. Expected latency on that first request: 4-5 seconds. All
subsequent requests once warm: sub-100ms.

### Postgres Notes

- There is no `fly.toml` for unmanaged Postgres — configuration lives in the
  fly platform and is managed via `fly machine update` commands
- `FLY_SCALE_TO_ZERO` is a postgres-flex built-in; it monitors connection
  activity and suspends the machine after the specified idle duration
- `shared_buffers` is recalculated automatically on restart when memory is
  changed via `fly machine update`
- Scale Postgres VM *up* before adjusting `shared_buffers`; scale *down* after
- The Postgres machine has autostop `null` (not managed by fly proxy) —
  `FLY_SCALE_TO_ZERO` is the correct lever, not `--autostop`

### Connection Pool Sizing

```
5 machines × 5 connections = 25 max connections
Postgres default max_connections = 100
Headroom: 75 connections (reserved for admin, repmgr, health checks etc)
```

At expected peak load (100-200 users over 10 minutes), actual concurrent
connections will be well under 25. Pool sizing is conservative by design.

---

## Key Design Decisions (and Why)

| Decision | Rationale |
|---|---|
| `cpus = 1` per app machine | Node.js is single-threaded; extra CPUs don't benefit a single process |
| 5 machines, not 1 | Distributes event loop load; each machine handles its own concurrent requests independently |
| `auto_stop_machines = 'suspend'` not `'stop'` | Suspend preserves memory snapshot for faster resume; same cost as stopped |
| `min_machines_running = 0` | Accepts first-hit cold-start latency in exchange for zero idle compute cost |
| Pool size 5 per machine | Conservative; well within Postgres limits; queue drain is fast given sub-100ms query times |
| `connect_timeout = 15` | Allows for cold chain (both app and DB waking simultaneously) |
| `idle_timeout = 10` | Aggressively closes idle connections to reduce stale connection errors on resume |
| Retry on ECONNRESET with 500ms delay | Makes first-hit-after-idle transparent to users; no 500 errors |
| `FLY_SCALE_TO_ZERO = 1h` | DB stays warm for an hour after any activity, covering realistic usage bursts |
| Event mode script | Manual toggle for always-on around registration events; avoids carrying cost the rest of the time |
