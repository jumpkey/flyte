-- migrate:up

-- Registration availability is a database invariant: public routes are only
-- presentation and may be bypassed or race an event state change.
CREATE OR REPLACE FUNCTION sp_initiate_registration(
    p_event_id UUID, p_email TEXT, p_first_name TEXT, p_last_name TEXT,
    p_phone TEXT, p_attributes JSONB, p_gross_amount_cents INTEGER,
    p_payment_intent_id TEXT
)
RETURNS TABLE (result_code TEXT, registration_id UUID)
LANGUAGE plpgsql AS $$
DECLARE
    v_event events%ROWTYPE;
    v_registration_id UUID;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_event_id::TEXT || ':' || lower(p_email), 0));
    SELECT * INTO v_event FROM events WHERE event_id = p_event_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'EVENT_NOT_FOUND'::TEXT, NULL::UUID; RETURN;
    END IF;
    IF v_event.registration_fee_cents <> p_gross_amount_cents OR p_gross_amount_cents <= 0 THEN
        RETURN QUERY SELECT 'INVALID_AMOUNT'::TEXT, NULL::UUID; RETURN;
    END IF;

    IF EXISTS (
        SELECT 1 FROM registrations r
        WHERE r.event_id = p_event_id AND lower(r.email) = lower(p_email)
          AND r.status NOT IN ('PAYMENT_FAILED', 'EXPIRED', 'CANCELLED')
    ) THEN
        RETURN QUERY SELECT 'ALREADY_REGISTERED'::TEXT, NULL::UUID; RETURN;
    END IF;
    IF v_event.status = 'FULL' OR v_event.available_slots <= 0 THEN
        RETURN QUERY SELECT 'AVAILABILITY_EXHAUSTED'::TEXT, NULL::UUID; RETURN;
    END IF;
    IF v_event.status <> 'OPEN' OR v_event.event_date <= now() THEN
        RETURN QUERY SELECT 'EVENT_CLOSED'::TEXT, NULL::UUID; RETURN;
    END IF;

    v_registration_id := gen_random_uuid();
    INSERT INTO registrations (registration_id, event_id, email, first_name, last_name,
        phone, attributes, gross_amount_cents, payment_intent_id, status)
    VALUES (v_registration_id, p_event_id, p_email, p_first_name, p_last_name,
        p_phone, p_attributes, p_gross_amount_cents, p_payment_intent_id, 'PENDING_PAYMENT');
    RETURN QUERY SELECT 'SUCCESS'::TEXT, v_registration_id;
END;
$$;

-- Acquire capacity only while the event is accepting registrations. Successful
-- capture finalization remains allowed after this point so paid registrations
-- are recorded and can be refunded during cancellation.
CREATE OR REPLACE FUNCTION sp_acquire_slot_and_stage_capture(p_payment_intent_id TEXT)
RETURNS TABLE (result_code TEXT, registration_id UUID, event_id UUID, email TEXT,
    first_name TEXT, last_name TEXT, gross_amount_cents INTEGER)
LANGUAGE plpgsql AS $$
DECLARE
    v_reg registrations%ROWTYPE;
    v_event events%ROWTYPE;
BEGIN
    SELECT * INTO v_reg FROM registrations
    WHERE registrations.payment_intent_id = p_payment_intent_id FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT 'NOT_FOUND'::TEXT, NULL::UUID, NULL::UUID, NULL::TEXT, NULL::TEXT, NULL::TEXT, NULL::INTEGER; RETURN;
    END IF;
    IF v_reg.status IN ('PENDING_CAPTURE', 'CONFIRMED') THEN
        RETURN QUERY SELECT 'IDEMPOTENT_REPLAY'::TEXT, v_reg.registration_id, v_reg.event_id, v_reg.email,
            v_reg.first_name, v_reg.last_name, v_reg.gross_amount_cents; RETURN;
    END IF;
    IF v_reg.status IN ('EXPIRED', 'CANCELLED', 'PAYMENT_FAILED') THEN
        RETURN QUERY SELECT 'INVALID_STATE'::TEXT, v_reg.registration_id, v_reg.event_id, v_reg.email,
            v_reg.first_name, v_reg.last_name, v_reg.gross_amount_cents; RETURN;
    END IF;

    SELECT * INTO v_event FROM events e WHERE e.event_id = v_reg.event_id FOR UPDATE;
    IF v_event.status = 'FULL' OR v_event.available_slots <= 0 THEN
        UPDATE registrations SET status = 'PAYMENT_FAILED', updated_at = now()
        WHERE registrations.registration_id = v_reg.registration_id;
        RETURN QUERY SELECT 'AVAILABILITY_EXHAUSTED'::TEXT, v_reg.registration_id, v_reg.event_id, v_reg.email,
            v_reg.first_name, v_reg.last_name, v_reg.gross_amount_cents; RETURN;
    END IF;
    IF v_event.status <> 'OPEN' OR v_event.event_date <= now() THEN
        UPDATE registrations SET status = 'PAYMENT_FAILED', updated_at = now()
        WHERE registrations.registration_id = v_reg.registration_id;
        RETURN QUERY SELECT 'INVALID_STATE'::TEXT, v_reg.registration_id, v_reg.event_id, v_reg.email,
            v_reg.first_name, v_reg.last_name, v_reg.gross_amount_cents; RETURN;
    END IF;
    UPDATE events SET available_slots = available_slots - 1, confirmed_count = confirmed_count + 1,
        status = CASE WHEN available_slots - 1 = 0 THEN 'FULL' ELSE status END, updated_at = now()
    WHERE events.event_id = v_reg.event_id;
    UPDATE registrations SET status = 'PENDING_CAPTURE', updated_at = now()
    WHERE registrations.registration_id = v_reg.registration_id;
    RETURN QUERY SELECT 'SLOT_ACQUIRED'::TEXT, v_reg.registration_id, v_reg.event_id, v_reg.email,
        v_reg.first_name, v_reg.last_name, v_reg.gross_amount_cents;
END;
$$;

-- Free registrations skip Stripe entirely but use the same row locks, cutoff,
-- duplicate protection, and capacity accounting as paid admissions.
CREATE OR REPLACE FUNCTION sp_register_free(p_event_id UUID, p_email TEXT, p_first_name TEXT,
    p_last_name TEXT, p_phone TEXT, p_attributes JSONB)
RETURNS TABLE (result_code TEXT, registration_id UUID)
LANGUAGE plpgsql AS $$
DECLARE
    v_event events%ROWTYPE;
    v_registration_id UUID;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_event_id::TEXT || ':' || lower(p_email), 0));
    SELECT * INTO v_event FROM events WHERE event_id = p_event_id FOR UPDATE;
    IF NOT FOUND THEN RETURN QUERY SELECT 'EVENT_NOT_FOUND'::TEXT, NULL::UUID; RETURN; END IF;
    IF v_event.registration_fee_cents <> 0 THEN
        RETURN QUERY SELECT 'INVALID_AMOUNT'::TEXT, NULL::UUID; RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM registrations r WHERE r.event_id = p_event_id
        AND lower(r.email) = lower(p_email)
        AND r.status NOT IN ('PAYMENT_FAILED', 'EXPIRED', 'CANCELLED')) THEN
        RETURN QUERY SELECT 'ALREADY_REGISTERED'::TEXT, NULL::UUID; RETURN;
    END IF;
    IF v_event.status = 'FULL' OR v_event.available_slots <= 0 THEN
        RETURN QUERY SELECT 'AVAILABILITY_EXHAUSTED'::TEXT, NULL::UUID; RETURN;
    END IF;
    IF v_event.status <> 'OPEN' OR v_event.event_date <= now() THEN
        RETURN QUERY SELECT 'EVENT_CLOSED'::TEXT, NULL::UUID; RETURN;
    END IF;
    v_registration_id := gen_random_uuid();
    INSERT INTO registrations (registration_id, event_id, email, first_name, last_name, phone,
        attributes, gross_amount_cents, net_amount_cents, status, confirmed_at)
    VALUES (v_registration_id, p_event_id, p_email, p_first_name, p_last_name, p_phone,
        COALESCE(p_attributes, '{}'::JSONB), 0, 0, 'CONFIRMED', now());
    UPDATE events SET available_slots = available_slots - 1, confirmed_count = confirmed_count + 1,
        status = CASE WHEN available_slots - 1 = 0 THEN 'FULL' ELSE status END, updated_at = now()
    WHERE events.event_id = p_event_id;
    RETURN QUERY SELECT 'SUCCESS'::TEXT, v_registration_id;
END;
$$;

-- Waitlist inserts are similarly gated against closed and past events.
CREATE OR REPLACE FUNCTION sp_add_to_waitlist(p_event_id UUID, p_email TEXT, p_first_name TEXT,
    p_last_name TEXT, p_phone TEXT)
RETURNS TABLE (result_code TEXT, waitlist_entry_id UUID)
LANGUAGE plpgsql AS $$
DECLARE
    v_event events%ROWTYPE;
    v_id UUID;
BEGIN
    SELECT * INTO v_event FROM events WHERE event_id = p_event_id FOR UPDATE;
    IF NOT FOUND THEN RETURN QUERY SELECT 'EVENT_NOT_FOUND'::TEXT, NULL::UUID; RETURN; END IF;
    IF v_event.status NOT IN ('OPEN', 'FULL') OR v_event.event_date <= now() OR NOT v_event.waitlist_enabled THEN
        RETURN QUERY SELECT 'WAITLIST_CLOSED'::TEXT, NULL::UUID; RETURN;
    END IF;
    INSERT INTO waitlist_entries(event_id, email, first_name, last_name, phone)
    VALUES (p_event_id, p_email, p_first_name, p_last_name, p_phone)
    ON CONFLICT (event_id, email) DO NOTHING
    RETURNING waitlist_entries.waitlist_entry_id INTO v_id;
    IF v_id IS NULL THEN
        SELECT w.waitlist_entry_id INTO v_id FROM waitlist_entries w
        WHERE w.event_id = p_event_id AND w.email = p_email;
        RETURN QUERY SELECT 'ALREADY_ON_WAITLIST'::TEXT, v_id; RETURN;
    END IF;
    RETURN QUERY SELECT 'SUCCESS'::TEXT, v_id;
END;
$$;

-- migrate:down

-- Restore the previous procedures by reapplying migration 005/006 in a fresh
-- database. These replacements depend on the current schema's lifecycle fields.
