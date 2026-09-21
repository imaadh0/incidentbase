import {
  Activity,
  Bell,
  BookOpenText,
  ChevronDown,
  CircleDot,
  Clock3,
  Command,
  FileClock,
  Gauge,
  LifeBuoy,
  Plus,
  Radio,
  Search,
  Settings,
  ShieldCheck,
  Siren,
  Users,
} from 'lucide-react';

const incidents = [
  {
    id: 'INC-1042',
    title: 'Checkout latency above SLO',
    severity: 'SEV1',
    status: 'Investigating',
    owner: 'Maya Chen',
    age: '18m',
  },
  {
    id: 'INC-1041',
    title: 'Delayed webhook deliveries',
    severity: 'SEV2',
    status: 'Acknowledged',
    owner: 'Noah Silva',
    age: '41m',
  },
  {
    id: 'INC-1039',
    title: 'Search index replication lag',
    severity: 'SEV3',
    status: 'Open',
    owner: 'Priya Raman',
    age: '1h 12m',
  },
] as const;

const navItems = [
  { icon: Gauge, label: 'Overview', active: true },
  { icon: Siren, label: 'Incidents', active: false },
  { icon: Users, label: 'Team', active: false },
  { icon: Radio, label: 'Escalation policies', active: false },
  { icon: FileClock, label: 'Audit log', active: false },
] as const;

function SeverityBadge({ severity }: { severity: (typeof incidents)[number]['severity'] }) {
  return <span className={`severity severity-${severity.toLowerCase()}`}>{severity}</span>;
}

export default function DashboardPage() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Activity size={20} strokeWidth={2.4} />
          </span>
          <span>IncidentBase</span>
        </div>

        <button className="organization-switcher" type="button" aria-label="Switch organization">
          <span className="organization-avatar">AC</span>
          <span className="organization-copy">
            <strong>Acme Cloud</strong>
            <small>Production</small>
          </span>
          <ChevronDown size={16} aria-hidden="true" />
        </button>

        <nav aria-label="Primary navigation">
          <p className="nav-label">Workspace</p>
          <ul className="nav-list">
            {navItems.map(({ icon: Icon, label, active }) => (
              <li key={label}>
                <a className={active ? 'nav-link active' : 'nav-link'} href="#">
                  <Icon size={18} aria-hidden="true" />
                  <span>{label}</span>
                  {label === 'Incidents' ? <span className="nav-count">3</span> : null}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="sidebar-footer">
          <a className="nav-link" href="#">
            <BookOpenText size={18} aria-hidden="true" />
            <span>Runbooks</span>
          </a>
          <a className="nav-link" href="#">
            <Settings size={18} aria-hidden="true" />
            <span>Settings</span>
          </a>
          <div className="user-card">
            <span className="user-avatar">AR</span>
            <span>
              <strong>Alex Rivera</strong>
              <small>Owner</small>
            </span>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">Operations center</p>
            <h1>Incident overview</h1>
          </div>
          <div className="topbar-actions">
            <button className="search-button" type="button">
              <Search size={17} aria-hidden="true" />
              <span>Search incidents</span>
              <kbd>
                <Command size={12} aria-hidden="true" />K
              </kbd>
            </button>
            <button className="icon-button" type="button" aria-label="Notifications">
              <Bell size={19} />
              <span className="notification-dot" />
            </button>
            <button className="primary-button" type="button">
              <Plus size={17} aria-hidden="true" />
              New incident
            </button>
          </div>
        </header>

        <section className="status-strip" aria-label="System status">
          <span className="status-pulse" />
          <strong>All systems operational</strong>
          <span>Last checked 24 seconds ago</span>
          <a href="#">View service health</a>
        </section>

        <section className="metric-grid" aria-label="Incident metrics">
          <article className="metric-card critical">
            <div className="metric-heading">
              <span>Active incidents</span>
              <Siren size={19} aria-hidden="true" />
            </div>
            <strong>3</strong>
            <p>
              <span>1 critical</span> needs attention
            </p>
          </article>
          <article className="metric-card">
            <div className="metric-heading">
              <span>Mean time to acknowledge</span>
              <Clock3 size={19} aria-hidden="true" />
            </div>
            <strong>4m 12s</strong>
            <p className="positive">↓ 18% from last week</p>
          </article>
          <article className="metric-card">
            <div className="metric-heading">
              <span>Resolved this week</span>
              <ShieldCheck size={19} aria-hidden="true" />
            </div>
            <strong>14</strong>
            <p>Across 4 services</p>
          </article>
          <article className="metric-card">
            <div className="metric-heading">
              <span>On-call coverage</span>
              <LifeBuoy size={19} aria-hidden="true" />
            </div>
            <strong>100%</strong>
            <p className="positive">All policies covered</p>
          </article>
        </section>

        <div className="content-grid">
          <section className="panel incident-panel">
            <div className="panel-header">
              <div>
                <h2>Active incidents</h2>
                <p>Live operational queue across your organization</p>
              </div>
              <a href="#">View all incidents</a>
            </div>
            <div className="incident-table-wrap">
              <table className="incident-table">
                <thead>
                  <tr>
                    <th>Incident</th>
                    <th>Severity</th>
                    <th>Status</th>
                    <th>Responder</th>
                    <th>Age</th>
                  </tr>
                </thead>
                <tbody>
                  {incidents.map((incident) => (
                    <tr key={incident.id}>
                      <td>
                        <a href="#">
                          <small>{incident.id}</small>
                          <strong>{incident.title}</strong>
                        </a>
                      </td>
                      <td>
                        <SeverityBadge severity={incident.severity} />
                      </td>
                      <td>
                        <span className="incident-status">
                          <CircleDot size={14} aria-hidden="true" />
                          {incident.status}
                        </span>
                      </td>
                      <td>{incident.owner}</td>
                      <td className="incident-age">{incident.age}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <aside className="panel on-call-panel">
            <div className="panel-header">
              <div>
                <h2>On call now</h2>
                <p>Primary response rotation</p>
              </div>
              <span className="live-label">Live</span>
            </div>
            <div className="responder">
              <span className="responder-avatar">MC</span>
              <div>
                <strong>Maya Chen</strong>
                <p>Platform · Primary</p>
              </div>
              <span className="online-dot" aria-label="Available" />
            </div>
            <div className="rotation-line" />
            <div className="rotation-next">
              <span>Next rotation</span>
              <strong>Today, 18:00 UTC</strong>
            </div>
            <div className="policy-card">
              <Radio size={18} aria-hidden="true" />
              <div>
                <strong>Platform escalation</strong>
                <p>3 responders · 10 min steps</p>
              </div>
            </div>
            <a className="secondary-button" href="#">
              Manage schedule
            </a>
          </aside>
        </div>

        <p className="foundation-note">
          Dashboard preview uses representative data while the tenant and incident APIs are built.
        </p>
      </main>
    </div>
  );
}
