-- migrate:up

-- Fix a TOCTOU race condition in sp_initiate_registration.
--
-- The original implementation did SELECT COUNT(*) followed by INSERT, which
-- allowed concurrent requests for the same (event_id, email) to all observe
-- count=0 before any INSERT committed, causing all of them to succeed.
--
-- The fix has two parts:
--   1. A partial unique index that enforces one active registration per
--      (event_id, email) pair at the storage layer.
--   2. A replacement for sp_initiate_registration that attempts INSERT
--      directly and catches the unique_violation exception rather than relying
--      on a pre-insert existence check.  This makes the whole operation atomic
--      with respect to concurrent registrations.

CREATE UNIQUE INDEX IF NOT EXISTS idx_registrations_active_email
    ON registrations(event_id, lower(email))
    WHERE status NOT IN ('PAYMENT_FAILED', 'EXPIRED', 'CANCELLED');

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
BEGIN
    IF NOT EXISTS (SELECT 1 FROM events WHERE event_id = p_event_id) THEN
        RETURN QUERY SELECT 'EVENT_NOT_FOUND'::TEXT, NULL::UUID;
        RETURN;
    END IF;

    v_registration_id := gen_random_uuid();

    -- Attempt the INSERT directly.  If a concurrent transaction already holds
    -- an active registration for this (event_id, email) pair, the partial
    -- unique index (idx_registrations_active_email) raises unique_violation,
    -- which we catch below and convert to ALREADY_REGISTERED.  This is fully
    -- atomic and eliminates the SELECT-then-INSERT race condition.
    BEGIN
        INSERT INTO registrations (
            registration_id, event_id, email, first_name, last_name, phone,
            attributes, gross_amount_cents, payment_intent_id, status
        ) VALUES (
            v_registration_id, p_event_id, p_email, p_first_name, p_last_name, p_phone,
            p_attributes, p_gross_amount_cents, p_payment_intent_id, 'PENDING_PAYMENT'
        );
    EXCEPTION
        WHEN unique_violation THEN
            RETURN QUERY SELECT 'ALREADY_REGISTERED'::TEXT, NULL::UUID;
            RETURN;
    END;

    RETURN QUERY SELECT 'SUCCESS'::TEXT, v_registration_id;
END;
$$;

-- migrate:down

DROP INDEX IF EXISTS idx_registrations_active_email;

-- Restore original (non-atomic) version
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
