'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post, type Page } from '@/lib/api/client';
import { usePagedList } from '@/lib/api/hooks';
import type { Assistant, AssistantTemplate, AssistantVersion, CreatedCall, ProviderCatalog } from '@/lib/api/types';
import type { AssistantSpec } from '@/lib/schemas/assistant';

export const assistantKeys = {
  all: ['assistants'] as const,
  list: () => ['assistants', 'list'] as const,
  one: (id: string) => ['assistants', 'one', id] as const,
  versions: (id: string) => ['assistants', 'versions', id] as const,
  version: (id: string, version: number) => ['assistants', 'version', id, version] as const,
};

export function useAssistantList(search: string) {
  return usePagedList<Assistant>(assistantKeys.list(), '/v1/assistants', { search: search.trim() || undefined });
}

/** Every assistant (for pickers): up to 100, which covers the pickers' needs; the list page pages properly. */
export function useAllAssistants() {
  return useQuery({ queryKey: ['assistants', 'all'], queryFn: ({ signal }) => get<Page<Assistant>>('/v1/assistants', { limit: 100 }, signal) });
}

export function useAssistant(id: string) {
  return useQuery({ queryKey: assistantKeys.one(id), queryFn: ({ signal }) => get<Assistant>(`/v1/assistants/${id}`, undefined, signal) });
}

export function useTemplates() {
  return useQuery({ queryKey: ['assistant-templates'], queryFn: ({ signal }) => get<Page<AssistantTemplate>>('/v1/assistant-templates', undefined, signal), staleTime: Number.POSITIVE_INFINITY });
}

export function useProviderCatalog() {
  return useQuery({ queryKey: ['provider-catalog'], queryFn: ({ signal }) => get<ProviderCatalog>('/v1/providers', undefined, signal), staleTime: Number.POSITIVE_INFINITY });
}

export function useVersions(id: string) {
  return useQuery({ queryKey: assistantKeys.versions(id), queryFn: ({ signal }) => get<Page<AssistantVersion>>(`/v1/assistants/${id}/versions`, { limit: 100 }, signal) });
}

export function useVersion(id: string, version: number | null) {
  return useQuery({
    queryKey: assistantKeys.version(id, version ?? 0),
    enabled: version !== null,
    queryFn: ({ signal }) => get<AssistantVersion>(`/v1/assistants/${id}/versions/${version}`, undefined, signal),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useAssistantMutations(id: string) {
  const client = useQueryClient();
  const settle = (assistant?: Assistant) => {
    if (assistant) client.setQueryData(assistantKeys.one(id), assistant);
    void client.invalidateQueries({ queryKey: assistantKeys.list() });
    void client.invalidateQueries({ queryKey: ['assistants', 'all'] });
  };
  return {
    save: useMutation({
      mutationFn: (body: { name?: string; config?: Record<string, unknown> }) => patch<Assistant>(`/v1/assistants/${id}`, body),
      onSuccess: settle,
    }),
    publish: useMutation({
      mutationFn: (note: string) => post<AssistantVersion>(`/v1/assistants/${id}/publish`, note ? { note } : {}),
      onSuccess: () => {
        void client.invalidateQueries({ queryKey: assistantKeys.one(id) });
        void client.invalidateQueries({ queryKey: assistantKeys.versions(id) });
        settle();
      },
    }),
    rollback: useMutation({
      mutationFn: (input: { version: number; restoreDraft: boolean }) => post<Assistant>(`/v1/assistants/${id}/rollback`, input),
      onSuccess: (assistant) => {
        settle(assistant);
        void client.invalidateQueries({ queryKey: assistantKeys.versions(id) });
      },
    }),
    remove: useMutation({
      mutationFn: () => del(`/v1/assistants/${id}`),
      onSuccess: () => {
        client.removeQueries({ queryKey: assistantKeys.one(id) });
        settle();
      },
    }),
    testCall: useMutation({
      mutationFn: (input: { variables: Record<string, string> }) => post<CreatedCall>(`/v1/assistants/${id}/test-call`, { variables: input.variables, test: true }),
    }),
  };
}

export function useCreateAssistant() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; templateId?: string; config?: AssistantSpec }) => post<Assistant>('/v1/assistants', body),
    onSuccess: (assistant) => {
      client.setQueryData(assistantKeys.one(assistant.id), assistant);
      void client.invalidateQueries({ queryKey: assistantKeys.list() });
      void client.invalidateQueries({ queryKey: ['assistants', 'all'] });
    },
  });
}

/** "Published v3", "Draft changes", "Not published" for a badge. */
export function publicationState(assistant: Pick<Assistant, 'publishedVersion' | 'hasUnpublishedChanges'>): { label: string; tone: 'success' | 'warning' | 'neutral' } {
  if (!assistant.publishedVersion) return { label: 'Not published', tone: 'neutral' };
  if (assistant.hasUnpublishedChanges) return { label: `v${assistant.publishedVersion.version} live · unpublished changes`, tone: 'warning' };
  return { label: `v${assistant.publishedVersion.version} live`, tone: 'success' };
}
