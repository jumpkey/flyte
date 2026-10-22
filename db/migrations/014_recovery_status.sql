-- migrate:up
CREATE TABLE recovery_status (
  name TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  error_count INTEGER NOT NULL DEFAULT 0
);
