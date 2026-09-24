'use client';

import * as React from 'react';

import { ArrowUpRight, CircleDot, Clock3, Search, Siren } from 'lucide-react';

import type { Incident, Member } from '../lib/api';

type Props = {
  incidents: Incident[];
  members: Member[];
  organizationName: string;
  role?: string;
  query?: string;
  onQueryChange?: (query: string) => void;
  onSelect?: (incident: Incident) => void;
  onCreate?: () => void;
  busy?: boolean;
  sample?: boolean;
  preview?: boolean;
};

export function IncidentDashboard({
  incidents,
  members,
  organizationName,
  role,
  query = '',
  onQueryChange,
  onSelect,
  onCreate,
  busy = false,
  sample = false,
  preview = false,
}: Props) {
  const active = incidents.filter((incident) => incident.status !== 'RESOLVED');
  const filtered = incidents.filter((incident) =>
    `${incident.referenceNumber} ${incident.title} ${incident.status} ${incident.severity}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const memberById = new Map(members.map((member) => [member.id, member.displayName]));
  const severityCounts = (['SEV1', 'SEV2', 'SEV3', 'SEV4'] as const).map(
    (severity) => active.filter((incident) => incident.severity === severity).length,
  );
  const [sev1 = 0, sev2 = 0, sev3 = 0] = severityCounts;
  const dayCounts = Array.from({ length: 7 }, (_, index) => {
    const current = new Date(sample ? '2026-09-24T12:00:00.000Z' : Date.now());
    if (sample) {
      current.setUTCHours(0, 0, 0, 0);
      current.setUTCDate(current.getUTCDate() - (6 - index));
    } else {
      current.setHours(0, 0, 0, 0);
      current.setDate(current.getDate() - (6 - index));
    }
    const next = new Date(current);
    if (sample) next.setUTCDate(next.getUTCDate() + 1);
    else next.setDate(next.getDate() + 1);
    return {
      label: current.toLocaleDateString('en', {
        weekday: 'short',
        ...(sample ? { timeZone: 'UTC' } : {}),
      }),
      count: incidents.filter((incident) => {
        const created = new Date(incident.createdAt).getTime();
        return created >= current.getTime() && created < next.getTime();
      }).length,
    };
  });
  const maxDayCount = Math.max(1, ...dayCounts.map((day) => day.count));

  return (
    <div className={`dashboard-content${preview ? ' is-preview' : ''}`}>
      <section className="dashboard-metrics" aria-label="Incident summary">
        <SummaryCard
          label="Active incidents"
          value={active.length}
          icon={<Siren size={20} />}
          note="Across this organization"
        />
        <SummaryCard
          label="Awaiting response"
          value={incidents.filter((incident) => incident.status === 'OPEN').length}
          icon={<Clock3 size={20} />}
          note="Need acknowledgement"
        />
        <SummaryCard
          label="Investigating"
          value={incidents.filter((incident) => incident.status === 'INVESTIGATING').length}
          icon={<CircleDot size={20} />}
          note="Work in progress"
        />
      </section>

      <div className="dashboard-overview">
        <section className="dash-panel activity-panel" aria-labelledby="activity-title">
          <div className="dash-panel-heading">
            <div>
              <p className="panel-kicker">Response activity</p>
              <h2 id="activity-title">Incidents opened</h2>
            </div>
            <span className="panel-period">{sample ? 'Sample week' : 'Last 7 days'}</span>
          </div>
          <div
            className="activity-chart"
            role="img"
            aria-label={`Incidents opened in the last seven days: ${dayCounts.map((day) => `${day.label} ${day.count}`).join(', ')}`}
          >
            {dayCounts.map((day, index) => (
              <div className="activity-day" key={index}>
                <div className="activity-track">
                  <span
                    className={`activity-bar${index === 6 ? ' current' : ''}`}
                    style={{
                      height: `${day.count === 0 ? 0 : Math.max(20, (day.count / maxDayCount) * 100)}%`,
                    }}
                  />
                </div>
                <strong>{day.count}</strong>
                <small>{day.label}</small>
              </div>
            ))}
          </div>
        </section>

        <section className="dash-panel severity-panel" aria-labelledby="severity-title">
          <div className="dash-panel-heading">
            <div>
              <p className="panel-kicker">Current load</p>
              <h2 id="severity-title">Severity mix</h2>
            </div>
            <ArrowUpRight size={17} aria-hidden="true" />
          </div>
          <div className="severity-visual">
            <div
              className="severity-ring"
              role="img"
              aria-label={`Active incidents by severity: ${severityCounts.map((count, index) => `SEV${index + 1} ${count}`).join(', ')}`}
              style={{
                background: active.length
                  ? `conic-gradient(var(--sev1) 0 ${percent(sev1, active.length)}%, var(--sev2) ${percent(sev1, active.length)}% ${percent(sev1 + sev2, active.length)}%, var(--sev3) ${percent(sev1 + sev2, active.length)}% ${percent(sev1 + sev2 + sev3, active.length)}%, var(--sev4) ${percent(sev1 + sev2 + sev3, active.length)}% 100%)`
                  : 'var(--border)',
              }}
            >
              <div>
                <strong>{active.length}</strong>
                <span>active</span>
              </div>
            </div>
            <div className="severity-legend">
              {severityCounts.map((count, index) => (
                <div key={index}>
                  <span className={`legend-dot sev${index + 1}`} />
                  <span>SEV{index + 1}</span>
                  <strong>{count}</strong>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      <section className="dash-panel queue-panel" id="incidents" aria-labelledby="queue-title">
        <div className="dash-panel-heading queue-heading">
          <div>
            <p className="panel-kicker">
              {organizationName}
              {role ? ` / ${role}` : ''}
            </p>
            <h2 id="queue-title">Incident queue</h2>
          </div>
          <span className="queue-count">{busy ? 'Syncing' : `${filtered.length} incidents`}</span>
        </div>
        {!preview && onQueryChange && (
          <div className="queue-tools">
            <label className="search-box">
              <Search size={16} />
              <span className="sr-only">Search incidents</span>
              <input
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder="Search incidents"
              />
            </label>
            {sample && <span className="sample-chip">Sample data</span>}
          </div>
        )}
        {filtered.length === 0 ? (
          <div className="empty-state">
            <Siren size={28} />
            <h3>{query ? 'No matching incidents' : 'No incidents yet'}</h3>
            <p>{query ? 'Try a different search.' : 'The queue is clear.'}</p>
            {!query && onCreate && (
              <button type="button" onClick={onCreate}>
                Create incident
              </button>
            )}
          </div>
        ) : (
          <div className="incident-table-wrap">
            <table className="incident-table">
              <thead>
                <tr>
                  <th>Incident</th>
                  <th>Severity</th>
                  <th>Status</th>
                  <th>Responder</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((incident) => (
                  <tr key={incident.id}>
                    <td>
                      {onSelect ? (
                        <button
                          className="incident-link"
                          type="button"
                          onClick={() => onSelect(incident)}
                        >
                          <strong>INC-{incident.referenceNumber}</strong>
                          <span>{incident.title}</span>
                        </button>
                      ) : (
                        <span className="incident-link">
                          <strong>INC-{incident.referenceNumber}</strong>
                          <span>{incident.title}</span>
                        </span>
                      )}
                    </td>
                    <td>
                      <SeverityBadge severity={incident.severity} />
                    </td>
                    <td>
                      <StatusBadge status={incident.status} />
                    </td>
                    <td>{memberById.get(incident.assignedMembershipId) ?? 'Responder'}</td>
                    <td>{sample ? 'Sample' : new Date(incident.updatedAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function percent(value: number, total: number) {
  return (value / total) * 100;
}

function SummaryCard({
  label,
  value,
  icon,
  note,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  note: string;
}) {
  return (
    <article className="summary-card">
      <div className="summary-label">
        <span>{label}</span>
        {icon}
      </div>
      <strong>{value.toString().padStart(2, '0')}</strong>
      <p>{note}</p>
    </article>
  );
}

export function SeverityBadge({ severity }: { severity: Incident['severity'] }) {
  return <span className={`severity severity-${severity.toLowerCase()}`}>{severity}</span>;
}

export function StatusBadge({ status }: { status: Incident['status'] }) {
  return (
    <span className={`status-badge status-${status.toLowerCase()}`}>
      <CircleDot size={13} />
      {status.toLowerCase().replace('_', ' ')}
    </span>
  );
}
