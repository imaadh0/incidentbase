'use client';

import { useRouter } from 'next/navigation';

import {
  Activity,
  ArrowRight,
  ChevronDown,
  CircleDot,
  LogOut,
  Plus,
  Settings2,
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
} from 'react';
import { io, type Socket } from 'socket.io-client';
import Link from 'next/link';

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
} from '../../lib/api';
import { IncidentDashboard } from '../../components/incident-dashboard';
import { AdministrationPanel } from '../../components/administration-panel';
import { ThemeToggle } from '../../components/theme-toggle';

export default function IncidentBasePage() {
  const router = useRouter();
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

  useEffect(() => {
    if (!loading && account === null) router.replace('/sign-in');
  }, [account, loading, router]);

  if (loading || account === null) return <LoadingScreen />;
  return (
    <OperationsWorkspace
      account={account}
      onLoggedOut={() => {
        setAccount(null);
        router.replace('/sign-in');
      }}
    />
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
  const [view, setView] = useState<'overview' | 'administration'>('overview');
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
    setView('overview');
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
        view={view}
        onViewChange={(next) => {
          setView(next);
          if (next === 'administration') setSelectedId(null);
        }}
        canAdminister={membership.role === 'OWNER' || membership.role === 'ADMIN'}
        onLogout={() => void logout()}
      />
      <main className="main-content" id="top">
        <header className="topbar">
          <div>
            <p className="eyebrow">
              Workspace / {view === 'overview' ? 'Incidents' : 'Administration'}
            </p>
            <h1>{view === 'overview' ? 'Response overview' : 'Organization settings'}</h1>
          </div>
          <div className="topbar-actions">
            <ThemeToggle compact />
            {view === 'overview' && (
              <button className="primary-button" onClick={() => setShowCreate(true)} type="button">
                <Plus size={17} /> New incident
              </button>
            )}
          </div>
        </header>

        {view === 'overview' && (
          <section className="status-strip">
            <span className="status-pulse" />
            <strong>Live incident feed</strong>
            <span>Updates appear as your team responds</span>
          </section>
        )}
        {error === null ? null : (
          <div className="error-banner" role="alert">
            {error}
            <button onClick={() => void loadWorkspace()} type="button">
              Retry
            </button>
          </div>
        )}

        {view === 'overview' ? (
          <IncidentDashboard
            incidents={incidents}
            members={members}
            organizationName={membership.organizationName}
            role={membership.role}
            query={query}
            onQueryChange={setQuery}
            onSelect={(incident) => setSelectedId(incident.id)}
            onCreate={() => setShowCreate(true)}
            busy={busy}
          />
        ) : (
          <AdministrationPanel
            organizationId={organizationId}
            members={members}
            role={membership.role}
            onMembersChanged={loadWorkspace}
          />
        )}
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
  view: 'overview' | 'administration';
  onViewChange: (view: 'overview' | 'administration') => void;
  canAdminister: boolean;
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
        <p className="nav-label">Main</p>
        <button
          className={`nav-link${props.view === 'overview' ? ' active' : ''}`}
          onClick={() => props.onViewChange('overview')}
          type="button"
        >
          <Activity size={18} />
          Overview
        </button>
        <button className="nav-link" onClick={() => props.onViewChange('overview')} type="button">
          <Siren size={18} />
          Incidents
        </button>
        {props.canAdminister && (
          <button
            className={`nav-link${props.view === 'administration' ? ' active' : ''}`}
            onClick={() => props.onViewChange('administration')}
            type="button"
          >
            <Settings2 size={18} /> Administration
          </button>
        )}
        <p className="nav-label secondary">Explore</p>
        <Link className="nav-link" href="/demo">
          <CircleDot size={18} />
          View demo
        </Link>
        <Link className="nav-link" href="/">
          <ArrowRight size={18} />
          Home
        </Link>
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
  const onClose = props.onClose;
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [onClose]);
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
          <Field label="Title" name="title" maxLength={200} autoFocus />
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
  const onClose = props.onClose;
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [onClose]);
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
    <aside
      className="drawer"
      role="dialog"
      aria-modal="true"
      aria-label={`Incident INC-${incident.referenceNumber}`}
    >
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
          autoFocus
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
