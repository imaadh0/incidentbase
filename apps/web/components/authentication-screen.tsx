'use client';

import { Activity, ArrowRight, CheckCircle2, RefreshCw, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useState, type FormEvent, type InputHTMLAttributes } from 'react';

import { apiRequest, type Account } from '../lib/api';

type AuthMode = 'login' | 'register';

export function AuthenticationScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
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
      await apiRequest<Account>(
        `/auth/${mode}`,
        { body: JSON.stringify(body), method: 'POST' },
        false,
      );
      const invitation = new URLSearchParams(window.location.search).get('invitation');
      if (invitation !== null) {
        await apiRequest(`/invitations/${encodeURIComponent(invitation)}/accept`, {
          method: 'POST',
        });
      }
      onAuthenticated();
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Authentication failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-story">
        <Link className="brand large" href="/" aria-label="IncidentBase home">
          <span className="brand-mark">
            <Activity size={22} />
          </span>
          IncidentBase
        </Link>
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
          {mode === 'register' && (
            <>
              <Field label="Your name" name="displayName" autoComplete="name" />
              <Field
                label="Organization name"
                name="organizationName"
                autoComplete="organization"
              />
              <Field label="Organization slug" name="organizationSlug" placeholder="acme-cloud" />
            </>
          )}
          <Field label="Email" name="email" type="email" autoComplete="email" />
          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={mode === 'register' ? 12 : 1}
          />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary-button full" disabled={submitting} type="submit">
            {submitting ? 'Working…' : mode === 'login' ? 'Sign in' : 'Create workspace'}
            <ArrowRight size={17} />
          </button>
        </form>
        <Link className="auth-demo-link" href="/demo">
          Want to look around first? View demo <ArrowRight size={15} />
        </Link>
      </section>
    </main>
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
