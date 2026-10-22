-- migrate:up
ALTER TABLE events DROP CONSTRAINT events_status_check;
ALTER TABLE events ADD CONSTRAINT events_status_check CHECK (status IN ('DRAFT','OPEN','FULL','CLOSED','CANCELLING','CANCELLED'));
-- Fail closed if preexisting duplicate refunds require operator reconciliation.
CREATE UNIQUE INDEX refund_log_stripe_refund_unique ON refund_log(stripe_refund_id);
CREATE TABLE refund_operations (
 operation_id TEXT PRIMARY KEY,
 registration_id UUID NOT NULL REFERENCES registrations(registration_id) ON DELETE CASCADE,
 refund_type TEXT NOT NULL CHECK (refund_type IN ('FULL','PARTIAL')),
 amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
 reason TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED')),
 stripe_refund_id TEXT,
 notification_claimed BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX refund_operations_one_pending ON refund_operations(registration_id) WHERE status = 'PENDING';
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

    IF EXISTS (SELECT 1 FROM refund_log WHERE stripe_refund_id = p_stripe_refund_id AND registration_id = p_registration_id AND amount_cents = p_refunded_amount_cents) THEN
        RETURN QUERY SELECT 'IDEMPOTENT_REPLAY'::TEXT; RETURN;
    END IF;
    IF p_refunded_amount_cents < 0 OR p_refunded_amount_cents > COALESCE(v_reg.net_amount_cents, v_reg.gross_amount_cents) - v_reg.refunded_amount_cents THEN
        RETURN QUERY SELECT 'AMOUNT_EXCEEDS_BALANCE'::TEXT; RETURN;
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

    IF p_refunded_amount_cents > 0 THEN
    INSERT INTO refund_log (
        registration_id, event_id, stripe_refund_id,
        refund_type, amount_cents, reason
    ) VALUES (
        p_registration_id, v_reg.event_id, p_stripe_refund_id,
        'FULL', p_refunded_amount_cents, p_reason
    );

    END IF;
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

    IF EXISTS (SELECT 1 FROM refund_log WHERE stripe_refund_id = p_stripe_refund_id AND registration_id = p_registration_id AND amount_cents = p_refunded_amount_cents) THEN
        RETURN QUERY SELECT 'IDEMPOTENT_REPLAY'::TEXT; RETURN;
    END IF;
    IF p_refunded_amount_cents < 0 OR p_refunded_amount_cents > COALESCE(v_reg.net_amount_cents, v_reg.gross_amount_cents) - v_reg.refunded_amount_cents THEN
        RETURN QUERY SELECT 'AMOUNT_EXCEEDS_BALANCE'::TEXT; RETURN;
    END IF;

    IF v_reg.status != 'CONFIRMED' THEN
        RETURN QUERY SELECT 'INVALID_STATE'::TEXT; RETURN;
    END IF;

    -- Refundable balance is bounded by what was captured (net), falling back to
    -- gross when net is unknown (NULL).
    v_remaining := COALESCE(v_reg.net_amount_cents, v_reg.gross_amount_cents) - v_reg.refunded_amount_cents;

    IF p_refunded_amount_cents <= 0 OR p_refunded_amount_cents > v_remaining THEN
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

