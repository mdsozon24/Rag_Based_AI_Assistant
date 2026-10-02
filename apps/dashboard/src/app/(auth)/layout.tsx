import type { ReactNode } from 'react';
import { Logo } from '@/components/shell/logo';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="mb-6">
        <Logo />
      </div>
      <main id="main" className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-card sm:p-8">
        {children}
      </main>
    </div>
  );
}
