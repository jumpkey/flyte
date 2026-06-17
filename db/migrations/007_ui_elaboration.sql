-- migrate:up

-- UI Elaboration foundation (increment I1). Additive, applied once.
-- Implements the data-model delta specified in
-- design/SITE-MAP-AND-STORYBOARD.md §5. Two open questions are intentionally
-- NOT acted on here: Q6 (whether to create shadow rows for unmatched historical
-- guest emails — this migration only binds to accounts that already exist) and
-- Q7 (the optional page_views counter table — deferred until accepted).

-- D1: shadow accounts ------------------------------------------------------
-- password_hash becomes nullable; shadow rows carry NULL and cannot log in.
-- The login path's NULL-hash dummy-compare (auth audit, I1) keeps shadow
-- emails indistinguishable from wrong passwords (S6).
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD COLUMN account_status TEXT NOT NULL DEFAULT 'active'
  CHECK (account_status IN ('shadow', 'active'));
-- Shadow rows: password_hash IS NULL AND account_status = 'shadow'

-- Bind purchases to users (nullable for pre-existing rows) ------------------
ALTER TABLE registrations    ADD COLUMN user_id UUID REFERENCES users(id);
ALTER TABLE waitlist_entries ADD COLUMN user_id UUID REFERENCES users(id);
CREATE INDEX idx_registrations_user ON registrations(user_id);
CREATE INDEX idx_waitlist_user      ON waitlist_entries(user_id);

-- Backfill: bind historical purchases to accounts that already exist.
-- Email match is case-insensitive (registrations store raw email; users have
-- an expression unique index on LOWER(email)).
UPDATE registrations r SET user_id = u.id
  FROM users u WHERE r.user_id IS NULL AND LOWER(r.email) = LOWER(u.email);
UPDATE waitlist_entries w SET user_id = u.id
  FROM users u WHERE w.user_id IS NULL AND LOWER(w.email) = LOWER(u.email);

-- D2 + storefront content --------------------------------------------------
ALTER TABLE events ADD COLUMN image_url TEXT;          -- https URL or NULL (validated in I4)
ALTER TABLE events ADD COLUMN waitlist_enabled BOOLEAN NOT NULL DEFAULT TRUE;  -- D6

-- Event lifecycle gains DRAFT (publicly invisible). The status CHECK is an
-- inline constraint in 005, so it must be dropped and recreated. The
-- constraint name is Postgres's default for an inline column CHECK on
-- events.status: <table>_<column>_check.
ALTER TABLE events DROP CONSTRAINT events_status_check;
ALTER TABLE events ADD CONSTRAINT events_status_check
  CHECK (status IN ('DRAFT', 'OPEN', 'FULL', 'CLOSED', 'CANCELLED'));
-- Engine-managed 'FULL' (auto when available_slots = 0) is untouched;
-- the storefront renders it as "Sold out" + waitlist CTA.

-- Refund request workflow --------------------------------------------------
CREATE TABLE refund_requests (
  request_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id UUID NOT NULL REFERENCES registrations(registration_id),
  user_id         UUID REFERENCES users(id),
  reason          TEXT,
  status          TEXT NOT NULL DEFAULT 'REQUESTED'
                  CHECK (status IN ('REQUESTED','APPROVED','DENIED')),
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  resolved_by     UUID REFERENCES users(id),
  resolution_note TEXT
);
-- At most one open (REQUESTED) request per registration; resolved rows are
-- unconstrained so a denied request can be re-filed.
CREATE UNIQUE INDEX idx_refund_requests_open
  ON refund_requests(registration_id) WHERE status = 'REQUESTED';
CREATE INDEX idx_refund_requests_registration ON refund_requests(registration_id);

-- Analytics & operations structural columns (Document 5 §5) ----------------
ALTER TABLE events ADD COLUMN opened_at TIMESTAMPTZ;        -- set on first DRAFT→OPEN
UPDATE events SET opened_at = created_at WHERE status <> 'DRAFT';
ALTER TABLE registrations ADD COLUMN checked_in_at TIMESTAMPTZ;  -- A6 check-in (Q8)

-- migrate:down

DROP INDEX IF EXISTS idx_refund_requests_registration;
DROP INDEX IF EXISTS idx_refund_requests_open;
DROP TABLE IF EXISTS refund_requests;

ALTER TABLE registrations DROP COLUMN IF EXISTS checked_in_at;
ALTER TABLE events        DROP COLUMN IF EXISTS opened_at;

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_status_check;
ALTER TABLE events ADD CONSTRAINT events_status_check
  CHECK (status IN ('OPEN', 'FULL', 'CANCELLED', 'CLOSED'));

ALTER TABLE events DROP COLUMN IF EXISTS waitlist_enabled;
ALTER TABLE events DROP COLUMN IF EXISTS image_url;

DROP INDEX IF EXISTS idx_waitlist_user;
DROP INDEX IF EXISTS idx_registrations_user;
ALTER TABLE waitlist_entries DROP COLUMN IF EXISTS user_id;
ALTER TABLE registrations    DROP COLUMN IF EXISTS user_id;

ALTER TABLE users DROP COLUMN IF EXISTS account_status;
-- Note: password_hash NOT NULL is intentionally NOT restored on down — doing
-- so would fail if any shadow rows exist. Re-add manually if required.
