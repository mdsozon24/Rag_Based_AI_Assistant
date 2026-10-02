'use client';

import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
import { get, type Page } from './client';

type Query = Record<string, string | number | boolean | null | undefined>;

/**
 * A cursor-paginated list (`{data, nextCursor}`), loaded page by page with "Load more".
 * `items` flattens the pages.
 */
export function usePagedList<T>(key: QueryKey, path: string, query: Query = {}, options: { enabled?: boolean; limit?: number } = {}) {
  const result = useInfiniteQuery({
    queryKey: [...key, query],
    enabled: options.enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => get<Page<T>>(path, { ...query, limit: options.limit ?? 25, cursor: pageParam ?? undefined }, signal),
    getNextPageParam: (last) => last.nextCursor,
  });
  return { ...result, items: result.data?.pages.flatMap((p) => p.data) ?? [] };
}
