#!/usr/bin/env bash
# Set the Stripe (and seed-admin) secrets on the Fly app.
# Fill in the values below and run. Do not commit real keys.
set -euo pipefail

APP=flyte

STRIPE_SECRET_KEY='REPLACE_ME'
STRIPE_PUBLISHABLE_KEY='REPLACE_ME'
STRIPE_WEBHOOK_SECRET='REPLACE_ME'
SEED_ADMIN_PASSWORD='REPLACE_ME'

case "${STRIPE_SECRET_KEY}${STRIPE_PUBLISHABLE_KEY}${STRIPE_WEBHOOK_SECRET}${SEED_ADMIN_PASSWORD}" in
  *REPLACE_ME*)
    echo "Edit $0 and fill in the placeholder values first." >&2
    exit 1
    ;;
esac

flyctl secrets set -a "$APP" \
  STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY" \
  STRIPE_PUBLISHABLE_KEY="$STRIPE_PUBLISHABLE_KEY" \
  STRIPE_WEBHOOK_SECRET="$STRIPE_WEBHOOK_SECRET" \
  SEED_ADMIN_PASSWORD="$SEED_ADMIN_PASSWORD"

flyctl secrets list -a "$APP"
