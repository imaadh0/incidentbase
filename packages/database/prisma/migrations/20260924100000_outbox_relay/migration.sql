SET ROLE incidentbase_schema_owner;

CREATE FUNCTION app.worker_claim_outbox_events(result_limit INTEGER)
RETURNS TABLE (
  organization_id UUID,
  event_id UUID,
  aggregate_type TEXT,
  aggregate_id UUID,
  event_type TEXT,
  payload JSONB,
  attempts INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'incidentbase_worker', 'member') THEN
    RAISE EXCEPTION 'worker role required' USING ERRCODE = '42501';
  END IF;
  IF result_limit < 1 OR result_limit > 500 THEN
    RAISE EXCEPTION 'invalid outbox batch size' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    WITH claimed AS (
      SELECT event.organization_id, event.id
      FROM public.outbox_events AS event
      WHERE event.status IN ('PENDING', 'PROCESSING')
        AND event.available_at <= clock_timestamp()
        AND event.attempts < 10
      ORDER BY event.available_at, event.created_at, event.id
      FOR UPDATE SKIP LOCKED
      LIMIT result_limit
    )
    UPDATE public.outbox_events AS event
    SET status = 'PROCESSING',
        attempts = event.attempts + 1,
        available_at = clock_timestamp() + INTERVAL '30 seconds',
        last_error = NULL
    FROM claimed
    WHERE event.organization_id = claimed.organization_id
      AND event.id = claimed.id
    RETURNING event.organization_id,
              event.id,
              event.aggregate_type,
              event.aggregate_id,
              event.event_type,
              event.payload,
              event.attempts;
END
$$;

CREATE FUNCTION app.worker_publish_outbox_event(requested_organization_id UUID, requested_event_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'incidentbase_worker', 'member') THEN
    RAISE EXCEPTION 'worker role required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.outbox_events
  SET status = 'PUBLISHED',
      processed_at = clock_timestamp(),
      last_error = NULL
  WHERE organization_id = requested_organization_id
    AND id = requested_event_id
    AND status = 'PROCESSING';
END
$$;

CREATE FUNCTION app.worker_retry_outbox_event(
  requested_organization_id UUID,
  requested_event_id UUID,
  failure_message TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'incidentbase_worker', 'member') THEN
    RAISE EXCEPTION 'worker role required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.outbox_events
  SET status = CASE WHEN attempts >= 10 THEN 'FAILED'::public.outbox_status
                    ELSE 'PENDING'::public.outbox_status END,
      available_at = clock_timestamp()
        + make_interval(secs => LEAST(300, CAST(power(2, attempts) AS INTEGER))),
      last_error = left(failure_message, 1000)
  WHERE organization_id = requested_organization_id
    AND id = requested_event_id
    AND status = 'PROCESSING';
END
$$;

REVOKE ALL ON FUNCTION app.worker_claim_outbox_events(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.worker_publish_outbox_event(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.worker_retry_outbox_event(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_claim_outbox_events(INTEGER) TO incidentbase_worker;
GRANT EXECUTE ON FUNCTION app.worker_publish_outbox_event(UUID, UUID) TO incidentbase_worker;
GRANT EXECUTE ON FUNCTION app.worker_retry_outbox_event(UUID, UUID, TEXT) TO incidentbase_worker;

CREATE FUNCTION app.tenant_member_directory(requested_organization_id UUID)
RETURNS TABLE (
  membership_id UUID,
  organization_id UUID,
  user_id UUID,
  display_name TEXT,
  role public.organization_role,
  status public.membership_status
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF requested_organization_id IS DISTINCT FROM app.current_organization_id()
     OR NOT app.has_active_membership(requested_organization_id) THEN
    RAISE EXCEPTION 'tenant context required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
    SELECT membership.id,
           membership.organization_id,
           membership.user_id,
           identity.display_name,
           membership.role,
           membership.status
    FROM public.organization_memberships AS membership
    JOIN public.users AS identity ON identity.id = membership.user_id
    WHERE membership.organization_id = requested_organization_id
    ORDER BY identity.display_name, membership.id;
END
$$;

REVOKE ALL ON FUNCTION app.tenant_member_directory(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.tenant_member_directory(UUID) TO incidentbase_runtime;

RESET ROLE;
