import type { DatabaseClient } from '@incidentbase/database';

export async function resetTestDatabase(database: DatabaseClient): Promise<void> {
  await database.$executeRawUnsafe(`
    TRUNCATE TABLE
      audit_logs,
      outbox_events,
      incidents,
      escalation_policy_steps,
      escalation_policy_versions,
      escalation_policies,
      refresh_sessions,
      organization_invitations,
      organization_memberships,
      organizations,
      users
    RESTART IDENTITY CASCADE
  `);
}
