'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { Activity, ArrowRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export type WelcomeKind = 'new' | 'returning';
export const welcomeStorageKey = 'incidentbase.welcome';

export function WelcomeMoment({
  kind,
  name,
  workspaceName,
  onDone,
}: {
  kind: WelcomeKind;
  name: string;
  workspaceName: string;
  onDone: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => onDoneRef.current(), 200);
    return () => window.clearTimeout(timer);
  }, [leaving]);
  const firstName = name.trim().split(/\s+/u)[0];
  function leave() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onDoneRef.current();
    } else {
      setLeaving(true);
    }
  }

  return (
    <Dialog.Root
      open={!leaving}
      onOpenChange={(open) => {
        if (!open) leave();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="welcome-overlay" />
        <Dialog.Content className="welcome-card">
          <div className="welcome-topline">
            <span className="welcome-brand">
              <Activity size={18} strokeWidth={2.2} aria-hidden="true" />
              IncidentBase
            </span>
            <span className="welcome-index">{workspaceName}</span>
          </div>
          <div className="welcome-body">
            <span className="welcome-rule" aria-hidden="true" />
            <p className="welcome-kicker">{kind === 'new' ? 'SETUP COMPLETE' : 'SIGNED IN'}</p>
            <Dialog.Title>
              {kind === 'new'
                ? 'Your workspace is ready.'
                : `Welcome back${firstName ? `, ${firstName}` : ''}.`}
            </Dialog.Title>
            <Dialog.Description>
              {kind === 'new'
                ? 'Invite your team or create your first incident.'
                : `Signed in to ${workspaceName}.`}
            </Dialog.Description>
          </div>
          <div className="welcome-footer">
            <button className="welcome-enter" type="button" onClick={leave}>
              Open workspace <ArrowRight size={17} aria-hidden="true" />
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
