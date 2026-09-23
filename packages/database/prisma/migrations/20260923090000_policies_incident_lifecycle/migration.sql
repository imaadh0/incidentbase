SET ROLE incidentbase_schema_owner;

CREATE TYPE incident_severity AS ENUM ('SEV1', 'SEV2', 'SEV3', 'SEV4');
CREATE TYPE incident_status AS ENUM ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED');
CREATE TYPE audit_actor_type AS ENUM ('USER', 'SYSTEM');
CREATE TYPE outbox_status AS ENUM ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED');

ALTER TABLE organizations
  ADD COLUMN default_escalation_policy_id UUID,
  ADD COLUMN next_incident_number INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT organizations_next_incident_number_check CHECK (next_incident_number > 0);

CREATE TABLE escalation_policies (
  id UUID NOT NULL,
  organization_id UUID NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  active_version_id UUID,
  next_revision INTEGER NOT NULL DEFAULT 1,
  archived_at TIMESTAMPTZ(3),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT escalation_policies_pkey PRIMARY KEY (organization_id, id),
  CONSTRAINT escalation_policies_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES organizations(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT escalation_policies_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  CONSTRAINT escalation_policies_next_revision_check CHECK (next_revision > 0)
);

CREATE TABLE escalation_policy_versions (
  id UUID NOT NULL,
  organization_id UUID NOT NULL,
  policy_id UUID NOT NULL,
  revision INTEGER NOT NULL,
  activated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT escalation_policy_versions_pkey PRIMARY KEY (organization_id, id),
  CONSTRAINT escalation_policy_versions_organization_id_policy_id_revision_key
    UNIQUE (organization_id, policy_id, revision),
  CONSTRAINT escalation_policy_versions_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES organizations(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT escalation_policy_versions_policy_fkey
    FOREIGN KEY (organization_id, policy_id)
    REFERENCES escalation_policies(organization_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT escalation_policy_versions_revision_check CHECK (revision > 0)
);

ALTER TABLE escalation_policies
  ADD CONSTRAINT escalation_policies_active_version_fkey
    FOREIGN KEY (organization_id, active_version_id)
    REFERENCES escalation_policy_versions(organization_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE organizations
  ADD CONSTRAINT organizations_default_escalation_policy_fkey
    FOREIGN KEY (id, default_escalation_policy_id)
    REFERENCES escalation_policies(organization_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE escalation_policy_steps (
  id UUID NOT NULL,
  organization_id UUID NOT NULL,
  policy_version_id UUID NOT NULL,
  position INTEGER NOT NULL,
  responder_membership_id UUID NOT NULL,
  wait_seconds INTEGER NOT NULL,
  CONSTRAINT escalation_policy_steps_pkey PRIMARY KEY (organization_id, id),
  CONSTRAINT escalation_policy_steps_version_position_key
    UNIQUE (organization_id, policy_version_id, position),
  CONSTRAINT escalation_policy_steps_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES organizations(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT escalation_policy_steps_version_fkey
    FOREIGN KEY (organization_id, policy_version_id)
    REFERENCES escalation_policy_versions(organization_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT escalation_policy_steps_responder_membership_fkey
    FOREIGN KEY (organization_id, responder_membership_id)
    REFERENCES organization_memberships(organization_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT escalation_policy_steps_position_check CHECK (position >= 0),
  CONSTRAINT escalation_policy_steps_wait_seconds_check
    CHECK (wait_seconds BETWEEN 1 AND 604800)
);

CREATE TABLE incidents (
  id UUID NOT NULL,
  organization_id UUID NOT NULL,
  reference_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  severity incident_severity NOT NULL,
  status incident_status NOT NULL DEFAULT 'OPEN',
  reporter_membership_id UUID NOT NULL,
  assigned_membership_id UUID NOT NULL,
  policy_version_id UUID NOT NULL,
  current_escalation_step INTEGER NOT NULL DEFAULT 0,
  escalation_generation INTEGER NOT NULL DEFAULT 0,
  next_escalation_at TIMESTAMPTZ(3),
  first_escalated_at TIMESTAMPTZ(3),
  escalation_exhausted_at TIMESTAMPTZ(3),
  acknowledged_at TIMESTAMPTZ(3),
  investigating_at TIMESTAMPTZ(3),
  resolved_at TIMESTAMPTZ(3),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT incidents_pkey PRIMARY KEY (organization_id, id),
  CONSTRAINT incidents_organization_id_reference_number_key
    UNIQUE (organization_id, reference_number),
  CONSTRAINT incidents_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES organizations(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT incidents_reporter_membership_fkey
    FOREIGN KEY (organization_id, reporter_membership_id)
    REFERENCES organization_memberships(organization_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT incidents_assigned_membership_fkey
    FOREIGN KEY (organization_id, assigned_membership_id)
    REFERENCES organization_memberships(organization_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT incidents_policy_version_fkey
    FOREIGN KEY (organization_id, policy_version_id)
    REFERENCES escalation_policy_versions(organization_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT incidents_reference_number_check CHECK (reference_number > 0),
  CONSTRAINT incidents_title_check CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT incidents_current_escalation_step_check CHECK (current_escalation_step >= -1),
  CONSTRAINT incidents_escalation_generation_check CHECK (escalation_generation >= 0),
  CONSTRAINT incidents_version_check CHECK (version > 0),
  CONSTRAINT incidents_lifecycle_timestamps_check CHECK (
    (status = 'OPEN' AND acknowledged_at IS NULL AND investigating_at IS NULL AND resolved_at IS NULL)
    OR (status = 'ACKNOWLEDGED' AND acknowledged_at IS NOT NULL AND investigating_at IS NULL AND resolved_at IS NULL)
    OR (status = 'INVESTIGATING' AND acknowledged_at IS NOT NULL AND investigating_at IS NOT NULL AND resolved_at IS NULL)
    OR (status = 'RESOLVED' AND acknowledged_at IS NOT NULL AND investigating_at IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX incidents_organization_id_status_created_at_idx
  ON incidents(organization_id, status, created_at);

CREATE TABLE audit_logs (
  id BIGSERIAL NOT NULL,
  organization_id UUID NOT NULL,
  incident_id UUID,
  actor_membership_id UUID,
  actor_type audit_actor_type NOT NULL,
  action TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT audit_logs_pkey PRIMARY KEY (id),
  CONSTRAINT audit_logs_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES organizations(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT audit_logs_incident_fkey
    FOREIGN KEY (organization_id, incident_id)
    REFERENCES incidents(organization_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT audit_logs_actor_membership_fkey
    FOREIGN KEY (organization_id, actor_membership_id)
    REFERENCES organization_memberships(organization_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT audit_logs_action_check CHECK (length(btrim(action)) BETWEEN 1 AND 120)
);

CREATE INDEX audit_logs_organization_id_incident_id_id_idx
  ON audit_logs(organization_id, incident_id, id);

CREATE TABLE outbox_events (
  id UUID NOT NULL,
  organization_id UUID NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  deduplication_key TEXT NOT NULL,
  status outbox_status NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TIMESTAMPTZ(3),
  last_error TEXT,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT outbox_events_pkey PRIMARY KEY (organization_id, id),
  CONSTRAINT outbox_events_organization_id_deduplication_key_key
    UNIQUE (organization_id, deduplication_key),
  CONSTRAINT outbox_events_organization_id_fkey
    FOREIGN KEY (organization_id) REFERENCES organizations(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT outbox_events_attempts_check CHECK (attempts >= 0)
);

CREATE INDEX outbox_events_status_available_at_idx
  ON outbox_events(status, available_at);

CREATE TRIGGER escalation_policy_versions_append_only
BEFORE UPDATE OR DELETE ON escalation_policy_versions
FOR EACH ROW EXECUTE FUNCTION app.prevent_append_only_mutation();

CREATE TRIGGER escalation_policy_steps_append_only
BEFORE UPDATE OR DELETE ON escalation_policy_steps
FOR EACH ROW EXECUTE FUNCTION app.prevent_append_only_mutation();

CREATE TRIGGER audit_logs_append_only
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW EXECUTE FUNCTION app.prevent_append_only_mutation();

ALTER TABLE escalation_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation_policies FORCE ROW LEVEL SECURITY;
ALTER TABLE escalation_policy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation_policy_versions FORCE ROW LEVEL SECURITY;
ALTER TABLE escalation_policy_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE escalation_policy_steps FORCE ROW LEVEL SECURITY;
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;

CREATE POLICY escalation_policies_tenant_access ON escalation_policies
  USING (organization_id = app.current_organization_id() AND app.has_active_membership(organization_id))
  WITH CHECK (organization_id = app.current_organization_id() AND app.has_active_membership(organization_id));
CREATE POLICY escalation_policy_versions_tenant_access ON escalation_policy_versions
  USING (organization_id = app.current_organization_id() AND app.has_active_membership(organization_id))
  WITH CHECK (organization_id = app.current_organization_id() AND app.has_active_membership(organization_id));
CREATE POLICY escalation_policy_steps_tenant_access ON escalation_policy_steps
  USING (organization_id = app.current_organization_id() AND app.has_active_membership(organization_id))
  WITH CHECK (organization_id = app.current_organization_id() AND app.has_active_membership(organization_id));
CREATE POLICY incidents_tenant_access ON incidents
  USING (organization_id = app.current_organization_id() AND app.has_active_membership(organization_id))
  WITH CHECK (organization_id = app.current_organization_id() AND app.has_active_membership(organization_id));
CREATE POLICY audit_logs_tenant_access ON audit_logs
  USING (organization_id = app.current_organization_id() AND app.has_active_membership(organization_id))
  WITH CHECK (organization_id = app.current_organization_id() AND app.has_active_membership(organization_id));
CREATE POLICY outbox_events_tenant_access ON outbox_events
  USING (organization_id = app.current_organization_id() AND app.has_active_membership(organization_id))
  WITH CHECK (organization_id = app.current_organization_id() AND app.has_active_membership(organization_id));

GRANT SELECT, INSERT, UPDATE ON escalation_policies, incidents, outbox_events
  TO incidentbase_runtime;
GRANT SELECT, INSERT ON escalation_policy_versions, escalation_policy_steps, audit_logs
  TO incidentbase_runtime;
GRANT USAGE, SELECT ON SEQUENCE audit_logs_id_seq TO incidentbase_runtime;

REVOKE DELETE ON escalation_policies, escalation_policy_versions,
  escalation_policy_steps, incidents, audit_logs FROM incidentbase_runtime;
REVOKE UPDATE ON escalation_policy_versions, escalation_policy_steps, audit_logs
  FROM incidentbase_runtime;

RESET ROLE;
