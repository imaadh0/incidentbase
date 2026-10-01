import type { IncidentSeverity } from './api';

export const severityLevels = ['SEV1', 'SEV2', 'SEV3', 'SEV4'] as const;

export const severityLabels: Record<IncidentSeverity, string> = {
  SEV1: 'Critical',
  SEV2: 'High',
  SEV3: 'Medium',
  SEV4: 'Low',
};

export function severityLabel(severity: IncidentSeverity): string {
  return severityLabels[severity];
}
