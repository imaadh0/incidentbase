'use client';

import { ArrowRight, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';

export type WelcomeKind = 'new' | 'returning';
export const welcomeStorageKey = 'incidentbase.welcome';

export function WelcomeMoment({
  kind,
  name,
  onDone,
}: {
  kind: WelcomeKind;
  name: string;
  onDone: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setLeaving(true), 1650);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(onDone, 260);
    return () => window.clearTimeout(timer);
  }, [leaving, onDone]);
  return (
    <div
      className={`welcome-overlay${leaving ? ' is-leaving' : ''}`}
      role="status"
      aria-live="polite"
    >
      <div className="welcome-card">
        <span className="welcome-mark">
          <Sparkles size={23} aria-hidden="true" />
        </span>
        <span className="welcome-kicker">IncidentBase</span>
        <strong>
          {kind === 'new' ? 'Welcome aboard' : 'Welcome back'}
          {name ? `, ${name.split(/\s+/u)[0]}` : ''}.
        </strong>
        <p>
          {kind === 'new'
            ? 'Your workspace is ready. Let’s keep the response moving.'
            : 'Your workspace is ready when you are.'}
        </p>
        <button type="button" onClick={onDone}>
          Go to workspace <ArrowRight size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
