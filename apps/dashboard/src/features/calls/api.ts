'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '@/lib/api/client';
import { usePagedList } from '@/lib/api/hooks';
import type { CallDebug, CallDetail, CallListItem } from '@/lib/api/types';

export function useCallList(query: Record<string, string>) {
  return usePagedList<CallListItem>(['calls', 'list'], '/v1/calls', query);
}

/** One call. While it is still live or its analysis is running, it is refreshed every few seconds. */
export function useCall(id: string) {
  return useQuery({
    queryKey: ['calls', 'one', id],
    queryFn: ({ signal }) => get<CallDetail>(`/v1/calls/${id}`, undefined, signal),
    refetchInterval: (query) => {
      const call = query.state.data;
      if (!call) return false;
      const live = ['queued', 'ringing', 'in-progress'].includes(call.status);
      const analysing = call.analysis && ['pending', 'running'].includes(call.analysis.status);
      return live || analysing ? 3000 : false;
    },
  });
}

export function useCallDebug(id: string, enabled: boolean, bodies: boolean) {
  return useQuery({ queryKey: ['calls', 'debug', id, bodies], enabled, queryFn: ({ signal }) => get<CallDebug>(`/v1/calls/${id}/debug`, bodies ? { bodies: 'true' } : undefined, signal) });
}

export function useRerunAnalysis(id: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => post(`/v1/calls/${id}/analysis`),
    onSuccess: () => void client.invalidateQueries({ queryKey: ['calls', 'one', id] }),
  });
}
