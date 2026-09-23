DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'incidentbase_worker') THEN
    CREATE ROLE incidentbase_worker
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE incidentbase_worker
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS;

SET ROLE incidentbase_schema_owner;

CREATE FUNCTION app.is_worker_context()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT current_user = 'incidentbase_worker'::NAME
$$;

REVOKE ALL ON FUNCTION app.is_worker_context() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_worker_context() TO incidentbase_worker;

CREATE POLICY organizations_worker_access ON organizations
  USING (id = app.current_organization_id() AND app.is_worker_context());
CREATE POLICY memberships_worker_access ON organization_memberships
  USING (organization_id = app.current_organization_id() AND app.is_worker_context());
CREATE POLICY escalation_policies_worker_access ON escalation_policies
  USING (organization_id = app.current_organization_id() AND app.is_worker_context());
CREATE POLICY escalation_policy_versions_worker_access ON escalation_policy_versions
  USING (organization_id = app.current_organization_id() AND app.is_worker_context());
CREATE POLICY escalation_policy_steps_worker_access ON escalation_policy_steps
  USING (organization_id = app.current_organization_id() AND app.is_worker_context());
CREATE POLICY incidents_worker_access ON incidents
  USING (organization_id = app.current_organization_id() AND app.is_worker_context())
  WITH CHECK (organization_id = app.current_organization_id() AND app.is_worker_context());
CREATE POLICY audit_logs_worker_access ON audit_logs
  USING (organization_id = app.current_organization_id() AND app.is_worker_context())
  WITH CHECK (organization_id = app.current_organization_id() AND app.is_worker_context());
CREATE POLICY outbox_events_worker_access ON outbox_events
  USING (organization_id = app.current_organization_id() AND app.is_worker_context())
  WITH CHECK (organization_id = app.current_organization_id() AND app.is_worker_context());

GRANT USAGE ON SCHEMA public, app TO incidentbase_worker;
GRANT SELECT ON organizations, organization_memberships, escalation_policies,
  escalation_policy_versions, escalation_policy_steps TO incidentbase_worker;
GRANT SELECT, UPDATE ON incidents TO incidentbase_worker;
GRANT SELECT, INSERT ON audit_logs TO incidentbase_worker;
GRANT SELECT, INSERT, UPDATE ON outbox_events TO incidentbase_worker;
GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq TO incidentbase_worker;
GRANT EXECUTE ON FUNCTION app.current_organization_id() TO incidentbase_worker;

CREATE FUNCTION app.worker_reconciliation_candidates(
  deadline_horizon TIMESTAMPTZ,
  result_limit INTEGER
)
RETURNS TABLE (
  organization_id UUID,
  incident_id UUID,
  escalation_generation INTEGER,
  current_escalation_step INTEGER,
  next_escalation_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT pg_has_role(session_user, 'incidentbase_worker', 'member') THEN
    RAISE EXCEPTION 'worker role required' USING ERRCODE = '42501';
  END IF;
  IF result_limit < 1 OR result_limit > 5000 THEN
    RAISE EXCEPTION 'invalid reconciliation limit' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
    SELECT incident.organization_id,
           incident.id,
           incident.escalation_generation,
           incident.current_escalation_step,
           incident.next_escalation_at
    FROM public.incidents AS incident
    WHERE incident.status = 'OPEN'
      AND incident.next_escalation_at IS NOT NULL
      AND incident.next_escalation_at <= deadline_horizon
    ORDER BY incident.next_escalation_at, incident.organization_id, incident.id
    LIMIT result_limit;
END
$$;

REVOKE ALL ON FUNCTION app.worker_reconciliation_candidates(TIMESTAMPTZ, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.worker_reconciliation_candidates(TIMESTAMPTZ, INTEGER)
  TO incidentbase_worker;

RESET ROLE;
