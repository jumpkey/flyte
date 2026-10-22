-- migrate:up

-- Administrative suspension is distinct from the temporary lock caused by
-- repeated failed logins. Password reset may clear the latter, never the former.
ALTER TABLE users ADD COLUMN is_admin_suspended BOOLEAN NOT NULL DEFAULT FALSE;
-- Existing locked accounts cannot be reliably classified as failed-login
-- locks or administrative suspensions. Preserve their conservative admin lock
-- until an administrator explicitly reviews and unlocks them.
UPDATE users SET is_admin_suspended = TRUE WHERE is_locked = TRUE;

-- migrate:down

ALTER TABLE users DROP COLUMN IF EXISTS is_admin_suspended;
