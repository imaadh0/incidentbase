'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Activity, ArrowRight } from 'lucide-react';
import { PASSWORD_MIN_LENGTH } from '@incidentbase/contracts';

import { apiRequest } from '../lib/api';
import { ThemeToggle } from './theme-toggle';

export function ResetPasswordScreen() {
  const token = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    token.current = new URLSearchParams(window.location.search).get('token');
    window.history.replaceState(null, '', '/reset-password');
    setReady(true);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token.current) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const passwordValue = fields.get('password');
    const confirmationValue = fields.get('confirmation');
    const password = typeof passwordValue === 'string' ? passwordValue : '';
    const confirmation = typeof confirmationValue === 'string' ? confirmationValue : '';
    if (password.length < PASSWORD_MIN_LENGTH || password.length > 128) {
      setError(`Use ${PASSWORD_MIN_LENGTH} to 128 characters.`);
      return;
    }
    if (password !== confirmation) {
      setError('Passwords do not match.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await apiRequest(
        '/auth/reset-password',
        {
          method: 'POST',
          body: JSON.stringify({ token: token.current, password }),
        },
        false,
      );
      token.current = null;
      setDone(true);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Could not reset your password.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="sign-in-route">
      <div className="auth-theme">
        <ThemeToggle compact />
      </div>
      <main className="auth-shell">
        <section className="auth-story">
          <Link className="brand large" href="/" aria-label="IncidentBase home">
            <span className="brand-mark">
              <Activity size={22} />
            </span>
            IncidentBase
          </Link>
          <p className="eyebrow">Account recovery</p>
          <h1>Make a fresh start.</h1>
          <p className="auth-intro">Your new password will sign out existing sessions.</p>
        </section>
        <section className="auth-card">
          <p className="eyebrow">Password reset</p>
          <h2>{done ? 'Password updated' : 'Choose a new password'}</h2>
          {!ready ? null : done ? (
            <>
              <p className="auth-intro" role="status">
                Your password is changed. Sign in with your new password.
              </p>
              <Link className="primary-button full" href="/sign-in">
                Sign in <ArrowRight size={17} />
              </Link>
            </>
          ) : token.current === null ? (
            <>
              <p className="auth-intro" role="alert">
                This reset link is missing or invalid.
              </p>
              <Link className="auth-demo-link" href="/forgot-password">
                Request a new link
              </Link>
            </>
          ) : (
            <form className="form-stack" noValidate onSubmit={(event) => void submit(event)}>
              <div className="field">
                <label htmlFor="password">New password</label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  maxLength={128}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? 'reset-error' : undefined}
                />
                <span className="field-hint">At least {PASSWORD_MIN_LENGTH} characters.</span>
              </div>
              <div className="field">
                <label htmlFor="confirmation">Confirm new password</label>
                <input
                  id="confirmation"
                  name="confirmation"
                  type="password"
                  autoComplete="new-password"
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? 'reset-error' : undefined}
                />
              </div>
              {error && (
                <p id="reset-error" className="form-error" role="alert">
                  {error} <Link href="/forgot-password">Request another link</Link>
                </p>
              )}
              <button className="primary-button full" type="submit" disabled={submitting}>
                {submitting ? 'Updating…' : 'Update password'}{' '}
                <ArrowRight size={17} aria-hidden="true" />
              </button>
            </form>
          )}
          <Link className="auth-demo-link" href="/sign-in">
            Back to sign in
          </Link>
        </section>
      </main>
    </div>
  );
}
