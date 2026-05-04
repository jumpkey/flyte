-- migrate:up

CREATE TABLE IF NOT EXISTS events (
    event_id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name                    TEXT        NOT NULL,
    description             TEXT,
    event_date              TIMESTAMPTZ NOT NULL,
    location                TEXT,
    total_capacity          INTEGER     NOT NULL CHECK (total_capacity > 0),
    confirmed_count         INTEGER     NOT NULL DEFAULT 0 CHECK (confirmed_count >= 0),
    available_slots         INTEGER     NOT NULL CHECK (available_slots >= 0),
    registration_fee_cents  INTEGER     NOT NULL CHECK (registration_fee_cents >= 0),
    status                  TEXT        NOT NULL DEFAULT 'OPEN'
                                CHECK (status IN ('OPEN', 'FULL', 'CANCELLED', 'CLOSED')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT capacity_invariant
        CHECK (available_slots + confirmed_count = total_capacity)
);

CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

CREATE TABLE IF NOT EXISTS registrations (
    registration_id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id                    UUID        NOT NULL REFERENCES events(event_id),
    email                       TEXT        NOT NULL,
    first_name                  TEXT        NOT NULL,
    last_name                   TEXT        NOT NULL,
    phone                       TEXT,
    attributes                  JSONB       NOT NULL DEFAULT '{}',
    status                      TEXT        NOT NULL DEFAULT 'PENDING_PAYMENT'
                                    CHECK (status IN (
                                        'PENDING_PAYMENT',
                                        'PENDING_CAPTURE',
                                        'CONFIRMED',
                                        'PAYMENT_FAILED',
                                        'EXPIRED',
                                        'CANCELLED'
                                    )),
    payment_intent_id           TEXT        UNIQUE,
    gross_amount_cents          INTEGER     NOT NULL CHECK (gross_amount_cents >= 0),
    net_amount_cents            INTEGER,
    refunded_amount_cents       INTEGER     NOT NULL DEFAULT 0
                                    CHECK (refunded_amount_cents >= 0),
    stripe_refund_id            TEXT,
    capture_attempt_count       INTEGER     NOT NULL DEFAULT 0,
    last_capture_attempt_at     TIMESTAMPTZ,
    confirmation_email_sent_at  TIMESTAMPTZ,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at                TIMESTAMPTZ,
    cancelled_at                TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_registrations_payment_intent
    ON registrations(payment_intent_id)
    WHERE payment_intent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_registrations_event_email
    ON registrations(event_id, email);

CREATE INDEX IF NOT EXISTS idx_registrations_status
    ON registrations(status);

CREATE INDEX IF NOT EXISTS idx_registrations_pending_payment_created
    ON registrations(created_at)
    WHERE status = 'PENDING_PAYMENT';

CREATE INDEX IF NOT EXISTS idx_registrations_pending_capture
    ON registrations(last_capture_attempt_at NULLS FIRST)
    WHERE status = 'PENDING_CAPTURE';

CREATE INDEX IF NOT EXISTS idx_registrations_email_unsent
    ON registrations(confirmed_at)
    WHERE status = 'CONFIRMED' AND confirmation_email_sent_at IS NULL;

CREATE TABLE IF NOT EXISTS waitlist_entries (
    waitlist_entry_id   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id            UUID        NOT NULL REFERENCES events(event_id),
    email               TEXT        NOT NULL,
    first_name          TEXT        NOT NULL,
    last_name           TEXT        NOT NULL,
    phone               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT waitlist_unique_email_event UNIQUE (event_id, email)
);

CREATE INDEX IF NOT EXISTS idx_waitlist_event_created
    ON waitlist_entries(event_id, created_at ASC);

CREATE TABLE IF NOT EXISTS refund_log (
    refund_log_id       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    registration_id     UUID        NOT NULL REFERENCES registrations(registration_id),
    event_id            UUID        NOT NULL,
    stripe_refund_id    TEXT        NOT NULL,
    refund_type         TEXT        NOT NULL CHECK (refund_type IN ('FULL', 'PARTIAL')),
    amount_cents        INTEGER     NOT NULL CHECK (amount_cents > 0),
    reason              TEXT        NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refund_log_registration ON refund_log(registration_id);
CREATE INDEX IF NOT EXISTS idx_refund_log_event        ON refund_log(event_id);

CREATE OR REPLACE FUNCTION sp_initiate_registration(
    p_event_id              UUID,
    p_email                 TEXT,
    p_first_name            TEXT,
    p_last_name             TEXT,
    p_phone                 TEXT,
    p_attributes            JSONB,
    p_gross_amount_cents    INTEGER,
    p_payment_intent_id     TEXT
)
RETURNS TABLE (
    result_code         TEXT,
    registration_id     UUID
)
LANGUAGE plpgsql AS $$
DECLARE
    v_registration_id   UUID;
    v_existing_count    INTEGER;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM events WHERE event_id = p_event_id) THEN
        RETURN QUERY SELECT 'EVENT_NOT_FOUND'::TEXT, NULL::UUID;
        RETURN;
    END IF;

    SELECT COUNT(*) INTO v_existing_count
    FROM registrations r
    WHERE r.event_id = p_event_id
      AND r.email    = p_email
      AND r.status NOT IN ('PAYMENT_FAILED', 'EXPIRED', 'CANCELLED');

    IF v_existing_count > 0 THEN
        RETURN QUERY SELECT 'ALREADY_REGISTERED'::TEXT, NULL::UUID;
        RETURN;
    END IF;

    v_registration_id := gen_random_uuid();

    INSERT INTO registrations (
        registration_id, event_id, email, first_name, last_name, phone,
        attributes, gross_amount_cents, payment_intent_id, status
    ) VALUES (
        v_registration_id, p_event_id, p_email, p_first_name, p_last_name, p_phone,
        p_attributes, p_gross_amount_cents, p_payment_intent_id, 'PENDING_PAYMENT'
    );

    RETURN QUERY SELECT 'SUCCESS'::TEXT, v_registration_id;
END;
$$;

CREATE OR REPLACE FUNCTION sp_acquire_slot_and_stage_capture(
    p_payment_intent_id TEXT
)
RETURNS TABLE (
    result_code         TEXT,
    registration_id     UUID,
    event_id            UUID,
    email               TEXT,
    first_name          TEXT,
    last_name           TEXT,
    gross_amount_cents  INTEGER
)
LANGUAGE plpgsql AS $$
DECLARE
    v_reg               registrations%ROWTYPE;
    v_available         INTEGER;
BEGIN
    SELECT * INTO v_reg
    FROM registrations
    WHERE registrations.payment_intent_id = p_payment_intent_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'NOT_FOUND'::TEXT,
            NULL::UUID, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::INTEGER;
        RETURN;
    END IF;

    IF v_reg.status IN ('PENDING_CAPTURE', 'CONFIRMED') THEN
        RETURN QUERY SELECT 'IDEMPOTENT_REPLAY'::TEXT,
            v_reg.registration_id, v_reg.event_id, v_reg.email,
            v_reg.first_name, v_reg.last_name, v_reg.gross_amount_cents;
        RETURN;
    END IF;

    IF v_reg.status IN ('EXPIRED', 'CANCELLED', 'PAYMENT_FAILED') THEN
        RETURN QUERY SELECT 'INVALID_STATE'::TEXT,
            v_reg.registration_id, v_reg.event_id, v_reg.email,
            v_reg.first_name, v_reg.last_name, v_reg.gross_amount_cents;
        RETURN;
    END IF;

    SELECT e.available_slots INTO v_available
    FROM events e
    WHERE e.event_id = v_reg.event_id
    FOR UPDATE;

    IF v_available <= 0 THEN
        UPDATE registrations r
        SET status     = 'PAYMENT_FAILED',
            updated_at = now()
        WHERE r.registration_id = v_reg.registration_id;

        RETURN QUERY SELECT 'AVAILABILITY_EXHAUSTED'::TEXT,
            v_reg.registration_id, v_reg.event_id, v_reg.email,
            v_reg.first_name, v_reg.last_name, v_reg.gross_amount_cents;
        RETURN;
    END IF;

    UPDATE events e
    SET available_slots = e.available_slots - 1,
        confirmed_count = e.confirmed_count + 1,
        status          = CASE WHEN e.available_slots - 1 = 0 THEN 'FULL' ELSE e.status END,
        updated_at      = now()
    WHERE e.event_id = v_reg.event_id;

    UPDATE registrations r
    SET status     = 'PENDING_CAPTURE',
        updated_at = now()
    WHERE r.registration_id = v_reg.registration_id;

    RETURN QUERY SELECT 'SLOT_ACQUIRED'::TEXT,
        v_reg.registration_id, v_reg.event_id, v_reg.email,
        v_reg.first_name, v_reg.last_name, v_reg.gross_amount_cents;
END;
$$;

CREATE OR REPLACE FUNCTION sp_finalize_registration(
    p_payment_intent_id TEXT,
    p_net_amount_cents  INTEGER
)
RETURNS TABLE (
    result_code     TEXT,
    registration_id UUID,
    event_id        UUID,
    email           TEXT,
    first_name      TEXT,
    last_name       TEXT
)
LANGUAGE plpgsql AS $$
DECLARE
    v_reg registrations%ROWTYPE;
BEGIN
    SELECT * INTO v_reg
    FROM registrations
    WHERE registrations.payment_intent_id = p_payment_intent_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'NOT_FOUND'::TEXT,
            NULL::UUID, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::TEXT;
        RETURN;
    END IF;

    IF v_reg.status = 'CONFIRMED' THEN
        RETURN QUERY SELECT 'IDEMPOTENT_REPLAY'::TEXT,
            v_reg.registration_id, v_reg.event_id, v_reg.email,
            v_reg.first_name, v_reg.last_name;
        RETURN;
    END IF;

    IF v_reg.status != 'PENDING_CAPTURE' THEN
        RETURN QUERY SELECT 'INVALID_STATE'::TEXT,
            v_reg.registration_id, v_reg.event_id, v_reg.email,
            v_reg.first_name, v_reg.last_name;
        RETURN;
    END IF;

    UPDATE registrations r
    SET status           = 'CONFIRMED',
        net_amount_cents = p_net_amount_cents,
        confirmed_at     = now(),
        updated_at       = now()
    WHERE r.registration_id = v_reg.registration_id;

    RETURN QUERY SELECT 'SUCCESS'::TEXT,
        v_reg.registration_id, v_reg.event_id, v_reg.email,
        v_reg.first_name, v_reg.last_name;
END;
$$;

CREATE OR REPLACE FUNCTION sp_restore_slot_on_capture_failure(
    p_payment_intent_id TEXT
)
RETURNS TABLE (
    result_code TEXT
)
LANGUAGE plpgsql AS $$
DECLARE
    v_reg registrations%ROWTYPE;
BEGIN
    SELECT * INTO v_reg
    FROM registrations
    WHERE payment_intent_id = p_payment_intent_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'NOT_FOUND'::TEXT;
        RETURN;
    END IF;

    IF v_reg.status != 'PENDING_CAPTURE' THEN
        RETURN QUERY SELECT 'INVALID_STATE'::TEXT;
        RETURN;
    END IF;

    UPDATE events
    SET available_slots = available_slots + 1,
        confirmed_count = confirmed_count - 1,
        status          = CASE WHEN status = 'FULL' THEN 'OPEN' ELSE status END,
        updated_at      = now()
    WHERE event_id = v_reg.event_id;

    UPDATE registrations
    SET status     = 'PAYMENT_FAILED',
        updated_at = now()
    WHERE registration_id = v_reg.registration_id;

    RETURN QUERY SELECT 'SUCCESS'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION sp_increment_capture_attempt(
    p_registration_id UUID
)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE registrations
    SET capture_attempt_count   = capture_attempt_count + 1,
        last_capture_attempt_at = now(),
        updated_at              = now()
    WHERE registration_id = p_registration_id
      AND status           = 'PENDING_CAPTURE';
END;
$$;

CREATE OR REPLACE FUNCTION sp_fail_registration(
    p_payment_intent_id TEXT
)
RETURNS TABLE (
    result_code     TEXT,
    registration_id UUID
)
LANGUAGE plpgsql AS $$
DECLARE
    v_reg registrations%ROWTYPE;
BEGIN
    SELECT * INTO v_reg
    FROM registrations
    WHERE registrations.payment_intent_id = p_payment_intent_id;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'NOT_FOUND'::TEXT, NULL::UUID;
        RETURN;
    END IF;

    IF v_reg.status IN ('PAYMENT_FAILED', 'EXPIRED') THEN
        RETURN QUERY SELECT 'IDEMPOTENT_REPLAY'::TEXT, v_reg.registration_id;
        RETURN;
    END IF;

    UPDATE registrations r
    SET status = 'PAYMENT_FAILED', updated_at = now()
    WHERE r.registration_id = v_reg.registration_id;

    RETURN QUERY SELECT 'SUCCESS'::TEXT, v_reg.registration_id;
END;
$$;

CREATE OR REPLACE FUNCTION sp_expire_registration(
    p_registration_id UUID
)
RETURNS TABLE (
    result_code       TEXT,
    payment_intent_id TEXT
)
LANGUAGE plpgsql AS $$
DECLARE
    v_reg registrations%ROWTYPE;
BEGIN
    SELECT * INTO v_reg
    FROM registrations
    WHERE registrations.registration_id = p_registration_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'NOT_FOUND'::TEXT, NULL::TEXT;
        RETURN;
    END IF;

    IF v_reg.status != 'PENDING_PAYMENT' THEN
        RETURN QUERY SELECT 'INVALID_STATE'::TEXT, v_reg.payment_intent_id;
        RETURN;
    END IF;

    UPDATE registrations r
    SET status = 'EXPIRED', updated_at = now()
    WHERE r.registration_id = p_registration_id;

    RETURN QUERY SELECT 'SUCCESS'::TEXT, v_reg.payment_intent_id;
END;
$$;

CREATE OR REPLACE FUNCTION sp_cancel_registration(
    p_registration_id       UUID,
    p_stripe_refund_id      TEXT,
    p_refunded_amount_cents INTEGER,
    p_reason                TEXT,
    p_restore_availability  BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (
    result_code TEXT
)
LANGUAGE plpgsql AS $$
DECLARE
    v_reg registrations%ROWTYPE;
BEGIN
    SELECT * INTO v_reg
    FROM registrations
    WHERE registration_id = p_registration_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'NOT_FOUND'::TEXT; RETURN;
    END IF;

    IF v_reg.status = 'CANCELLED' THEN
        RETURN QUERY SELECT 'ALREADY_CANCELLED'::TEXT; RETURN;
    END IF;

    IF v_reg.status != 'CONFIRMED' THEN
        RETURN QUERY SELECT 'INVALID_STATE'::TEXT; RETURN;
    END IF;

    IF p_restore_availability THEN
        UPDATE events
        SET available_slots = available_slots + 1,
            confirmed_count = confirmed_count - 1,
            status          = CASE WHEN status = 'FULL' THEN 'OPEN' ELSE status END,
            updated_at      = now()
        WHERE event_id = v_reg.event_id;
    END IF;

    UPDATE registrations
    SET status                = 'CANCELLED',
        stripe_refund_id      = p_stripe_refund_id,
        refunded_amount_cents = refunded_amount_cents + p_refunded_amount_cents,
        cancelled_at          = now(),
        updated_at            = now()
    WHERE registration_id = p_registration_id;

    INSERT INTO refund_log (
        registration_id, event_id, stripe_refund_id,
        refund_type, amount_cents, reason
    ) VALUES (
        p_registration_id, v_reg.event_id, p_stripe_refund_id,
        'FULL', p_refunded_amount_cents, p_reason
    );

    RETURN QUERY SELECT 'SUCCESS'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION sp_partial_refund_registration(
    p_registration_id       UUID,
    p_stripe_refund_id      TEXT,
    p_refunded_amount_cents INTEGER,
    p_reason                TEXT
)
RETURNS TABLE (
    result_code TEXT
)
LANGUAGE plpgsql AS $$
DECLARE
    v_reg       registrations%ROWTYPE;
    v_remaining INTEGER;
BEGIN
    SELECT * INTO v_reg
    FROM registrations
    WHERE registration_id = p_registration_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN QUERY SELECT 'NOT_FOUND'::TEXT; RETURN;
    END IF;

    IF v_reg.status != 'CONFIRMED' THEN
        RETURN QUERY SELECT 'INVALID_STATE'::TEXT; RETURN;
    END IF;

    v_remaining := v_reg.gross_amount_cents - v_reg.refunded_amount_cents;

    IF p_refunded_amount_cents > v_remaining THEN
        RETURN QUERY SELECT 'AMOUNT_EXCEEDS_BALANCE'::TEXT; RETURN;
    END IF;

    UPDATE registrations
    SET refunded_amount_cents = refunded_amount_cents + p_refunded_amount_cents,
        stripe_refund_id      = p_stripe_refund_id,
        updated_at            = now()
    WHERE registration_id = p_registration_id;

    INSERT INTO refund_log (
        registration_id, event_id, stripe_refund_id,
        refund_type, amount_cents, reason
    ) VALUES (
        p_registration_id, v_reg.event_id, p_stripe_refund_id,
        'PARTIAL', p_refunded_amount_cents, p_reason
    );

    RETURN QUERY SELECT 'SUCCESS'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION sp_mark_confirmation_email_sent(
    p_registration_id UUID
)
RETURNS VOID
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE registrations
    SET confirmation_email_sent_at = now(),
        updated_at                 = now()
    WHERE registration_id          = p_registration_id
      AND confirmation_email_sent_at IS NULL;
END;
$$;
