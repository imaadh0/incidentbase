'use client';

import { PASSWORD_MIN_LENGTH } from '@incidentbase/contracts';
import { Activity, ArrowRight, CheckCircle2, RefreshCw, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import {
  useState,
  useEffect,
  useRef,
  type ChangeEvent,
  type FocusEvent,
  type FormEvent,
  type InputHTMLAttributes,
} from 'react';

import { ApiError, apiRequest, type Account, type InvitationPreview } from '../lib/api';

type AuthMode = 'login' | 'register';
type FieldName =
  | 'displayName'
  | 'organizationName'
  | 'organizationSlug'
  | 'email'
  | 'password'
  | 'confirmPassword'
  | 'code';
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
  if (name === 'confirmPassword') {
    if (!input.value) return 'Re-enter your password.';
    const password = input.form?.elements.namedItem('password');
    return password instanceof HTMLInputElement && input.value !== password.value
      ? 'Passwords do not match.'
      : null;
  }
  if (!input.value) return 'Enter your password.';
  if (mode === 'register' && input.value.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  return input.value.length > 128 ? 'Use 128 characters or fewer.' : null;
}

export function AuthenticationScreen({
  onAuthenticated,
}: {
  onAuthenticated: (organizationId?: string) => void;
}) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [invitationToken, setInvitationToken] = useState<string | null>(null);
  const [invitation, setInvitation] = useState<InvitationPreview | null>(null);
  const [invitationLoading, setInvitationLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [resendAvailableAt, setResendAvailableAt] = useState(0);
  const [canResend, setCanResend] = useState(false);
  const checkedExistingSession = useRef(false);

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('invitation');
    if (token === null) return;
    setInvitationToken(token);
    setInvitationLoading(true);
    void apiRequest<InvitationPreview>(`/invitations/${encodeURIComponent(token)}`, {}, false)
      .then((preview) => {
        setInvitation(preview);
        setMode(preview.hasAccount ? 'login' : 'register');
        if (preview.outcome === 'EXPIRED')
          setError('This invitation has expired. Ask for a new link.');
        if (preview.outcome === 'USED') setError('This invitation has already been used.');
      })
      .catch((caught: unknown) =>
        setError(caught instanceof Error ? caught.message : 'Unable to load the invitation.'),
      )
      .finally(() => setInvitationLoading(false));
  }, []);

  useEffect(() => {
    if (!pendingId) return;
    const remaining = Math.max(0, resendAvailableAt - Date.now());
    const timer = window.setTimeout(() => setCanResend(true), remaining);
    return () => window.clearTimeout(timer);
  }, [pendingId, resendAvailableAt]);

  useEffect(() => {
    if (
      invitationToken === null ||
      invitation?.outcome !== 'AVAILABLE' ||
      checkedExistingSession.current
    )
      return;
    checkedExistingSession.current = true;
    void apiRequest<Account>('/auth/me', {}, false)
      .then(async (account) => {
        if (account.user.email !== invitation.email) {
          setError(
            `You are signed in as ${account.user.email}. Sign in with ${invitation.email} to accept this invitation.`,
          );
          return;
        }
        setSubmitting(true);
        try {
          await apiRequest(`/invitations/${encodeURIComponent(invitationToken)}/accept`, {
            method: 'POST',
          });
          onAuthenticated(invitation.organizationId);
        } catch (caught: unknown) {
          setError(caught instanceof Error ? caught.message : 'Unable to accept the invitation.');
          setSubmitting(false);
        }
      })
      .catch((caught: unknown) => {
        if (!(caught instanceof ApiError && caught.status === 401)) {
          setError(caught instanceof Error ? caught.message : 'Unable to check your session.');
        }
      });
  }, [invitation, invitationToken, onAuthenticated]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const form = event.currentTarget;
    const names: FieldName[] =
      mode === 'register'
        ? invitationToken !== null
          ? ['displayName', 'email', 'password', 'confirmPassword']
          : [
              'displayName',
              'organizationName',
              'organizationSlug',
              'email',
              'password',
              'confirmPassword',
            ]
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
      if (mode === 'register') {
        const pending = await apiRequest<{ pendingId: string; email: string }>(
          invitationToken !== null
            ? `/invitations/${encodeURIComponent(invitationToken)}/register`
            : '/auth/register',
          { body: JSON.stringify(body), method: 'POST' },
          false,
        );
        setPendingId(pending.pendingId);
        setPendingEmail(pending.email);
        setResendAvailableAt(Date.now() + 60_000);
        setCanResend(false);
        return;
      }
      const account = await apiRequest<Account>(
        invitationToken !== null
          ? `/invitations/${encodeURIComponent(invitationToken)}/login`
          : `/auth/${mode}`,
        { body: JSON.stringify(body), method: 'POST' },
        false,
      );
      if (invitationToken !== null && account.user.email !== invitation?.email) {
        throw new Error('This invitation belongs to another email address.');
      }
      onAuthenticated(invitationToken !== null ? invitation?.organizationId : undefined);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Authentication failed.');
    } finally {
      setSubmitting(false);
    }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingId) return;
    setError(null);
    setSubmitting(true);
    const code = new FormData(event.currentTarget).get('code');
    try {
      const account = await apiRequest<Account>(
        '/auth/verify-email',
        {
          method: 'POST',
          body: JSON.stringify({ pendingId, code }),
        },
        false,
      );
      onAuthenticated(
        invitationToken !== null
          ? invitation?.organizationId
          : account.memberships[0]?.organizationId,
      );
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Could not verify the code.');
    } finally {
      setSubmitting(false);
    }
  }

  async function resendCode() {
    if (!pendingId || Date.now() < resendAvailableAt) return;
    setError(null);
    setSubmitting(true);
    try {
      await apiRequest(
        '/auth/resend-verification',
        {
          method: 'POST',
          body: JSON.stringify({ pendingId }),
        },
        false,
      );
      setResendAvailableAt(Date.now() + 60_000);
      setCanResend(false);
      setError('A new code has been sent.');
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Could not resend the code.');
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
    if (invitationToken === null || invitation?.outcome === 'AVAILABLE') setError(null);
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
        {pendingId !== null ? (
          <div className="form-stack">
            <p className="eyebrow">Email verification</p>
            <h2>Check your inbox</h2>
            <p className="auth-intro">
              Enter the six-digit code sent to {pendingEmail}. It expires in 10 minutes.
            </p>
            <form className="form-stack" onSubmit={(event) => void verifyCode(event)}>
              <Field
                label="Verification code"
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
              />
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <button className="primary-button full" type="submit" disabled={submitting}>
                Verify and continue <ArrowRight size={17} />
              </button>
            </form>
            <button
              className="auth-demo-link"
              type="button"
              disabled={submitting || !canResend}
              onClick={() => void resendCode()}
            >
              Resend code
            </button>
            <button
              className="auth-demo-link"
              type="button"
              disabled={submitting}
              onClick={() => {
                setPendingId(null);
                setPendingEmail(null);
                setError(null);
              }}
            >
              Start over
            </button>
          </div>
        ) : (
          <>
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
                {invitationToken !== null ? 'Create account' : 'Create workspace'}
              </button>
            </div>
            <div>
              <p className="eyebrow">
                {invitationToken !== null
                  ? 'Organization invitation'
                  : mode === 'login'
                    ? 'Welcome back'
                    : 'Start responding'}
              </p>
              <h2>
                {invitationToken !== null
                  ? `Join ${invitation?.organizationName ?? 'your organization'}`
                  : mode === 'login'
                    ? 'Sign in to your operations center'
                    : 'Create your IncidentBase workspace'}
              </h2>
              {invitation && (
                <p className="auth-intro">
                  Invited as {invitation.role.toLowerCase()} to {invitation.organizationName}.
                </p>
              )}
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
                  {invitationToken === null && (
                    <Field
                      label="Organization name"
                      name="organizationName"
                      autoComplete="organization"
                      {...fieldValidation('organizationName')}
                    />
                  )}
                  {invitationToken === null && (
                    <Field
                      label="Organization slug"
                      name="organizationSlug"
                      placeholder="acme-cloud"
                      {...fieldValidation('organizationSlug')}
                    />
                  )}
                </>
              )}
              <Field
                label="Email"
                name="email"
                type="email"
                autoComplete="email"
                readOnly={invitationToken !== null}
                value={invitationToken !== null ? (invitation?.email ?? '') : undefined}
                hint={
                  invitationToken !== null
                    ? 'This invitation is for this email address only.'
                    : undefined
                }
                {...fieldValidation('email')}
              />
              <Field
                label="Password"
                name="password"
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                hint={
                  mode === 'register' ? `At least ${PASSWORD_MIN_LENGTH} characters.` : undefined
                }
                {...fieldValidation('password')}
              />
              {mode === 'register' && (
                <Field
                  label="Confirm password"
                  name="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  {...fieldValidation('confirmPassword')}
                />
              )}
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              <button
                className="primary-button full"
                disabled={
                  submitting ||
                  invitationLoading ||
                  (invitationToken !== null && invitation?.outcome !== 'AVAILABLE')
                }
                type="submit"
              >
                {submitting
                  ? 'Working…'
                  : mode === 'login'
                    ? 'Sign in'
                    : invitationToken !== null
                      ? 'Create account and join'
                      : 'Create workspace'}
                <ArrowRight size={17} />
              </button>
            </form>
            <Link className="auth-demo-link" href="/demo">
              Want to look around first? View demo <ArrowRight size={15} />
            </Link>
          </>
        )}
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
