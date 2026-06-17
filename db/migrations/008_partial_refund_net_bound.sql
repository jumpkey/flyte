-- migrate:up

-- W14: bound partial refunds on the CAPTURED amount, not gross.
--
-- sp_partial_refund_registration previously computed the refundable balance as
-- (gross_amount_cents - refunded_amount_cents). With manual capture the net
-- (captured) amount can be LESS than gross, so that math let the proc approve a
-- partial refund larger than what was actually captured — Stripe would reject
-- it, but our row would already have been advanced, corrupting the ledger.
-- The TypeScript caller (RefundService) already bounds on COALESCE(net, gross);
-- this makes the database the authority too, so a direct/concurrent call can't
-- over-refund. CREATE OR REPLACE keeps the signature and is safe to re-run.
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

    -- Refundable balance is bounded by what was captured (net), falling back to
    -- gross when net is unknown (NULL).
    v_remaining := COALESCE(v_reg.net_amount_cents, v_reg.gross_amount_cents) - v_reg.refunded_amount_cents;

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

-- migrate:down

-- Restore the gross-bounded balance (the pre-W14 behaviour).
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
