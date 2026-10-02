import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SignupForm } from '@/features/auth/signup-form';

export const metadata: Metadata = { title: 'Create your account' };

export default function Page() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}
