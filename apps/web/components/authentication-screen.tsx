'use client';

import { PASSWORD_MIN_LENGTH } from '@incidentbase/contracts';
import { Activity, ArrowRight, CheckCircle2, RefreshCw, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import {
  useState,
  type ChangeEvent,
  type FocusEvent,
  type FormEvent,
  type InputHTMLAttributes,
} from 'react';

import { apiRequest, type Account } from '../lib/api';

type AuthMode = 'login' | 'register';
type FieldName = 'displayName' | 'organizationName' | 'organizationSlug' | 'email' | 'password';
type FieldErrors = Partial<Record<FieldName, string>>;

function validateField(name: FieldName, input: HTMLInputElement, mode: AuthMode): string | null {
  const value = input.value.trim();
  if (name === 'displayName') {
    if (!value) return 'Enter your name.';
    return value.length > 100 ? 'Use 100 characters or fewer.' : null;
  }
  if (name === 'organizationName') {
    if (!value) return 'Enter an organization name.';
    return value.length > 120 ? 'Use 120 characters or fewer.' : null;
  }
  if (name === 'organizationSlug') {
    if (!value) return 'Enter an organization slug.';
    return value.length >= 3 && value.length <= 63 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
      ? null
      : 'Use 3–63 lowercase letters, numbers, or hyphens. Start and end with a letter or number.';
  }
  if (name === 'email') {
    if (!value) return 'Enter your email address.';
    if (value.length > 320) return 'Use 320 characters or fewer.';
    return input.validity.typeMismatch ? 'Enter a valid email address.' : null;
  }
  if (!input.value) return 'Enter your password.';
  if (mode === 'register' && input.value.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  return input.value.length > 128 ? 'Use 128 characters or fewer.' : null;
}

export function AuthenticationScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = event.currentTarget;
    const names: FieldName[] =
      mode === 'register'
        ? ['displayName', 'organizationName', 'organizationSlug', 'email', 'password']
        : ['email', 'password'];
    const nextErrors: FieldErrors = {};
    for (const name of names) {
      const input = form.elements.namedItem(name);
      if (!(input instanceof HTMLInputElement)) continue;
      const message = validateField(name, input, mode);
      if (message) nextErrors[name] = message;
    }
    setFieldErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      const firstInvalidName = names.find((name) => nextErrors[name]);
      if (firstInvalidName) {
        const firstInvalid = form.elements.namedItem(firstInvalidName);
        if (firstInvalid instanceof HTMLInputElement) firstInvalid.focus();
      }
      return;
    }
    setSubmitting(true);
    const fields = new FormData(form);
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

  function fieldValidation(name: FieldName) {
    return {
      error: fieldErrors[name],
      onBlur: (event: FocusEvent<HTMLInputElement>) => {
        const message = validateField(name, event.currentTarget, mode);
        setFieldErrors((current) => ({ ...current, [name]: message ?? undefined }));
      },
      onChange: (event: ChangeEvent<HTMLInputElement>) => {
        if (!fieldErrors[name]) return;
        const message = validateField(name, event.currentTarget, mode);
        setFieldErrors((current) => ({ ...current, [name]: message ?? undefined }));
      },
    };
  }

  function switchMode(nextMode: AuthMode) {
    setMode(nextMode);
    setError(null);
    setFieldErrors({});
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
            onClick={() => switchMode('login')}
            type="button"
          >
            Sign in
          </button>
          <button
            className={mode === 'register' ? 'active' : ''}
            onClick={() => switchMode('register')}
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
        <form className="form-stack" noValidate onSubmit={(event) => void submit(event)}>
          {mode === 'register' && (
            <>
              <Field
                label="Your name"
                name="displayName"
                autoComplete="name"
                {...fieldValidation('displayName')}
              />
              <Field
                label="Organization name"
                name="organizationName"
                autoComplete="organization"
                {...fieldValidation('organizationName')}
              />
              <Field
                label="Organization slug"
                name="organizationSlug"
                placeholder="acme-cloud"
                {...fieldValidation('organizationSlug')}
              />
            </>
          )}
          <Field
            label="Email"
            name="email"
            type="email"
            autoComplete="email"
            {...fieldValidation('email')}
          />
          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            hint={mode === 'register' ? `At least ${PASSWORD_MIN_LENGTH} characters.` : undefined}
            {...fieldValidation('password')}
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

function Field(
  props: InputHTMLAttributes<HTMLInputElement> & {
    label: string;
    name: FieldName;
    error?: string | undefined;
    hint?: string | undefined;
  },
) {
  const { label, error, hint, ...input } = props;
  const describedBy = [hint && `${input.name}-hint`, error && `${input.name}-error`]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="field">
      <label htmlFor={input.name}>{label}</label>
      <input
        {...input}
        id={input.name}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy || undefined}
      />
      {hint && (
        <span className="field-hint" id={`${input.name}-hint`}>
          {hint}
        </span>
      )}
      {error && (
        <span className="field-error" id={`${input.name}-error`} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
