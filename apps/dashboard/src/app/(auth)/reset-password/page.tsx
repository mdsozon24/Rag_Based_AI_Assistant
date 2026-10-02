import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ResetPassword } from '@/features/auth/token-pages';

export const metadata: Metadata = { title: 'Choose a new password' };

export default function Page() {
  return (
    <Suspense>
      <ResetPassword />
    </Suspense>
  );
}
