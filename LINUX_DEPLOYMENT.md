# Flyte — Standalone Linux Deployment Guide

This guide covers deploying Flyte on a standalone Linux server as an alternative to fly.io. Instructions include specific notes for **Ubuntu/Debian** and **Red Hat-based** distributions (RHEL, Fedora, CentOS Stream, AlmaLinux, Rocky Linux).

---

## Prerequisites

You need a Linux server with:

- A non-root user with `sudo` privileges
- A public IP address or domain name pointing to the server
- Ports **80** and **443** open in your firewall/security group

---

## Part 1: Install System Dependencies

### 1a. Update the system

**Ubuntu / Debian:**

```bash
sudo apt update && sudo apt upgrade -y
```

**Red Hat / Fedora / AlmaLinux / Rocky Linux:**

```bash
sudo dnf update -y
```

---

### 1b. Install Node.js 20

The recommended approach is to use the [NodeSource](https://github.com/nodesource/distributions) repository so you get an up-to-date LTS release.

**Ubuntu / Debian:**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

**Red Hat / Fedora / AlmaLinux / Rocky Linux:**

```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo -E bash -
sudo dnf install -y nodejs
```

Verify the installation:

```bash
node --version   # should print v20.x.x
npm --version
```

---

### 1c. Install PostgreSQL

**Ubuntu / Debian:**

```bash
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql
```

**Red Hat / Fedora / AlmaLinux / Rocky Linux:**

```bash
sudo dnf install -y postgresql-server postgresql-contrib
sudo postgresql-setup --initdb
sudo systemctl enable --now postgresql
```

> **RHEL note:** `postgresql-setup --initdb` initialises the data directory the first time. Skip this command if you already have an initialised cluster.

---

### 1d. Install Git and supporting tools

**Ubuntu / Debian:**

```bash
sudo apt install -y git openssl curl
```

**Red Hat / Fedora / AlmaLinux / Rocky Linux:**

```bash
sudo dnf install -y git openssl curl
```

---

### 1e. Install Nginx

**Ubuntu / Debian:**

```bash
sudo apt install -y nginx
sudo systemctl enable --now nginx
```

**Red Hat / Fedora / AlmaLinux / Rocky Linux:**

```bash
sudo dnf install -y nginx
sudo systemctl enable --now nginx
```

---

## Part 2: Create the Database

Switch to the `postgres` system user to run `psql`:

```bash
sudo -u postgres psql
```

Inside the `psql` shell, create a dedicated user and database:

```sql
CREATE USER flyte WITH PASSWORD 'choose_a_strong_password';
CREATE DATABASE flyte OWNER flyte;
\q
```

> Replace `choose_a_strong_password` with a strong, unique password. You will use it in the `DATABASE_URL` environment variable later.

Verify the connection from your shell user:

```bash
psql "postgres://flyte:choose_a_strong_password@localhost:5432/flyte" -c "SELECT 1;"
```

---

## Part 3: Deploy the Application

### 3a. Create a system user for the app

Running the application as a dedicated, unprivileged user is a security best practice:

```bash
sudo useradd --system --create-home --shell /bin/bash flyte
```

### 3b. Clone the repository

```bash
sudo -u flyte git clone https://github.com/jumpkey/flyte.git /home/flyte/app
cd /home/flyte/app
```

### 3c. Install dependencies and build

```bash
sudo -u flyte bash -c "cd /home/flyte/app && npm ci"
sudo -u flyte bash -c "cd /home/flyte/app && npm run build"
```

`npm run build` compiles TypeScript to `dist/` and copies EJS templates.

---

## Part 4: Configure Environment Variables

Create a `.env` file in the application directory:

```bash
sudo -u flyte bash -c "cat > /home/flyte/app/.env" <<'EOF'
NODE_ENV=production
PORT=3000
DATABASE_URL=postgres://flyte:choose_a_strong_password@localhost:5432/flyte
SESSION_SECRET=replace_with_64_random_hex_chars
APP_DOMAIN=https://your-domain.example.com
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=your_smtp_api_key
SMTP_FROM=noreply@your-domain.example.com
EOF
```

Generate a strong `SESSION_SECRET`:

```bash
openssl rand -hex 32
```

Copy the output and replace `replace_with_64_random_hex_chars` in `.env`.

Restrict the file's permissions so only the `flyte` user can read it:

```bash
sudo chmod 600 /home/flyte/app/.env
```

> See [Part 7: Environment Variable Reference](#part-7-environment-variable-reference) for a full list of supported variables.

---

## Part 5: Run Migrations and Seed

### 5a. Run database migrations

```bash
sudo -u flyte bash -c "cd /home/flyte/app && npm run migrate"
```

This applies every file in `db/migrations/` in order and records applied migrations in the `schema_migrations` table — already-applied files are skipped on subsequent runs.

### 5b. (Optional) Seed the admin user

```bash
sudo -u flyte bash -c "cd /home/flyte/app && npm run seed"
```

This creates `admin@flyte.local` / `changeme123`. **Change the password immediately** after first login, or override the defaults before seeding:

```bash
sudo -u flyte bash -c "cd /home/flyte/app && SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=s3cure! npm run seed"
```

---

## Part 6: Run Flyte as a systemd Service

Create a systemd unit file so Flyte starts automatically and restarts on failure:

```bash
sudo tee /etc/systemd/system/flyte.service > /dev/null <<'EOF'
[Unit]
Description=Flyte web application
After=network.target postgresql.service

[Service]
Type=simple
User=flyte
WorkingDirectory=/home/flyte/app
EnvironmentFile=/home/flyte/app/.env
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=flyte

[Install]
WantedBy=multi-user.target
EOF
```

Enable and start the service:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now flyte
```

Check the status:

```bash
sudo systemctl status flyte
```

View live logs:

```bash
sudo journalctl -u flyte -f
```

---

## Part 7: Configure Nginx as a Reverse Proxy

Nginx sits in front of Flyte, handles TLS termination, and forwards requests to port 3000.

Create an Nginx server block:

```bash
sudo tee /etc/nginx/sites-available/flyte > /dev/null <<'EOF'
server {
    listen 80;
    server_name your-domain.example.com;

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF
```

> **Red Hat note:** Red Hat-based distros use `/etc/nginx/conf.d/` instead of `sites-available/sites-enabled/`. Place the file at `/etc/nginx/conf.d/flyte.conf` and skip the symlink step below.

Enable the site (Ubuntu/Debian only):

```bash
sudo ln -s /etc/nginx/sites-available/flyte /etc/nginx/sites-enabled/flyte
```

Test and reload Nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

---

## Part 8: Enable HTTPS with Let's Encrypt

Install Certbot:

**Ubuntu / Debian:**

```bash
sudo apt install -y certbot python3-certbot-nginx
```

**Red Hat / Fedora / AlmaLinux / Rocky Linux:**

```bash
sudo dnf install -y certbot python3-certbot-nginx
```

Obtain and install a certificate (replace with your real domain):

```bash
sudo certbot --nginx -d your-domain.example.com
```

Certbot automatically:
1. Obtains a TLS certificate from Let's Encrypt
2. Updates the Nginx configuration to listen on port 443 with TLS
3. Adds a redirect from HTTP to HTTPS

Verify automatic renewal works:

```bash
sudo certbot renew --dry-run
```

Certbot installs a systemd timer (or cron job) that renews certificates before they expire. No further action is needed.

Update `APP_DOMAIN` in `/home/flyte/app/.env` to use `https://`:

```bash
sudo -u flyte sed -i 's|APP_DOMAIN=.*|APP_DOMAIN=https://your-domain.example.com|' /home/flyte/app/.env
sudo systemctl restart flyte
```

---

## Part 9: Configure the Firewall

**Ubuntu / Debian (ufw):**

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

**Red Hat / Fedora / AlmaLinux / Rocky Linux (firewalld):**

```bash
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --reload
sudo firewall-cmd --list-all
```

> Do **not** expose port 3000 publicly — traffic should always pass through Nginx.

---

## Part 10: Environment Variable Reference

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | Yes | Set to `production` |
| `PORT` | No | Defaults to `3000`; must match the Nginx `proxy_pass` port |
| `DATABASE_URL` | Yes | `postgres://<user>:<password>@<host>:<port>/<db>` |
| `SESSION_SECRET` | Yes | 64+ random hex chars; rotate by updating `.env` and restarting |
| `APP_DOMAIN` | Yes | Full URL with scheme, e.g. `https://your-domain.example.com` — used in email links |
| `SMTP_HOST` | Yes | SMTP relay hostname |
| `SMTP_PORT` | Yes | Usually `587` (STARTTLS) or `465` (TLS) in production |
| `SMTP_USER` | No | Leave empty if the relay doesn't require auth |
| `SMTP_PASS` | No | |
| `SMTP_FROM` | Yes | Sender address in verification/reset emails |
| `BCRYPT_ROUNDS` | No | Default `12`; increase for stronger hashing (adds CPU cost) |
| `ACCOUNT_LOCK_THRESHOLD` | No | Default `10` failed logins before lockout |
| `VERIFICATION_TOKEN_TTL_HOURS` | No | Default `24` |
| `PASSWORD_RESET_TOKEN_TTL_HOURS` | No | Default `1` |
| `SEED_ADMIN_EMAIL` | No | Overrides the admin email used by `npm run seed` |
| `SEED_ADMIN_PASSWORD` | No | Overrides the admin password used by `npm run seed` |

---

## Part 11: Updating Flyte

To deploy a new version:

```bash
cd /home/flyte/app

# Pull latest changes as the flyte user
sudo -u flyte git pull

# Install any new dependencies
sudo -u flyte npm ci

# Rebuild the application
sudo -u flyte npm run build

# Apply any new migrations
sudo -u flyte npm run migrate

# Restart the service
sudo systemctl restart flyte
```

Check the service came back up cleanly:

```bash
sudo systemctl status flyte
sudo journalctl -u flyte --since "1 minute ago"
```

---

## Part 12: Common Operations

### View application logs

```bash
# Follow live logs
sudo journalctl -u flyte -f

# Show last 100 lines
sudo journalctl -u flyte -n 100

# Show logs since a specific time
sudo journalctl -u flyte --since "2025-01-01 00:00:00"
```

### Restart the application

```bash
sudo systemctl restart flyte
```

### Stop / start the application

```bash
sudo systemctl stop flyte
sudo systemctl start flyte
```

### Connect to Postgres directly

```bash
psql "postgres://flyte:choose_a_strong_password@localhost:5432/flyte"
```

### Rotate the session secret

```bash
# Generate a new secret
NEW_SECRET=$(openssl rand -hex 32)

# Update .env
sudo -u flyte sed -i "s|SESSION_SECRET=.*|SESSION_SECRET=${NEW_SECRET}|" /home/flyte/app/.env

# Restart to pick up the change (this invalidates all existing sessions)
sudo systemctl restart flyte
```

---

## Troubleshooting

**Service fails to start**
- Check logs: `sudo journalctl -u flyte -n 50 --no-pager`
- Ensure `dist/index.js` exists — if not, run `sudo -u flyte bash -c "cd /home/flyte/app && npm run build"`.
- Verify the `.env` file exists and is readable: `sudo -u flyte cat /home/flyte/app/.env`.

**Cannot connect to PostgreSQL**
- Confirm the service is running: `sudo systemctl status postgresql`.
- Test the connection string directly: `psql "postgres://flyte:<password>@localhost:5432/flyte" -c "SELECT 1;"`.
- On Red Hat systems, check that `pg_hba.conf` allows `md5` or `scram-sha-256` authentication for local connections.

  Locate `pg_hba.conf`:
  ```bash
  sudo -u postgres psql -c "SHOW hba_file;"
  ```
  Ensure there is a line like:
  ```
  host    all             all             127.0.0.1/32            scram-sha-256
  ```
  After editing, reload PostgreSQL: `sudo systemctl reload postgresql`.

**502 Bad Gateway from Nginx**
- The Flyte service may not be running: `sudo systemctl status flyte`.
- Confirm the app is listening on port 3000: `ss -tlnp | grep 3000`.
- Check the Nginx error log: `sudo tail -n 50 /var/log/nginx/error.log`.

**Emails not arriving**
- Verify your SMTP settings in `.env` are correct.
- Check that your server's outbound port 587 (or 465) is not blocked by the hosting provider.
- For testing, use a local mail catcher such as [Mailhog](https://github.com/mailhog/MailHog) (`SMTP_HOST=localhost`, `SMTP_PORT=1025`).

**Sessions lost after restart**
- Sessions are stored in the `sessions` Postgres table and survive restarts.
- If you're seeing unexpected logouts, check that `SESSION_SECRET` has not changed since the sessions were created.

**SELinux blocking Nginx → Node connection (Red Hat systems)**
- If Nginx returns a 502 and the Flyte service is running, SELinux may be preventing the proxy connection.
- Allow Nginx to make network connections:
  ```bash
  sudo setsebool -P httpd_can_network_connect 1
  ```
