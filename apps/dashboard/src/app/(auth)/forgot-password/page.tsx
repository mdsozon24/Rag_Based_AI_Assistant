import type { Metadata } from 'next';
import { ForgotPassword } from '@/features/auth/token-pages';

export const metadata: Metadata = { title: 'Reset your password' };

export default function Page() {
  return <ForgotPassword />;
}
