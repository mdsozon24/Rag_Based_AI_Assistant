'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { get, post, put } from '@/lib/api/client';
import { can, type Permission, type Role } from '@/lib/permissions';

export interface MeOrg {
  id: string;
  name: string;
  slug: string;
  role: Role;
  status: 'active' | 'suspended';
}

export interface Me {
  user: { id: string; email: string; name: string; emailVerified: boolean };
  orgs: MeOrg[];
  activeOrgId: string | null;
}

export const ME_KEY = ['me'] as const;

export function useMe() {
  return useQuery({ queryKey: ME_KEY, queryFn: ({ signal }) => get<Me>('/v1/me', undefined, signal), staleTime: 60_000, retry: false });
}

export interface Session {
  me: Me;
  org: MeOrg;
  role: Role;
  can: (permission: Permission) => boolean;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ value, children }: { value: Session; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** The signed-in user and active org; only inside the app shell. */
export function useSession(): Session {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside the app shell');
  return value;
}

export function sessionOf(me: Me): Session | null {
  const org = me.orgs.find((o) => o.id === me.activeOrgId);
  if (!org) return null;
  return { me, org, role: org.role, can: (permission) => can(org.role, permission) };
}

/**
 * Org-scoped data must never leak across a switch: everything but the profile is dropped, then
 * the profile is refetched with the new active org.
 */
export function useOrgSwitch() {
  const client = useQueryClient();
  const reset = async () => {
    client.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] });
    await client.invalidateQueries({ queryKey: ME_KEY });
  };
  return {
    switchTo: async (orgId: string) => {
      await put('/v1/me/active-org', { orgId });
      await reset();
    },
    create: async (name: string) => {
      const org = await post<{ id: string }>('/v1/orgs', { name });
      await reset();
      return org;
    },
    reset,
  };
}
