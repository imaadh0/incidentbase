import type { Metadata } from 'next';
import { ResetPasswordScreen } from '../../components/reset-password-screen';

export const metadata: Metadata = { title: 'Reset password', referrer: 'no-referrer' };

export default function ResetPasswordPage() {
  return <ResetPasswordScreen />;
}
