'use client';

import * as React from 'react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Bell, BookOpen, RefreshCw, Settings2, Users } from 'lucide-react';

import { apiRequest, type Member, type Role } from '../lib/api';

type Section = 'members' | 'policies' | 'notifications' | 'audit';
type PolicyStep = { responderMembershipId: string; waitSeconds: number };
type Policy = {
  id: string;
  name: string;
  description: string | null;
  archivedAt: string | null;
  activeVersion: { revision: number; steps: PolicyStep[] } | null;
};
type PolicyList = { defaultPolicyId: string | null; policies: Policy[] };
type NotificationSettings = {
  emailEnabled: boolean;
  slackEnabled: boolean;
  discordEnabled: boolean;
  slackConfigured: boolean;
  discordConfigured: boolean;
};
type AuditEntry = {
  id: string;
  action: string;
  actorMembershipId: string | null;
  actorType: 'USER' | 'SYSTEM';
  incidentId: string | null;
  createdAt: string;
};

export function AdministrationPanel(props: {
  organizationId: string;
  members: Member[];
  role: Role;
  onMembersChanged: () => Promise<void>;
}) {
  const { onMembersChanged } = props;
  const [section, setSection] = useState<Section>('members');
  const [policies, setPolicies] = useState<PolicyList | null>(null);
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [hasMoreAudit, setHasMoreAudit] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invitation, setInvitation] = useState<string | null>(null);
  const [editingPolicyId, setEditingPolicyId] = useState<string | null>(null);
  const [draftSteps, setDraftSteps] = useState<PolicyStep[]>([
    { responderMembershipId: '', waitSeconds: 600 },
  ]);
  const prefix = `/organizations/${props.organizationId}`;

  const refresh = useCallback(async () => {
    setMessage(null);
    try {
      if (section === 'members') await onMembersChanged();
      if (section === 'policies') setPolicies(await apiRequest<PolicyList>(`${prefix}/policies`));
      if (section === 'notifications')
        setSettings(await apiRequest<NotificationSettings>(`${prefix}/notification-settings`));
      if (section === 'audit') {
        const entries = await apiRequest<AuditEntry[]>(`${prefix}/audit-logs`);
        setAudit(entries);
        setHasMoreAudit(entries.length === 50);
      }
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : 'Could not load administration data.');
    }
  }, [prefix, onMembersChanged, section]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function mutate(action: () => Promise<void>, success: string) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      await refresh();
      setMessage(success);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : 'The change could not be saved.');
    } finally {
      setBusy(false);
    }
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    await mutate(async () => {
      const result = await apiRequest<{ token: string }>(`${prefix}/invitations`, {
        method: 'POST',
        body: JSON.stringify({ email: fields.get('email'), role: fields.get('role') }),
      });
      setInvitation(result.token);
    }, 'Invitation created. Share the link privately; the token is shown only now.');
  }

  async function savePolicy(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    if (
      draftSteps.some((step) => step.responderMembershipId === '') ||
      new Set(draftSteps.map((step) => step.responderMembershipId)).size !== draftSteps.length
    ) {
      setMessage('Choose a different active responder for each escalation step.');
      return;
    }
    await mutate(
      async () => {
        await apiRequest(
          editingPolicyId === null
            ? `${prefix}/policies`
            : `${prefix}/policies/${editingPolicyId}/revisions`,
          {
            method: 'POST',
            body: JSON.stringify({
              name: fields.get('name'),
              description: fields.get('description'),
              ...(editingPolicyId === null
                ? { makeDefault: fields.get('makeDefault') === 'on' }
                : {}),
              steps: draftSteps,
            }),
          },
        );
        setEditingPolicyId(null);
        setDraftSteps([{ responderMembershipId: '', waitSeconds: 600 }]);
      },
      editingPolicyId === null ? 'Policy created.' : 'New immutable policy revision activated.',
    );
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    await mutate(async () => {
      const slackWebhookUrl = fields.get('slackWebhookUrl');
      const discordWebhookUrl = fields.get('discordWebhookUrl');
      setSettings(
        await apiRequest<NotificationSettings>(`${prefix}/notification-settings`, {
          method: 'PUT',
          body: JSON.stringify({
            emailEnabled: fields.get('emailEnabled') === 'on',
            slackEnabled: fields.get('slackEnabled') === 'on',
            discordEnabled: fields.get('discordEnabled') === 'on',
            ...(typeof slackWebhookUrl === 'string' && slackWebhookUrl !== ''
              ? { slackWebhookUrl }
              : {}),
            ...(typeof discordWebhookUrl === 'string' && discordWebhookUrl !== ''
              ? { discordWebhookUrl }
              : {}),
          }),
        }),
      );
    }, 'Notification settings saved.');
  }

  async function loadMoreAudit() {
    const cursor = audit.at(-1)?.id;
    if (!cursor) return;
    setBusy(true);
    try {
      const next = await apiRequest<AuditEntry[]>(`${prefix}/audit-logs?after=${cursor}`);
      setAudit((current) => [...current, ...next]);
      setHasMoreAudit(next.length === 50);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : 'Could not load more audit entries.');
    } finally {
      setBusy(false);
    }
  }

  const responders = props.members.filter(
    (member) => member.status === 'ACTIVE' && member.role === 'RESPONDER',
  );
  const editingPolicy = policies?.policies.find((policy) => policy.id === editingPolicyId);

  return (
    <div className="administration-panel">
      <div className="admin-tabs" role="tablist" aria-label="Administration sections">
        {(
          [
            ['members', Users, 'Members'],
            ['policies', Settings2, 'Policies'],
            ['notifications', Bell, 'Notifications'],
            ['audit', BookOpen, 'Audit log'],
          ] as const
        ).map(([id, Icon, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={section === id}
            className={section === id ? 'active' : ''}
            onClick={() => {
              setSection(id);
              setInvitation(null);
            }}
          >
            <Icon size={17} /> {label}
          </button>
        ))}
      </div>
      {message && (
        <p className="admin-message" role="status">
          {message}
        </p>
      )}

      {section === 'members' && (
        <div className="admin-grid">
          <section className="dash-panel admin-card">
            <div className="dash-panel-heading">
              <div>
                <p className="panel-kicker">Access</p>
                <h2>Team members</h2>
              </div>
              <span>{props.members.length}</span>
            </div>
            <div className="admin-rows">
              {props.members.map((member) => (
                <div className="admin-row" key={member.id}>
                  <div>
                    <strong>{member.displayName}</strong>
                    <small>{member.status}</small>
                  </div>
                  <div className="admin-row-actions">
                    <select
                      aria-label={`Role for ${member.displayName}`}
                      value={member.role}
                      disabled={busy || (member.role === 'OWNER' && props.role !== 'OWNER')}
                      onChange={(event) =>
                        void mutate(async () => {
                          await apiRequest(`${prefix}/members/${member.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify({ role: event.target.value }),
                          });
                        }, 'Member role updated.')
                      }
                    >
                      {(['OWNER', 'ADMIN', 'RESPONDER', 'REPORTER'] as const)
                        .filter(
                          (role) =>
                            role !== 'OWNER' || props.role === 'OWNER' || member.role === 'OWNER',
                        )
                        .map((role) => (
                          <option key={role} value={role}>
                            {role}
                          </option>
                        ))}
                    </select>
                    <button
                      type="button"
                      disabled={busy || (member.role === 'OWNER' && props.role !== 'OWNER')}
                      onClick={() =>
                        void mutate(async () => {
                          await apiRequest(`${prefix}/members/${member.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify({
                              status: member.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE',
                            }),
                          });
                        }, 'Member status updated.')
                      }
                    >
                      {member.status === 'ACTIVE' ? 'Suspend' : 'Activate'}
                    </button>
                    <button
                      type="button"
                      disabled={busy || (member.role === 'OWNER' && props.role !== 'OWNER')}
                      onClick={() => {
                        if (!window.confirm(`Remove ${member.displayName} from this organization?`))
                          return;
                        void mutate(async () => {
                          await apiRequest(`${prefix}/members/${member.id}`, { method: 'DELETE' });
                        }, 'Member removed.');
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
          <section className="dash-panel admin-card">
            <div className="dash-panel-heading">
              <div>
                <p className="panel-kicker">Onboarding</p>
                <h2>Invite a teammate</h2>
              </div>
            </div>
            <form className="form-stack" onSubmit={(event) => void invite(event)}>
              <label className="field">
                <span>Email</span>
                <input name="email" type="email" required />
              </label>
              <label className="field">
                <span>Role</span>
                <select name="role" defaultValue="RESPONDER">
                  <option value="RESPONDER">Responder</option>
                  <option value="REPORTER">Reporter</option>
                  <option value="ADMIN">Admin</option>
                  {props.role === 'OWNER' && <option value="OWNER">Owner</option>}
                </select>
              </label>
              <button className="primary-button" type="submit" disabled={busy}>
                Create invitation <ArrowRight size={16} />
              </button>
            </form>
            {invitation && (
              <div className="invitation-link">
                <small>One-time invitation link</small>
                <code>{`${window.location.origin}/sign-in?invitation=${invitation}`}</code>
              </div>
            )}
          </section>
        </div>
      )}

      {section === 'policies' && (
        <div className="admin-grid">
          <section className="dash-panel admin-card">
            <div className="dash-panel-heading">
              <div>
                <p className="panel-kicker">Escalation</p>
                <h2>Policies</h2>
              </div>
            </div>
            <div className="admin-rows">
              {policies?.policies.map((policy) => (
                <div className="admin-row" key={policy.id}>
                  <div>
                    <strong>{policy.name}</strong>
                    <small>
                      Revision {policy.activeVersion?.revision ?? '—'} ·{' '}
                      {policy.activeVersion?.steps.length ?? 0} steps
                      {policy.archivedAt ? ' · archived' : ''}
                    </small>
                  </div>
                  <div className="admin-row-actions">
                    {policies.defaultPolicyId === policy.id ? (
                      <span className="admin-tag">Default</span>
                    ) : !policy.archivedAt ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void mutate(async () => {
                            await apiRequest(`${prefix}/default-policy`, {
                              method: 'PUT',
                              body: JSON.stringify({ policyId: policy.id }),
                            });
                          }, 'Default policy changed.')
                        }
                      >
                        Make default
                      </button>
                    ) : null}
                    {!policy.archivedAt && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setEditingPolicyId(policy.id);
                          setDraftSteps(
                            policy.activeVersion?.steps.map((step) => ({
                              responderMembershipId: step.responderMembershipId,
                              waitSeconds: step.waitSeconds,
                            })) ?? [{ responderMembershipId: '', waitSeconds: 600 }],
                          );
                        }}
                      >
                        Revise
                      </button>
                    )}
                    {!policy.archivedAt && policies.defaultPolicyId !== policy.id && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Archive ${policy.name}? Existing incidents retain this revision.`,
                            )
                          )
                            return;
                          void mutate(async () => {
                            await apiRequest(`${prefix}/policies/${policy.id}/archive`, {
                              method: 'POST',
                            });
                          }, 'Policy archived.');
                        }}
                      >
                        Archive
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
          <section className="dash-panel admin-card">
            <div className="dash-panel-heading">
              <div>
                <p className="panel-kicker">Routing</p>
                <h2>{editingPolicy ? `Revise ${editingPolicy.name}` : 'Create policy'}</h2>
              </div>
            </div>
            <form
              className="form-stack"
              onSubmit={(event) => void savePolicy(event)}
              key={editingPolicyId ?? 'new'}
            >
              <label className="field">
                <span>Name</span>
                <input
                  name="name"
                  required
                  maxLength={120}
                  defaultValue={editingPolicy?.name ?? ''}
                />
              </label>
              <label className="field">
                <span>Description</span>
                <input
                  name="description"
                  maxLength={1000}
                  defaultValue={editingPolicy?.description ?? ''}
                />
              </label>
              {draftSteps.map((step, index) => (
                <div className="admin-policy-step" key={index}>
                  <strong>Step {index + 1}</strong>
                  <label className="field">
                    <span>Responder</span>
                    <select
                      required
                      value={step.responderMembershipId}
                      onChange={(event) =>
                        setDraftSteps((current) =>
                          current.map((item, position) =>
                            position === index
                              ? { ...item, responderMembershipId: event.target.value }
                              : item,
                          ),
                        )
                      }
                    >
                      <option value="">Select responder</option>
                      {responders.map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Escalate after (seconds)</span>
                    <input
                      type="number"
                      min="1"
                      max="604800"
                      required
                      value={step.waitSeconds}
                      onChange={(event) =>
                        setDraftSteps((current) =>
                          current.map((item, position) =>
                            position === index
                              ? { ...item, waitSeconds: Number(event.target.value) }
                              : item,
                          ),
                        )
                      }
                    />
                  </label>
                  {draftSteps.length > 1 && (
                    <button
                      className="admin-secondary"
                      type="button"
                      onClick={() =>
                        setDraftSteps((current) =>
                          current.filter((_, position) => position !== index),
                        )
                      }
                    >
                      Remove step
                    </button>
                  )}
                </div>
              ))}
              {draftSteps.length < responders.length && (
                <button
                  className="admin-secondary"
                  type="button"
                  onClick={() =>
                    setDraftSteps((current) => [
                      ...current,
                      { responderMembershipId: '', waitSeconds: 600 },
                    ])
                  }
                >
                  Add escalation step
                </button>
              )}
              {editingPolicyId === null && (
                <label className="admin-check">
                  <input name="makeDefault" type="checkbox" /> Make this the default policy
                </label>
              )}
              <button
                className="primary-button"
                type="submit"
                disabled={busy || responders.length === 0}
              >
                {editingPolicyId === null ? 'Create policy' : 'Activate revision'}{' '}
                <ArrowRight size={16} />
              </button>
              {editingPolicyId && (
                <button
                  className="admin-secondary"
                  type="button"
                  onClick={() => {
                    setEditingPolicyId(null);
                    setDraftSteps([{ responderMembershipId: '', waitSeconds: 600 }]);
                  }}
                >
                  Cancel revision
                </button>
              )}
            </form>
          </section>
        </div>
      )}

      {section === 'notifications' && settings && (
        <section className="dash-panel admin-card admin-narrow">
          <div className="dash-panel-heading">
            <div>
              <p className="panel-kicker">Delivery</p>
              <h2>Notification settings</h2>
            </div>
          </div>
          <form
            className="form-stack"
            onSubmit={(event) => void saveSettings(event)}
            key={props.organizationId + JSON.stringify(settings)}
          >
            <label className="admin-check">
              <input type="checkbox" name="emailEnabled" defaultChecked={settings.emailEnabled} />{' '}
              Email responders
            </label>
            <label className="admin-check">
              <input type="checkbox" name="slackEnabled" defaultChecked={settings.slackEnabled} />{' '}
              Slack webhook {settings.slackConfigured && <span>configured</span>}
            </label>
            <label className="field">
              <span>New Slack webhook URL (leave blank to retain)</span>
              <input name="slackWebhookUrl" type="url" autoComplete="off" />
            </label>
            <label className="admin-check">
              <input
                type="checkbox"
                name="discordEnabled"
                defaultChecked={settings.discordEnabled}
              />{' '}
              Discord webhook {settings.discordConfigured && <span>configured</span>}
            </label>
            <label className="field">
              <span>New Discord webhook URL (leave blank to retain)</span>
              <input name="discordWebhookUrl" type="url" autoComplete="off" />
            </label>
            <button className="primary-button" type="submit" disabled={busy}>
              Save settings
            </button>
          </form>
          <button
            className="admin-secondary"
            type="button"
            disabled={busy}
            onClick={() =>
              void mutate(async () => {
                await apiRequest(`${prefix}/notification-settings/test`, { method: 'POST' });
              }, 'Test delivery queued.')
            }
          >
            Send test notification
          </button>
        </section>
      )}

      {section === 'audit' && (
        <section className="dash-panel admin-card">
          <div className="dash-panel-heading">
            <div>
              <p className="panel-kicker">History</p>
              <h2>Organization audit</h2>
            </div>
            <button className="admin-secondary" type="button" onClick={() => void refresh()}>
              <RefreshCw size={15} /> Refresh
            </button>
          </div>
          <div className="admin-rows">
            {audit.length === 0 && <p className="admin-empty">No audit entries yet.</p>}
            {audit.map((entry) => (
              <div className="admin-row" key={entry.id}>
                <div>
                  <strong>{entry.action.replaceAll('.', ' / ')}</strong>
                  <small>
                    {entry.actorType === 'SYSTEM'
                      ? 'System'
                      : (props.members.find((member) => member.id === entry.actorMembershipId)
                          ?.displayName ?? 'Former member')}{' '}
                    · {new Date(entry.createdAt).toLocaleString()}
                  </small>
                </div>
                {entry.incidentId && <code>{entry.incidentId.slice(0, 8)}</code>}
              </div>
            ))}
          </div>
          {hasMoreAudit && (
            <button
              className="admin-secondary"
              type="button"
              disabled={busy}
              onClick={() => void loadMoreAudit()}
            >
              Load more
            </button>
          )}
        </section>
      )}
    </div>
  );
}
