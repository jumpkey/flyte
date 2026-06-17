-- migrate:up

-- W18 / R1: storefront view counts. A per-event, per-day COUNTER (not a row per
-- request) so the detail route can upsert-increment with no write amplification,
-- while still supporting date-ranged reads — sum the rows in a window for the
-- analytics funnel's view stage (A1) and the per-event view total (A2). Counts
-- accrue from launch; nothing backfills historical views.
--
-- Deliberately NO foreign key to events: the detail route fires this write
-- un-awaited (best effort), and an FK would take a KEY SHARE lock on the events
-- row on every view, contending with bookings/edits that lock the same row — a
-- needless hot-path lock for a derived counter. event_id is just an index key;
-- orphan rows (after a hard event delete, which the app never does) are
-- harmless analytics dust.
CREATE TABLE IF NOT EXISTS page_views (
    event_id    UUID    NOT NULL,
    view_date   DATE    NOT NULL DEFAULT CURRENT_DATE,
    views       INTEGER NOT NULL DEFAULT 0 CHECK (views >= 0),
    PRIMARY KEY (event_id, view_date)
);

-- Range scans for the dashboard funnel filter by date across all events.
CREATE INDEX IF NOT EXISTS idx_page_views_date ON page_views (view_date);

-- migrate:down

DROP TABLE IF EXISTS page_views;
