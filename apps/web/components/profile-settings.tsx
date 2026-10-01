'use client';

import { Check, Save } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { apiRequest, type Account } from '../lib/api';
import { avatarColors, UserAvatar, type AvatarColor } from './user-avatar';

export function ProfileSettings({
  account,
  onSaved,
}: {
  account: Account;
  onSaved: (account: Account) => void;
}) {
  const [name, setName] = useState(account.user.displayName);
  const [color, setColor] = useState<AvatarColor>(
    avatarColors.includes(account.user.avatarColor as AvatarColor)
      ? (account.user.avatarColor as AvatarColor)
      : 'blue',
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const displayName = name.trim();
    if (!displayName || displayName.length > 100) {
      setMessage({ text: 'Enter a name of 100 characters or fewer.', type: 'error' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const updated = await apiRequest<Account>('/auth/me', {
        method: 'PATCH',
        body: JSON.stringify({ displayName, avatarColor: color }),
      });
      onSaved(updated);
      setName(updated.user.displayName);
      setMessage({ text: 'Profile saved.', type: 'success' });
    } catch (error: unknown) {
      setMessage({
        text: error instanceof Error ? error.message : 'Could not save your profile.',
        type: 'error',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="dash-panel profile-panel" aria-labelledby="profile-title">
      <div className="dash-panel-heading">
        <div>
          <p className="panel-kicker">Personal settings</p>
          <h2 id="profile-title">Your profile</h2>
        </div>
      </div>
      <form className="profile-form" onSubmit={(event) => void save(event)}>
        <div className="profile-preview">
          <UserAvatar name={name} color={color} className="profile-avatar" />
          <div>
            <strong>{name.trim() || account.user.displayName}</strong>
            <span>{account.user.email}</span>
          </div>
        </div>
        <label className="field">
          <span>Display name</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={100}
            required
            autoComplete="name"
          />
        </label>
        <fieldset className="avatar-colors">
          <legend>Avatar color</legend>
          <div>
            {avatarColors.map((option) => (
              <label className="avatar-choice" key={option}>
                <input
                  type="radio"
                  name="avatarColor"
                  value={option}
                  checked={color === option}
                  onChange={() => setColor(option)}
                />
                <span className="avatar-swatch" data-avatar-color={option}>
                  {color === option && <Check size={15} aria-hidden="true" />}
                </span>
                <span>{option}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {message && (
          <p
            className={`profile-message ${message.type}`}
            role={message.type === 'error' ? 'alert' : 'status'}
          >
            {message.text}
          </p>
        )}
        <button className="primary-button" type="submit" disabled={busy}>
          <Save size={16} aria-hidden="true" /> {busy ? 'Saving…' : 'Save profile'}
        </button>
      </form>
    </section>
  );
}
