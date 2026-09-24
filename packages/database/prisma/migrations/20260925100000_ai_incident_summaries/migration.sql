SET ROLE incidentbase_schema_owner;

CREATE TYPE incident_summary_status AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'UNAVAILABLE');
ALTER TABLE incidents ADD COLUMN lifecycle_generation INTEGER NOT NULL DEFAULT 0;

CREATE TABLE incident_summaries (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  incident_id UUID NOT NULL,
  lifecycle_generation INTEGER NOT NULL,
  resolution_audit_id BIGINT NOT NULL,
  input_title TEXT NOT NULL,
  input_description TEXT NOT NULL,
  status incident_summary_status NOT NULL DEFAULT 'PENDING',
  text TEXT,
  model TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_category TEXT,
  available_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ(3),
  unavailable_at TIMESTAMPTZ(3),
  PRIMARY KEY (organization_id, id),
  CONSTRAINT incident_summary_incident_fk FOREIGN KEY (organization_id, incident_id)
    REFERENCES incidents(organization_id, id) ON DELETE RESTRICT,
  CONSTRAINT incident_summary_generation_unique UNIQUE (organization_id, incident_id, lifecycle_generation),
  CONSTRAINT incident_summary_attempts_check CHECK (attempts BETWEEN 0 AND 2),
  CONSTRAINT incident_summary_state_check CHECK (
    (status <> 'COMPLETED' OR (text IS NOT NULL AND model IS NOT NULL AND completed_at IS NOT NULL))
    AND (status <> 'UNAVAILABLE' OR (error_category IS NOT NULL AND unavailable_at IS NOT NULL))
  )
);
CREATE INDEX incident_summaries_claim_idx ON incident_summaries(status, available_at);

ALTER TABLE incident_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE incident_summaries FORCE ROW LEVEL SECURITY;
CREATE POLICY incident_summaries_tenant_access ON incident_summaries
  USING (organization_id = app.current_organization_id() AND app.has_active_membership(organization_id))
  WITH CHECK (organization_id = app.current_organization_id() AND app.has_active_membership(organization_id));
CREATE POLICY incident_summaries_worker_access ON incident_summaries
  USING (organization_id = app.current_organization_id() AND app.is_worker_context())
  WITH CHECK (organization_id = app.current_organization_id() AND app.is_worker_context());
GRANT SELECT, INSERT ON incident_summaries TO incidentbase_runtime;
GRANT SELECT ON incident_summaries TO incidentbase_worker;

CREATE FUNCTION app.worker_claim_incident_summaries(result_limit INTEGER)
RETURNS TABLE (organization_id UUID, summary_id UUID, incident_id UUID, lifecycle_generation INTEGER,
  resolution_audit_id BIGINT, input_title TEXT, input_description TEXT, attempts INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'incidentbase_worker', 'member') THEN
    RAISE EXCEPTION 'worker role required' USING ERRCODE = '42501';
  END IF;
  IF result_limit < 1 OR result_limit > 100 THEN
    RAISE EXCEPTION 'invalid summary batch size' USING ERRCODE = '22023';
  END IF;
  UPDATE public.incident_summaries AS expired
  SET status = 'UNAVAILABLE', error_category = 'WORKER_LEASE_EXPIRED',
      unavailable_at = clock_timestamp()
  WHERE expired.status = 'PROCESSING' AND expired.attempts >= 2
    AND expired.available_at <= clock_timestamp();
  RETURN QUERY
    WITH claimed AS (
      SELECT s.organization_id, s.id FROM public.incident_summaries AS s
      WHERE s.status IN ('PENDING', 'PROCESSING') AND s.available_at <= clock_timestamp()
        AND s.attempts < 2
      ORDER BY s.available_at, s.created_at, s.id
      FOR UPDATE SKIP LOCKED LIMIT result_limit
    )
    UPDATE public.incident_summaries AS s
    SET status = 'PROCESSING', attempts = s.attempts + 1,
        available_at = clock_timestamp() + INTERVAL '30 seconds', error_category = NULL
    FROM claimed WHERE s.organization_id = claimed.organization_id AND s.id = claimed.id
    RETURNING s.organization_id, s.id, s.incident_id, s.lifecycle_generation,
      s.resolution_audit_id, s.input_title, s.input_description, s.attempts;
END
$$;

CREATE FUNCTION app.worker_finish_incident_summary(
  requested_organization_id UUID, requested_summary_id UUID, expected_attempts INTEGER,
  summary_text TEXT, model_id TEXT, failure_category TEXT
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'incidentbase_worker', 'member') THEN
    RAISE EXCEPTION 'worker role required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.incident_summaries AS s
  SET status = CASE WHEN summary_text IS NOT NULL THEN 'COMPLETED'::public.incident_summary_status
                    WHEN s.attempts < 2 THEN 'PENDING'::public.incident_summary_status
                    ELSE 'UNAVAILABLE'::public.incident_summary_status END,
      text = CASE WHEN summary_text IS NULL THEN NULL ELSE left(summary_text, 4000) END,
      model = CASE WHEN summary_text IS NULL THEN NULL ELSE left(model_id, 255) END,
      error_category = CASE WHEN summary_text IS NULL THEN left(failure_category, 100) ELSE NULL END,
      completed_at = CASE WHEN summary_text IS NOT NULL THEN clock_timestamp() ELSE NULL END,
      unavailable_at = CASE WHEN summary_text IS NULL AND s.attempts >= 2 THEN clock_timestamp() ELSE NULL END,
      available_at = CASE WHEN summary_text IS NULL AND s.attempts < 2 THEN clock_timestamp() + INTERVAL '2 seconds'
                          ELSE s.available_at END
  WHERE s.organization_id = requested_organization_id AND s.id = requested_summary_id
    AND s.status = 'PROCESSING' AND s.attempts = expected_attempts;
END
$$;

CREATE FUNCTION app.worker_summary_timeline(
  requested_organization_id UUID, requested_incident_id UUID, resolution_cursor BIGINT, result_limit INTEGER
)
RETURNS TABLE (audit_id BIGINT, action TEXT, occurred_at TIMESTAMPTZ, actor_name TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'incidentbase_worker', 'member')
     OR requested_organization_id IS DISTINCT FROM app.current_organization_id() THEN
    RAISE EXCEPTION 'worker context required' USING ERRCODE = '42501';
  END IF;
  IF result_limit < 1 OR result_limit > 80 THEN
    RAISE EXCEPTION 'invalid timeline limit' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT entries.id, entries.action, entries.created_at,
      COALESCE(identity.display_name, 'System')
    FROM (
      SELECT audit.id, audit.action, audit.created_at, audit.actor_membership_id
      FROM public.audit_logs AS audit
      WHERE audit.organization_id = requested_organization_id
        AND audit.incident_id = requested_incident_id AND audit.id <= resolution_cursor
      ORDER BY audit.id DESC LIMIT result_limit
    ) AS entries
    LEFT JOIN public.organization_memberships AS membership
      ON membership.organization_id = requested_organization_id AND membership.id = entries.actor_membership_id
    LEFT JOIN public.users AS identity ON identity.id = membership.user_id
    ORDER BY entries.id;
END
$$;

REVOKE ALL ON FUNCTION app.worker_claim_incident_summaries(INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.worker_finish_incident_summary(UUID, UUID, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.worker_summary_timeline(UUID, UUID, BIGINT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_claim_incident_summaries(INTEGER) TO incidentbase_worker;
GRANT EXECUTE ON FUNCTION app.worker_finish_incident_summary(UUID, UUID, INTEGER, TEXT, TEXT, TEXT) TO incidentbase_worker;
GRANT EXECUTE ON FUNCTION app.worker_summary_timeline(UUID, UUID, BIGINT, INTEGER) TO incidentbase_worker;

RESET ROLE;
