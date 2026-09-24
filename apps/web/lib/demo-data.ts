import type { Incident, Member, TimelineEntry } from './api';

const organizationId = '00000000-0000-4000-8000-000000000001';
const responderA = '00000000-0000-4000-8000-000000000002';
const responderB = '00000000-0000-4000-8000-000000000003';

export const demoMembers: Member[] = [
  {
    id: responderA,
    organizationId,
    userId: '00000000-0000-4000-8000-000000000004',
    displayName: 'Maya Chen',
    role: 'RESPONDER',
    status: 'ACTIVE',
  },
  {
    id: responderB,
    organizationId,
    userId: '00000000-0000-4000-8000-000000000005',
    displayName: 'Noah Patel',
    role: 'RESPONDER',
    status: 'ACTIVE',
  },
];

const sampleDate = '2026-09-24T09:00:00.000Z';

function sampleIncident(
  referenceNumber: number,
  title: string,
  severity: Incident['severity'],
  status: Incident['status'],
  assignedMembershipId: string,
  dayOffset: number,
): Incident {
  const createdAt = new Date(Date.parse(sampleDate) - dayOffset * 86_400_000).toISOString();
  return {
    id: `00000000-0000-4000-8000-${String(referenceNumber).padStart(12, '0')}`,
    organizationId,
    referenceNumber,
    title,
    description:
      {
        1042: 'Elevated API latency is affecting requests in the primary region. The team is investigating the upstream dependency.',
        1041: 'The checkout queue is backing up during peak traffic. The assigned responder is tracing the bottleneck.',
        1040: 'Customers are seeing intermittent authentication failures. Mitigation has begun.',
        1039: 'Webhook delivery was delayed for a subset of integrations. The issue has been resolved and is under review.',
      }[referenceNumber] ?? 'The response team is coordinating this incident.',
    severity,
    status,
    assignedMembershipId,
    reporterMembershipId: responderB,
    policyVersionId: '00000000-0000-4000-8000-000000000006',
    acknowledgedAt: status === 'OPEN' ? null : createdAt,
    investigatingAt: status === 'INVESTIGATING' || status === 'RESOLVED' ? createdAt : null,
    resolvedAt: status === 'RESOLVED' ? createdAt : null,
    createdAt,
    updatedAt: createdAt,
    currentEscalationStep: 1,
    escalationExhaustedAt: null,
    escalationGeneration: 0,
    firstEscalatedAt: null,
    nextEscalationAt: status === 'RESOLVED' ? null : createdAt,
    version: 3,
  };
}

export const demoIncidents: Incident[] = [
  sampleIncident(1042, 'API latency in primary region', 'SEV1', 'INVESTIGATING', responderA, 0),
  sampleIncident(1041, 'Checkout queue processing delay', 'SEV2', 'OPEN', responderB, 1),
  sampleIncident(1040, 'Intermittent sign-in failures', 'SEV2', 'ACKNOWLEDGED', responderA, 2),
  sampleIncident(1039, 'Webhook delivery delays', 'SEV3', 'RESOLVED', responderB, 4),
];

export function demoTimelineFor(incident: Incident): TimelineEntry[] {
  const actions = ['incident.created'];
  if (incident.status !== 'OPEN') actions.push('incident.acknowledged');
  if (incident.status === 'INVESTIGATING' || incident.status === 'RESOLVED')
    actions.push('incident.investigation-started');
  if (incident.status === 'RESOLVED') actions.push('incident.resolved');
  return actions.map((action, index) => ({
    id: `${incident.referenceNumber}${index + 1}`,
    organizationId,
    incidentId: incident.id,
    actorMembershipId: index === 0 ? incident.reporterMembershipId : incident.assignedMembershipId,
    actorType: 'USER',
    action,
    createdAt: incident.createdAt,
    metadata: {},
  }));
}
