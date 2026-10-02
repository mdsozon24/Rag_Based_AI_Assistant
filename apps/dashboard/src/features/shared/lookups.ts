'use client';

import { useQuery } from '@tanstack/react-query';
import { get, type Page } from '@/lib/api/client';
import type { Credential, StructuredOutput, Tool } from '@/lib/api/types';
import { useSession } from '@/lib/session';

/** Org resources the editors pick from (up to 100 each, the pickers' practical limit). */
export function useToolOptions() {
  return useQuery({ queryKey: ['tools', 'options'], queryFn: ({ signal }) => get<Page<Tool>>('/v1/tools', { limit: 100 }, signal) });
}

export function useStructuredOutputOptions() {
  return useQuery({ queryKey: ['structured-outputs', 'options'], queryFn: ({ signal }) => get<Page<StructuredOutput>>('/v1/structured-outputs', { limit: 100 }, signal) });
}

/** The org's provider keys, when the member may see them (viewers may not). */
export function useCredentialOptions() {
  const { can } = useSession();
  return useQuery({ queryKey: ['credentials', 'options'], enabled: can('credentials:read'), queryFn: ({ signal }) => get<Page<Credential>>('/v1/credentials', { limit: 100 }, signal) });
}
