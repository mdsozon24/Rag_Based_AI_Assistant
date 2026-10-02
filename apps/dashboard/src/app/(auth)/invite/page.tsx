import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AcceptInvitation } from '@/features/auth/token-pages';

export const metadata: Metadata = { title: 'Accept invitation' };

export default function Page() {
  return (
    <Suspense>
      <AcceptInvitation />
    </Suspense>
  );
}
