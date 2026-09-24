'use client';

import { Activity, ArrowLeft, ArrowRight, CircleDot, Siren, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { IncidentDashboard, SeverityBadge, StatusBadge } from '../../components/incident-dashboard';
import { ThemeToggle } from '../../components/theme-toggle';
import type { Incident } from '../../lib/api';
import { demoIncidents, demoMembers, demoTimelineFor } from '../../lib/demo-data';

export default function DemoPage() {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Incident | null>(null);

  useEffect(() => {
    if (selected === null) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [selected]);
  return (
    <div className="app-shell demo-shell" id="top">
      <aside className="sidebar demo-sidebar">
        <Link className="brand" href="/">
          <span className="brand-mark brand-square">
            <span className="logo-glyph" />
          </span>
          <span>IncidentBase</span>
        </Link>
        <div className="demo-workspace">
          <span className="organization-avatar">AO</span>
          <span>
            <strong>Atlas Operations</strong>
            <small>Sample workspace</small>
          </span>
        </div>
        <nav aria-label="Demo navigation">
          <p className="nav-label">Main</p>
          <a className="nav-link active" href="#top">
            <Activity size={18} />
            Overview
          </a>
          <a className="nav-link" href="#incidents">
            <Siren size={18} />
            Incidents
          </a>
          <p className="nav-label secondary">Explore</p>
          <Link className="nav-link" href="/">
            <ArrowLeft size={18} />
            Home
          </Link>
        </nav>
        <div className="sidebar-footer">
          <div className="demo-sidebar-note">
            <CircleDot size={17} />
            Read-only sample data
          </div>
          <Link className="nav-link" href="/sign-in">
            <ArrowRight size={18} />
            Sign in
          </Link>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">Demo / Incidents</p>
            <h1>Response overview</h1>
          </div>
          <div className="topbar-actions">
            <ThemeToggle compact />
            <Link className="primary-button" href="/sign-in">
              Sign in <ArrowRight size={16} />
            </Link>
          </div>
        </header>
        <div className="demo-banner">
          <span className="live-pip" />
          <strong>Explore a sample response</strong>
          <span>Search the queue and open an incident to see its timeline.</span>
        </div>
        <IncidentDashboard
          incidents={demoIncidents}
          members={demoMembers}
          organizationName="Atlas Operations"
          query={query}
          onQueryChange={setQuery}
          onSelect={setSelected}
          sample
        />
      </main>
      {selected && (
        <div className="demo-detail-backdrop" onClick={() => setSelected(null)} role="presentation">
          <aside
            className="drawer demo-detail"
            role="dialog"
            aria-modal="true"
            aria-label={`Sample incident INC-${selected.referenceNumber}`}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="drawer-header">
              <div>
                <p className="eyebrow">SAMPLE / INC-{selected.referenceNumber}</p>
                <h2>{selected.title}</h2>
              </div>
              <button
                className="dialog-close"
                type="button"
                onClick={() => setSelected(null)}
                aria-label="Close detail"
                autoFocus
              >
                <X size={19} />
              </button>
            </header>
            <div className="drawer-body">
              <div className="incident-meta">
                <SeverityBadge severity={selected.severity} />
                <StatusBadge status={selected.status} />
              </div>
              <p className="incident-description">{selected.description}</p>
              <dl className="detail-grid">
                <div>
                  <dt>Assigned to</dt>
                  <dd>
                    {
                      demoMembers.find((member) => member.id === selected.assignedMembershipId)
                        ?.displayName
                    }
                  </dd>
                </div>
                <div>
                  <dt>Escalation</dt>
                  <dd>Sample policy · 15 minutes</dd>
                </div>
              </dl>
              <section className="timeline">
                <div className="section-heading">
                  <h3>Response timeline</h3>
                  <span>Sample data</span>
                </div>
                {demoTimelineFor(selected).map((entry) => (
                  <article key={entry.id}>
                    <span className="timeline-dot" />
                    <div>
                      <strong>
                        {entry.action
                          .replace('incident.', '')
                          .replace(/^./, (letter) => letter.toUpperCase())}
                      </strong>
                      <p>
                        {
                          demoMembers.find((member) => member.id === entry.actorMembershipId)
                            ?.displayName
                        }{' '}
                        · Example activity
                      </p>
                    </div>
                  </article>
                ))}
              </section>
              <p className="demo-readonly">
                This is a read-only preview. Sign in to work with your organization’s incidents.
              </p>
              <Link className="primary-button" href="/sign-in">
                Sign in <ArrowRight size={16} />
              </Link>
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
