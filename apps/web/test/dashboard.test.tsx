import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { IncidentDashboard } from '../components/incident-dashboard';
import { demoIncidents, demoMembers, demoTimelineFor } from '../lib/demo-data';

describe('incident dashboard', () => {
  it('shows sample incidents as a read-only queue with counts derived from the rows', () => {
    const markup = renderToStaticMarkup(
      <IncidentDashboard
        incidents={demoIncidents}
        members={demoMembers}
        organizationName="Atlas Operations"
        sample
        onSelect={() => undefined}
        onQueryChange={() => undefined}
      />,
    );

    expect(markup).toContain('API latency in primary region');
    expect(markup).toContain('Checkout queue processing delay');
    expect(markup).toContain('Active incidents');
    expect(markup).toContain('>03</strong>');
    expect(markup).toContain('Sample data');
    expect(markup).toContain('>Critical</span>');
    expect(markup).toContain('>High</span>');
    expect(markup).toContain('>Medium</span>');
    expect(markup).toContain('>Low</span>');
    expect(markup).toContain('severity severity-sev1');
    expect(markup).not.toContain('>SEV1</span>');
    expect(markup).not.toContain('Create incident');
  });

  it('does not invent activity or incidents for an empty workspace', () => {
    const markup = renderToStaticMarkup(
      <IncidentDashboard incidents={[]} members={[]} organizationName="Empty workspace" />,
    );

    expect(markup).toContain('No incidents yet');
    expect(markup).toContain('>00</strong>');
    expect(markup).not.toContain('Create incident');
  });

  it('shows only the five most recently updated incidents on overview', () => {
    const incidents = Array.from({ length: 7 }, (_, index) => ({
      ...demoIncidents[0]!,
      id: `incident-${index}`,
      referenceNumber: index + 1,
      title: `Incident ${index}`,
      updatedAt: new Date(2026, 0, index + 1).toISOString(),
    }));
    const markup = renderToStaticMarkup(
      <IncidentDashboard
        incidents={incidents}
        members={demoMembers}
        organizationName="Test"
        mode="overview"
      />,
    );
    expect(markup).toContain('View all incidents');
    expect(markup).toContain('Incident 6');
    expect(markup).not.toContain('Incident 0');
    expect(markup).not.toContain('Search incidents');
  });

  it('keeps sample timelines consistent with each incident status', () => {
    expect(demoTimelineFor(demoIncidents[1]!).map((entry) => entry.action)).toEqual([
      'incident.created',
    ]);
    expect(demoTimelineFor(demoIncidents[3]!).map((entry) => entry.action)).toEqual([
      'incident.created',
      'incident.acknowledged',
      'incident.investigation-started',
      'incident.resolved',
    ]);
  });
});
