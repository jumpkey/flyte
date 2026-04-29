-- migrate:up
CREATE TABLE sessions (
    sid VARCHAR(255) PRIMARY KEY,
    sess JSONB NOT NULL,
    expire TIMESTAMPTZ NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX sessions_expire_idx ON sessions (expire);
CREATE INDEX sessions_user_id_idx ON sessions (user_id) WHERE user_id IS NOT NULL;

-- migrate:down
DROP TABLE IF EXISTS sessions;
