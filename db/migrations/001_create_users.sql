-- migrate:up
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    is_verified BOOLEAN NOT NULL DEFAULT FALSE,
    is_admin BOOLEAN NOT NULL DEFAULT FALSE,
    is_locked BOOLEAN NOT NULL DEFAULT FALSE,
    failed_login_count INTEGER NOT NULL DEFAULT 0,
    verification_token VARCHAR(255),
    verification_token_expires_at TIMESTAMPTZ,
    password_reset_token VARCHAR(255),
    password_reset_token_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX users_email_lower_idx ON users (LOWER(email));
CREATE INDEX users_verification_token_idx ON users (verification_token) WHERE verification_token IS NOT NULL;
CREATE INDEX users_password_reset_token_idx ON users (password_reset_token) WHERE password_reset_token IS NOT NULL;

CREATE TRIGGER users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- migrate:down
DROP TRIGGER IF EXISTS users_updated_at ON users;
DROP TABLE IF EXISTS users;
DROP FUNCTION IF EXISTS update_updated_at;
