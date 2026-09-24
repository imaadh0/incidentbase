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
