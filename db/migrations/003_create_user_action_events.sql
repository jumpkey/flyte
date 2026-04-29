-- migrate:up
CREATE TABLE user_action_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    session_id VARCHAR(255),
    action VARCHAR(100) NOT NULL,
    resource VARCHAR(255),
    metadata JSONB,
    ip_address INET NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX user_action_events_user_id_idx ON user_action_events (user_id, created_at DESC);
CREATE INDEX user_action_events_action_idx ON user_action_events (action, created_at DESC);

-- migrate:down
DROP TABLE IF EXISTS user_action_events;
