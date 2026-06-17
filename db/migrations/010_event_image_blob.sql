-- migrate:up

-- D1: admin-uploaded event graphic stored inline as a Postgres BYTEA blob, an
-- alternative to the existing image_url. The bytes are validated by magic-byte
-- sniff and size-capped before storage; the served Content-Type is derived from
-- the sniff (image_mime), never from the client. A present blob takes precedence
-- over image_url on the storefront. Both columns are nullable: NULL blob means
-- "no uploaded graphic" (fall back to image_url, then the styled fallback).
ALTER TABLE events ADD COLUMN IF NOT EXISTS image_blob BYTEA;
ALTER TABLE events ADD COLUMN IF NOT EXISTS image_mime TEXT;

-- migrate:down

ALTER TABLE events DROP COLUMN IF EXISTS image_mime;
ALTER TABLE events DROP COLUMN IF EXISTS image_blob;
