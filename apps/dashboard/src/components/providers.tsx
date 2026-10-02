'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { ToastProvider } from '@/components/ui/toast';
import { ApiError } from '@/lib/api/client';

/** Pages anyone may open; a 401 there is expected, not an expired session. */
export const PUBLIC_PATHS = ['/login', '/signup', '/verify-email', '/forgot-password', '/reset-password', '/invite'];

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        // A 4xx will not change by asking again; network and 5xx errors get two more tries
        retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}

export function Providers({ children }: { children: ReactNode }) {
  // One client per browser tab, kept across renders
  const [client] = useState(makeClient);
  const router = useRouter();

  // A session that expires while the dashboard is open: drop every cached org row, sign in again,
  // then come back to the same page
  useEffect(() => {
    const onError = (error: unknown) => {
      if (!(error instanceof ApiError) || error.status !== 401) return;
      const { pathname, search } = window.location;
      if (isPublicPath(pathname)) return;
      client.clear();
      router.replace(`/login?next=${encodeURIComponent(pathname + search)}`);
    };
    const queries = client.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') onError(event.action.error);
    });
    const mutations = client.getMutationCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') onError(event.action.error);
    });
    return () => {
      queries();
      mutations();
    };
  }, [client, router]);

  return (
    <QueryClientProvider client={client}>
      <ToastProvider>{children}</ToastProvider>
    </QueryClientProvider>
  );
}
