'use client';

import {
  Activity,
  ArrowRight,
  Bell,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Clock3,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Siren,
  Users,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { io, type Socket } from 'socket.io-client';

import {
  REALTIME_INCIDENT_EVENT,
  REALTIME_TOAST_EVENT,
  realtimeIncidentEventSchema,
  type RealtimeIncidentEvent,
} from '@incidentbase/contracts';

import {
  ApiError,
  apiRequest,
  type Account,
  type AccountMembership,
  type Incident,
  type IncidentSeverity,
  type Member,
  type TimelineEntry,
} from '../lib/api';

type AuthMode = 'login' | 'register';

export default function IncidentBasePage() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);

  const loadAccount = useCallback(async () => {
    try {
      setAccount(await apiRequest<Account>('/auth/me'));
    } catch (error: unknown) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      setAccount(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAccount();
  }, [loadAccount]);

  if (loading) return <LoadingScreen />;
  if (account === null) return <AuthenticationScreen onAuthenticated={setAccount} />;
  return <OperationsWorkspace account={account} onLoggedOut={() => setAccount(null)} />;
}

function AuthenticationScreen({
  onAuthenticated,
}: {
  onAuthenticated: (account: Account) => void;
}) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const fields = new FormData(event.currentTarget);
    const body =
      mode === 'login'
        ? { email: fields.get('email'), password: fields.get('password') }
        : {
            displayName: fields.get('displayName'),
            email: fields.get('email'),
            organizationName: fields.get('organizationName'),
            organizationSlug: fields.get('organizationSlug'),
            password: fields.get('password'),
          };
    try {
      const account = await apiRequest<Account>(
        `/auth/${mode}`,
        { body: JSON.stringify(body), method: 'POST' },
        false,
      );
      onAuthenticated(account);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Authentication failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-story">
        <div className="brand large">
          <span className="brand-mark">
            <Activity size={22} />
          </span>
          IncidentBase
        </div>
        <p className="eyebrow">Incident coordination, without blind spots</p>
        <h1>Keep the response moving when every minute matters.</h1>
        <p className="auth-intro">
          Route incidents to the right responder, track every decision, and keep your team aligned
          in real time.
        </p>
        <div className="auth-proof">
          <span>
            <ShieldCheck size={18} /> Tenant-isolated
          </span>
          <span>
            <RefreshCw size={18} /> Live synchronization
          </span>
          <span>
            <CheckCircle2 size={18} /> Auditable lifecycle
          </span>
        </div>
      </section>
      <section className="auth-card">
        <div className="auth-tabs" aria-label="Authentication mode">
          <button
            className={mode === 'login' ? 'active' : ''}
            onClick={() => setMode('login')}
            type="button"
          >
            Sign in
          </button>
          <button
            className={mode === 'register' ? 'active' : ''}
            onClick={() => setMode('register')}
            type="button"
          >
            Create workspace
          </button>
        </div>
        <div>
          <p className="eyebrow">{mode === 'login' ? 'Welcome back' : 'Start responding'}</p>
          <h2>
            {mode === 'login'
              ? 'Sign in to your operations center'
              : 'Create your IncidentBase workspace'}
          </h2>
        </div>
        <form className="form-stack" onSubmit={(event) => void submit(event)}>
          {mode === 'register' ? (
            <>
              <Field label="Your name" name="displayName" autoComplete="name" />
              <Field
                label="Organization name"
                name="organizationName"
                autoComplete="organization"
              />
              <Field label="Organization slug" name="organizationSlug" placeholder="acme-cloud" />
            </>
          ) : null}
          <Field label="Email" name="email" type="email" autoComplete="email" />
          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={mode === 'register' ? 12 : 1}
          />
          {error === null ? null : (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary-button full" disabled={submitting} type="submit">
            {submitting ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create workspace'}
            <ArrowRight size={17} />
          </button>
        </form>
      </section>
    </main>
  );
}

function OperationsWorkspace({
  account,
  onLoggedOut,
}: {
  account: Account;
  onLoggedOut: () => void;
}) {
  const activeMemberships = useMemo(
    () => account.memberships.filter((item) => item.status === 'ACTIVE'),
    [account.memberships],
  );
  const [organizationId, setOrganizationId] = useState(() =>
    preferredOrganization(activeMemberships),
  );
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Incident | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [query, setQuery] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<RealtimeIncidentEvent[]>([]);
  const cursorRef = useRef('0');
  const seenEvents = useRef(new Set<string>());

  const membership = activeMemberships.find((item) => item.organizationId === organizationId);

  const loadWorkspace = useCallback(async () => {
    if (organizationId === '') return;
    setBusy(true);
    setError(null);
    try {
      const [incidentRows, memberRows] = await Promise.all([
        apiRequest<Incident[]>(`/organizations/${organizationId}/incidents`),
        apiRequest<Member[]>(`/organizations/${organizationId}/members`),
      ]);
      setIncidents(incidentRows);
      setMembers(memberRows);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Unable to load the workspace.');
    } finally {
      setBusy(false);
    }
  }, [organizationId]);

  const loadSelected = useCallback(
    async (after?: string) => {
      if (organizationId === '' || selectedId === null) return;
      const suffix = after === undefined || after === '0' ? '' : `?after=${after}`;
      const [incident, entries] = await Promise.all([
        apiRequest<Incident>(`/organizations/${organizationId}/incidents/${selectedId}`),
        apiRequest<TimelineEntry[]>(
          `/organizations/${organizationId}/incidents/${selectedId}/timeline${suffix}`,
        ),
      ]);
      setSelected(incident);
      setTimeline((current) =>
        after === undefined || after === '0' ? entries : mergeTimeline(current, entries),
      );
      const last = entries.at(-1)?.id;
      if (last !== undefined) cursorRef.current = last;
    },
    [organizationId, selectedId],
  );

  useEffect(() => {
    if (organizationId !== '') localStorage.setItem('incidentbase.organization', organizationId);
    setSelectedId(null);
    setSelected(null);
    setTimeline([]);
    cursorRef.current = '0';
    void loadWorkspace();
  }, [loadWorkspace, organizationId]);

  useEffect(() => {
    cursorRef.current = '0';
    setTimeline([]);
    void loadSelected('0');
  }, [loadSelected, selectedId]);

  useEffect(() => {
    if (organizationId === '') return;
    const socket: Socket = io({ path: '/socket.io', withCredentials: true });
    const resynchronize = () => {
      socket.emit('organization:join', { organizationId });
      void loadWorkspace();
      void loadSelected(cursorRef.current);
    };
    const receiveInvalidation = (raw: unknown) => {
      const parsed = realtimeIncidentEventSchema.safeParse(raw);
      if (!parsed.success || parsed.data.organizationId !== organizationId) return;
      if (seenEvents.current.has(parsed.data.eventId)) return;
      seenEvents.current.add(parsed.data.eventId);
      void loadWorkspace();
      if (parsed.data.incidentId === selectedId) void loadSelected(cursorRef.current);
    };
    const receiveToast = (raw: unknown) => {
      const parsed = realtimeIncidentEventSchema.safeParse(raw);
      if (!parsed.success || seenEvents.current.has(`toast:${parsed.data.eventId}`)) return;
      seenEvents.current.add(`toast:${parsed.data.eventId}`);
      setToasts((current) => [parsed.data, ...current].slice(0, 4));
    };
    socket.on('connect', resynchronize);
    socket.on(REALTIME_INCIDENT_EVENT, receiveInvalidation);
    socket.on(REALTIME_TOAST_EVENT, receiveToast);
    return () => {
      socket.disconnect();
    };
  }, [loadSelected, loadWorkspace, organizationId, selectedId]);

  async function logout() {
    await apiRequest<void>('/auth/logout', { method: 'POST' });
    onLoggedOut();
  }

  const filtered = incidents.filter((incident) =>
    `${incident.referenceNumber} ${incident.title} ${incident.status} ${incident.severity}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const memberById = new Map(members.map((item) => [item.id, item]));

  if (membership === undefined) {
    return <EmptyMembership account={account} onLoggedOut={() => void logout()} />;
  }

  return (
    <div className="app-shell">
      <Sidebar
        account={account}
        memberships={activeMemberships}
        organizationId={organizationId}
        onOrganizationChange={setOrganizationId}
        onLogout={() => void logout()}
      />
      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="eyebrow">Operations center</p>
            <h1>Incidents</h1>
          </div>
          <div className="topbar-actions">
            <label className="search-box">
              <Search size={17} />
              <span className="sr-only">Search incidents</span>
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search incidents"
              />
            </label>
            <button className="icon-button" type="button" aria-label="Notifications">
              <Bell size={19} />
              {toasts.length > 0 ? <span className="notification-dot" /> : null}
            </button>
            <button className="primary-button" onClick={() => setShowCreate(true)} type="button">
              <Plus size={17} />
              New incident
            </button>
          </div>
        </header>

        <section className="status-strip">
          <span className="status-pulse" />
          <strong>Live incident feed connected</strong>
          <span>REST data remains authoritative</span>
        </section>
        {error === null ? null : (
          <div className="error-banner" role="alert">
            {error}
            <button onClick={() => void loadWorkspace()} type="button">
              Retry
            </button>
          </div>
        )}

        <section className="metric-grid">
          <Metric
            label="Active"
            value={String(incidents.filter((item) => item.status !== 'RESOLVED').length)}
            icon={<Siren size={19} />}
            tone="critical"
          />
          <Metric
            label="Awaiting acknowledgement"
            value={String(incidents.filter((item) => item.status === 'OPEN').length)}
            icon={<Clock3 size={19} />}
          />
          <Metric
            label="Investigating"
            value={String(incidents.filter((item) => item.status === 'INVESTIGATING').length)}
            icon={<CircleDot size={19} />}
          />
          <Metric
            label="Resolved"
            value={String(incidents.filter((item) => item.status === 'RESOLVED').length)}
            icon={<CheckCircle2 size={19} />}
          />
        </section>

        <section className="panel incident-panel" id="incidents">
          <div className="panel-header">
            <div>
              <h2>Incident queue</h2>
              <p>
                {membership.organizationName} · {membership.role}
              </p>
            </div>
            <span className="live-label">{busy ? 'Syncing' : 'Live'}</span>
          </div>
          {filtered.length === 0 ? (
            <EmptyIncidents onCreate={() => setShowCreate(true)} />
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
                    <tr
                      key={incident.id}
                      onClick={() => setSelectedId(incident.id)}
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') setSelectedId(incident.id);
                      }}
                    >
                      <td>
                        <strong>INC-{incident.referenceNumber}</strong>
                        <span>{incident.title}</span>
                      </td>
                      <td>
                        <SeverityBadge severity={incident.severity} />
                      </td>
                      <td>
                        <StatusBadge status={incident.status} />
                      </td>
                      <td>
                        {memberById.get(incident.assignedMembershipId)?.displayName ?? 'Responder'}
                      </td>
                      <td>{relativeTime(incident.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      {showCreate ? (
        <CreateIncident
          organizationId={organizationId}
          onClose={() => setShowCreate(false)}
          onCreated={(incident) => {
            setShowCreate(false);
            setSelectedId(incident.id);
            void loadWorkspace();
          }}
        />
      ) : null}
      {selectedId !== null ? (
        <IncidentDetail
          incident={selected}
          timeline={timeline}
          members={members}
          currentMembership={membership}
          onClose={() => setSelectedId(null)}
          onChanged={(incident) => {
            setSelected(incident);
            void loadWorkspace();
            void loadSelected(cursorRef.current);
          }}
          onRefresh={() => void loadSelected(cursorRef.current)}
        />
      ) : null}
      <ToastStack
        toasts={toasts}
        dismiss={(eventId) =>
          setToasts((current) => current.filter((toast) => toast.eventId !== eventId))
        }
      />
    </div>
  );
}

function Sidebar(props: {
  account: Account;
  memberships: AccountMembership[];
  organizationId: string;
  onOrganizationChange: (id: string) => void;
  onLogout: () => void;
}) {
  const current = props.memberships.find((item) => item.organizationId === props.organizationId);
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark">
          <Activity size={20} />
        </span>
        <span>IncidentBase</span>
      </div>
      <label className="organization-switcher">
        <span className="organization-avatar">
          {initials(current?.organizationName ?? 'Organization')}
        </span>
        <span className="organization-copy">
          <strong>{current?.organizationName ?? 'Select organization'}</strong>
          <small>{current?.role ?? 'No active membership'}</small>
        </span>
        <ChevronDown size={16} />
        <select
          aria-label="Organization"
          value={props.organizationId}
          onChange={(event) => props.onOrganizationChange(event.target.value)}
        >
          {props.memberships.map((item) => (
            <option key={item.organizationId} value={item.organizationId}>
              {item.organizationName}
            </option>
          ))}
        </select>
      </label>
      <nav>
        <p className="nav-label">Workspace</p>
        <a className="nav-link active" href="#incidents">
          <Siren size={18} />
          Incidents
        </a>
        <span className="nav-link muted">
          <Users size={18} />
          Team management in Milestone 9
        </span>
      </nav>
      <div className="sidebar-footer">
        <div className="user-card">
          <span className="user-avatar">{initials(props.account.user.displayName)}</span>
          <span>
            <strong>{props.account.user.displayName}</strong>
            <small>{props.account.user.email}</small>
          </span>
        </div>
        <button className="nav-link logout" onClick={props.onLogout} type="button">
          <LogOut size={18} />
          Sign out
        </button>
      </div>
    </aside>
  );
}

function CreateIncident(props: {
  organizationId: string;
  onClose: () => void;
  onCreated: (incident: Incident) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const fields = new FormData(event.currentTarget);
    try {
      const incident = await apiRequest<Incident>(
        `/organizations/${props.organizationId}/incidents`,
        {
          method: 'POST',
          body: JSON.stringify({
            title: fields.get('title'),
            description: fields.get('description'),
            severity: fields.get('severity'),
          }),
        },
      );
      props.onCreated(incident);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Unable to create incident.');
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="create-title">
        <button className="dialog-close" onClick={props.onClose} aria-label="Close" type="button">
          <X size={20} />
        </button>
        <p className="eyebrow">Declare an incident</p>
        <h2 id="create-title">Start the response</h2>
        <form className="form-stack" onSubmit={(event) => void submit(event)}>
          <Field label="Title" name="title" maxLength={200} />
          <label className="field">
            <span>Severity</span>
            <select name="severity" defaultValue="SEV2">
              <option>SEV1</option>
              <option>SEV2</option>
              <option>SEV3</option>
              <option>SEV4</option>
            </select>
          </label>
          <label className="field">
            <span>Description</span>
            <textarea name="description" rows={6} required maxLength={10000} />
          </label>
          {error === null ? null : <p className="form-error">{error}</p>}
          <button className="primary-button full" disabled={submitting} type="submit">
            {submitting ? 'Creating…' : 'Create incident'}
            <ArrowRight size={17} />
          </button>
        </form>
      </section>
    </div>
  );
}

function IncidentDetail(props: {
  incident: Incident | null;
  timeline: TimelineEntry[];
  members: Member[];
  currentMembership: AccountMembership;
  onClose: () => void;
  onChanged: (incident: Incident) => void;
  onRefresh: () => void;
}) {
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (props.incident === null) {
    return (
      <aside className="drawer">
        <div className="drawer-loading">Loading incident…</div>
      </aside>
    );
  }
  const incident = props.incident;
  const administrative =
    props.currentMembership.role === 'OWNER' || props.currentMembership.role === 'ADMIN';
  const assigned = props.currentMembership.membershipId === incident.assignedMembershipId;
  const canOperate = administrative || (props.currentMembership.role === 'RESPONDER' && assigned);
  const responders = props.members.filter(
    (member) => member.role === 'RESPONDER' && member.status === 'ACTIVE',
  );

  async function command(name: string, body?: object) {
    setActing(true);
    setError(null);
    try {
      const updated = await apiRequest<Incident>(
        `/organizations/${incident.organizationId}/incidents/${incident.id}/${name}`,
        {
          method: 'POST',
          headers: { 'If-Match': `"${incident.version}"` },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      props.onChanged(updated);
    } catch (caught: unknown) {
      if (caught instanceof ApiError && caught.status === 409) props.onRefresh();
      setError(
        caught instanceof ApiError && caught.status === 409
          ? 'This incident changed. The latest state has been loaded.'
          : caught instanceof Error
            ? caught.message
            : 'The command failed.',
      );
    } finally {
      setActing(false);
    }
  }

  return (
    <aside className="drawer" aria-label={`Incident INC-${incident.referenceNumber}`}>
      <header className="drawer-header">
        <div>
          <p className="eyebrow">
            INC-{incident.referenceNumber} · version {incident.version}
          </p>
          <h2>{incident.title}</h2>
        </div>
        <button
          className="dialog-close"
          onClick={props.onClose}
          aria-label="Close detail"
          type="button"
        >
          <X size={20} />
        </button>
      </header>
      <div className="drawer-body">
        <div className="incident-meta">
          <SeverityBadge severity={incident.severity} />
          <StatusBadge status={incident.status} />
          <span>{incident.firstEscalatedAt === null ? 'Not escalated' : 'Escalated'}</span>
        </div>
        <p className="incident-description">{incident.description}</p>
        <dl className="detail-grid">
          <div>
            <dt>Assigned to</dt>
            <dd>
              {props.members.find((member) => member.id === incident.assignedMembershipId)
                ?.displayName ?? 'Responder'}
            </dd>
          </div>
          <div>
            <dt>Next escalation</dt>
            <dd>
              {incident.nextEscalationAt === null
                ? 'Stopped'
                : relativeTime(incident.nextEscalationAt)}
            </dd>
          </div>
        </dl>
        {error === null ? null : <p className="form-error">{error}</p>}
        <div className="command-row">
          {incident.status === 'OPEN' && canOperate ? (
            <button disabled={acting} onClick={() => void command('acknowledge')} type="button">
              Acknowledge
            </button>
          ) : null}
          {incident.status === 'ACKNOWLEDGED' && canOperate ? (
            <button
              disabled={acting}
              onClick={() => void command('start-investigation')}
              type="button"
            >
              Start investigation
            </button>
          ) : null}
          {incident.status === 'INVESTIGATING' && canOperate ? (
            <button disabled={acting} onClick={() => void command('resolve')} type="button">
              Resolve
            </button>
          ) : null}
          {incident.status === 'RESOLVED' && administrative ? (
            <button disabled={acting} onClick={() => void command('reopen')} type="button">
              Reopen
            </button>
          ) : null}
        </div>
        {administrative && incident.status !== 'RESOLVED' ? (
          <label className="field compact">
            <span>Reassign responder</span>
            <select
              defaultValue=""
              onChange={(event) => {
                if (event.target.value !== '')
                  void command('reassign', { membershipId: event.target.value });
              }}
            >
              <option value="">Select responder</option>
              {responders.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.displayName}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <section className="timeline">
          <div className="section-heading">
            <h3>Timeline</h3>
            <span>{props.timeline.length} events</span>
          </div>
          {props.timeline.map((entry) => (
            <article key={entry.id}>
              <span className="timeline-dot" />
              <div>
                <strong>{humanizeAction(entry.action)}</strong>
                <p>
                  {props.members.find((member) => member.id === entry.actorMembershipId)
                    ?.displayName ?? 'IncidentBase system'}{' '}
                  · {new Date(entry.createdAt).toLocaleString()}
                </p>
              </div>
            </article>
          ))}
        </section>
      </div>
    </aside>
  );
}

function ToastStack(props: { toasts: RealtimeIncidentEvent[]; dismiss: (id: string) => void }) {
  return (
    <div className="toast-stack" aria-live="polite">
      {props.toasts.map((toast) => (
        <article className="toast" key={toast.eventId}>
          <Siren size={18} />
          <div>
            <strong>{humanizeAction(toast.eventType)}</strong>
            <p>
              INC-{toast.referenceNumber} · {toast.title}
            </p>
          </div>
          <button
            onClick={() => props.dismiss(toast.eventId)}
            aria-label="Dismiss notification"
            type="button"
          >
            <X size={15} />
          </button>
        </article>
      ))}
    </div>
  );
}

function Field(props: InputHTMLAttributes<HTMLInputElement> & { label: string; name: string }) {
  const { label, ...input } = props;
  return (
    <label className="field">
      <span>{label}</span>
      <input {...input} required />
    </label>
  );
}

function Metric(props: { label: string; value: string; icon: ReactNode; tone?: string }) {
  return (
    <article className={`metric-card ${props.tone ?? ''}`}>
      <div className="metric-heading">
        <span>{props.label}</span>
        {props.icon}
      </div>
      <strong>{props.value}</strong>
      <p>Current organization</p>
    </article>
  );
}

function SeverityBadge({ severity }: { severity: IncidentSeverity }) {
  return <span className={`severity severity-${severity.toLowerCase()}`}>{severity}</span>;
}

function StatusBadge({ status }: { status: Incident['status'] }) {
  return (
    <span className={`status-badge status-${status.toLowerCase()}`}>
      <CircleDot size={13} />
      {status.toLowerCase().replace('_', ' ')}
    </span>
  );
}

function EmptyIncidents({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="empty-state">
      <Siren size={30} />
      <h3>No matching incidents</h3>
      <p>Declare an incident to start a coordinated response.</p>
      <button onClick={onCreate} type="button">
        Create incident
      </button>
    </div>
  );
}

function LoadingScreen() {
  return (
    <main className="loading-screen">
      <span className="brand-mark">
        <Activity size={24} />
      </span>
      <p>Loading IncidentBase…</p>
    </main>
  );
}

function EmptyMembership({ account, onLoggedOut }: { account: Account; onLoggedOut: () => void }) {
  return (
    <main className="loading-screen">
      <span className="brand-mark">
        <Users size={24} />
      </span>
      <h1>No active organization</h1>
      <p>{account.user.email} does not have an active membership.</p>
      <button className="primary-button" onClick={onLoggedOut} type="button">
        Sign out
      </button>
    </main>
  );
}

function preferredOrganization(memberships: AccountMembership[]): string {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem('incidentbase.organization');
    if (memberships.some((item) => item.organizationId === stored)) return stored ?? '';
  }
  return memberships[0]?.organizationId ?? '';
}

function initials(value: string): string {
  return value
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function relativeTime(value: string): string {
  const delta = new Date(value).getTime() - Date.now();
  const absolute = Math.abs(delta);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (absolute < 60_000) return formatter.format(Math.round(delta / 1_000), 'second');
  if (absolute < 3_600_000) return formatter.format(Math.round(delta / 60_000), 'minute');
  if (absolute < 86_400_000) return formatter.format(Math.round(delta / 3_600_000), 'hour');
  return formatter.format(Math.round(delta / 86_400_000), 'day');
}

function humanizeAction(value: string): string {
  return value
    .replace(/^incident\./u, '')
    .replaceAll('-', ' ')
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function mergeTimeline(current: TimelineEntry[], incoming: TimelineEntry[]): TimelineEntry[] {
  const merged = new Map(current.map((entry) => [entry.id, entry]));
  for (const entry of incoming) merged.set(entry.id, entry);
  return [...merged.values()].sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? -1 : 1));
}
