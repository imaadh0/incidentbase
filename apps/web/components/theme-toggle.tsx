'use client';

import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState<Theme>('light');

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  }, []);

  const nextTheme = theme === 'light' ? 'dark' : 'light';
  return (
    <button
      className={`theme-toggle${compact ? ' compact' : ''}`}
      type="button"
      aria-label={`Switch to ${nextTheme} mode`}
      title={`Switch to ${nextTheme} mode`}
      onClick={() => {
        document.documentElement.dataset.theme = nextTheme;
        localStorage.setItem('incidentbase.theme', nextTheme);
        setTheme(nextTheme);
      }}
    >
      {theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
      {!compact && <span>{theme === 'light' ? 'Dark mode' : 'Light mode'}</span>}
    </button>
  );
}
