-- migrate:up
CREATE TABLE login_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    email_attempted VARCHAR(255) NOT NULL,
    success BOOLEAN NOT NULL,
    failure_reason VARCHAR(50),
    ip_address INET NOT NULL,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX login_events_user_id_idx ON login_events (user_id, created_at DESC);
CREATE INDEX login_events_email_idx ON login_events (email_attempted, created_at DESC);

-- migrate:down
DROP TABLE IF EXISTS login_events;
