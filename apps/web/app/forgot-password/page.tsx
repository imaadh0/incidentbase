'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Activity, ArrowRight } from 'lucide-react';

import { apiRequest } from '../../lib/api';
import { ThemeToggle } from '../../components/theme-toggle';

export default function ForgotPasswordPage() {
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    const email = new FormData(event.currentTarget).get('email');
    const address = typeof email === 'string' ? email.trim() : '';
    if (!address || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address)) {
      setError('Enter a valid email address.');
      setSubmitting(false);
      return;
    }
    try {
      await apiRequest(
        '/auth/forgot-password',
        {
          method: 'POST',
          body: JSON.stringify({ email: address }),
        },
        false,
      );
      setSent(true);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : 'Please try again shortly.');
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
          <h1>Get back to your workspace.</h1>
          <p className="auth-intro">A secure link will help you choose a new password.</p>
        </section>
        <section className="auth-card">
          <p className="eyebrow">Password reset</p>
          <h2>{sent ? 'Check your inbox' : 'Forgot your password?'}</h2>
          {sent ? (
            <p className="auth-intro" role="status">
              If that email has an account, a reset link is on its way. It expires in 30 minutes.
            </p>
          ) : (
            <form className="form-stack" noValidate onSubmit={(event) => void submit(event)}>
              <p className="auth-intro">Enter the email you use to sign in.</p>
              <div className="field">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  maxLength={320}
                  aria-invalid={Boolean(error)}
                  aria-describedby={error ? 'recovery-error' : undefined}
                />
              </div>
              {error && (
                <p id="recovery-error" className="form-error" role="alert">
                  {error}
                </p>
              )}
              <button className="primary-button full" type="submit" disabled={submitting}>
                {submitting ? 'Sending…' : 'Send reset link'}{' '}
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
