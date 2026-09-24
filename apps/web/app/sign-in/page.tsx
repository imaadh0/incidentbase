'use client';

import { useRouter } from 'next/navigation';

import { ThemeToggle } from '../../components/theme-toggle';
import { AuthenticationScreen } from '../../components/authentication-screen';

export default function SignInPage() {
  const router = useRouter();
  return (
    <div className="sign-in-route">
      <div className="auth-theme">
        <ThemeToggle compact />
      </div>
      <AuthenticationScreen onAuthenticated={() => router.replace('/app')} />
    </div>
  );
}
