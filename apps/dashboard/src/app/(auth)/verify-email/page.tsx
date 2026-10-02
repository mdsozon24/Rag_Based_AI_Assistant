import type { Metadata } from 'next';
import { Suspense } from 'react';
import { VerifyEmail } from '@/features/auth/token-pages';

export const metadata: Metadata = { title: 'Confirm your email' };

export default function Page() {
  return (
    <Suspense>
      <VerifyEmail />
    </Suspense>
  );
}
