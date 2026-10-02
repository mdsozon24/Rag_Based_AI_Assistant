'use client';

import { useRouter, usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { ApiError } from '@/lib/api/client';
import { sessionOf, SessionProvider, useMe, useOrgSwitch } from '@/lib/session';
import { Logo } from './logo';
import { SidebarNav } from './sidebar';
import { CreateOrgDialog, MobileNav, OrgSwitcher, ThemeMenu, UserMenu } from './topbar';

/**
 * Everything behind sign-in. Resolves the session (GET /v1/me): no session → sign-in page; no
 * active org → choose or create one; otherwise the shell with navigation.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const unauthenticated = me.error instanceof ApiError && me.error.status === 401;

  useEffect(() => {
    if (unauthenticated) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [unauthenticated, router, pathname]);

  if (me.isPending || unauthenticated) {
    return (
      <div className="mx-auto max-w-md px-4 py-24">
        <LoadingState label="Loading your workspace…" rows={2} />
      </div>
    );
  }
  if (me.isError) {
    return (
      <div className="mx-auto max-w-md px-4 py-24">
        <ErrorState error={me.error} title="Could not load your account" onRetry={() => void me.refetch()} />
      </div>
    );
  }
  const session = sessionOf(me.data);
  if (!session) return <NoActiveOrg />;

  return (
    <SessionProvider value={session}>
      <a href="#main" className="sr-only z-50 rounded-md bg-surface px-3 py-2 text-sm font-medium text-text focus:not-sr-only focus:fixed focus:top-2 focus:left-2">
        Skip to main content
      </a>
      <div className="flex min-h-dvh">
        <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface lg:flex">
          <div className="border-b border-border px-5 py-4">
            <Logo />
          </div>
          <SidebarNav />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-surface/95 px-3 backdrop-blur sm:px-5">
            <MobileNav />
            <span className="lg:hidden">
              <Logo compact />
            </span>
            <OrgSwitcher />
            <div className="ml-auto flex items-center gap-1">
              <ThemeMenu />
              <UserMenu />
            </div>
          </header>
          <main id="main" tabIndex={-1} className="flex-1 outline-none">
            {children}
          </main>
        </div>
      </div>
    </SessionProvider>
  );
}

/** Signed in, but not in any organization (or left the active one). */
function NoActiveOrg() {
  const me = useMe();
  const { switchTo } = useOrgSwitch();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const orgs = me.data?.orgs ?? [];
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-5 px-4 py-16">
      <Logo />
      <div>
        <h1 className="text-2xl font-semibold text-text">Choose an organization</h1>
        <p className="mt-1 text-sm text-muted">{orgs.length ? 'Pick the organization to work in.' : 'You are not in any organization yet. Create one, or ask an admin to invite you.'}</p>
      </div>
      {orgs.length ? (
        <ul className="flex flex-col gap-2">
          {orgs.map((org) => (
            <li key={org.id}>
              <Button
                className="h-auto w-full justify-start py-3"
                onClick={async () => {
                  try {
                    await switchTo(org.id);
                  } catch (error) {
                    toast.error('Could not open this organization', error);
                  }
                }}
              >
                <Building2 aria-hidden="true" />
                <span className="flex-1 text-left">{org.name}</span>
                <span className="text-xs text-muted capitalize">{org.role}</span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <Button variant="primary" onClick={() => setCreating(true)} className="self-start">
        Create organization
      </Button>
      <CreateOrgDialog open={creating} onOpenChange={setCreating} />
    </main>
  );
}
