SET ROLE incidentbase_schema_owner;

ALTER TABLE escalation_policy_versions
  ADD CONSTRAINT escalation_policy_versions_organization_policy_id_key
    UNIQUE (organization_id, policy_id, id);

ALTER TABLE escalation_policies
  DROP CONSTRAINT escalation_policies_active_version_fkey,
  ADD CONSTRAINT escalation_policies_active_version_fkey
    FOREIGN KEY (organization_id, id, active_version_id)
    REFERENCES escalation_policy_versions(organization_id, policy_id, id)
    ON DELETE RESTRICT ON UPDATE CASCADE;

REVOKE DELETE ON outbox_events FROM incidentbase_runtime;

RESET ROLE;
