'use client';

import { Bot, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/load-more';
import { PageBody, PageHeader } from '@/components/ui/page';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { Table, TBody, Td, Th, THead, Tr } from '@/components/ui/table';
import { formatRelative } from '@/lib/format';
import { useSession } from '@/lib/session';
import { useDebounced } from '@/lib/use-debounced';
import { publicationState, useAssistantList } from './api';

export function AssistantList() {
  const { can } = useSession();
  const [search, setSearch] = useState('');
  const term = useDebounced(search);
  const list = useAssistantList(term);
  const canManage = can('assistants:manage');

  return (
    <PageBody>
      <PageHeader
        title="Assistants"
        description="Voice agents: what they say, how they sound, and what they can do. Publish a version to put it live."
        actions={
          canManage ? (
            <LinkButton href="/assistants/new" variant="primary">
              <Plus aria-hidden="true" />
              New assistant
            </LinkButton>
          ) : null
        }
      />
      <div className="mb-4 max-w-sm">
        <label htmlFor="assistant-search" className="sr-only">
          Search assistants by name
        </label>
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
          <Input id="assistant-search" type="search" placeholder="Search by name" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
      </div>
      {list.isPending ? (
        <LoadingState label="Loading assistants…" />
      ) : list.isError ? (
        <ErrorState error={list.error} title="Could not load assistants" onRetry={() => void list.refetch()} />
      ) : list.items.length === 0 ? (
        term ? (
          <EmptyState icon={<Search />} title="No assistants match" description={`Nothing is named like “${term}”.`} />
        ) : (
          <EmptyState
            icon={<Bot />}
            title="No assistants yet"
            description="Start from a template (support, booking, lead qualification) or a blank assistant."
            action={
              canManage ? (
                <LinkButton href="/assistants/new" variant="primary">
                  <Plus aria-hidden="true" />
                  New assistant
                </LinkButton>
              ) : null
            }
          />
        )
      ) : (
        <>
          <Table label="Assistants">
            <THead>
              <Tr>
                <Th>Name</Th>
                <Th>Status</Th>
                <Th className="hidden sm:table-cell">Language</Th>
                <Th className="hidden md:table-cell">Updated</Th>
              </Tr>
            </THead>
            <TBody>
              {list.items.map((assistant) => {
                const state = publicationState(assistant);
                return (
                  <Tr key={assistant.id}>
                    <Td>
                      <Link href={`/assistants/${assistant.id}`} className="font-medium text-accent-text underline-offset-4 hover:underline">
                        {assistant.name}
                      </Link>
                    </Td>
                    <Td>
                      <Badge tone={state.tone}>{state.label}</Badge>
                    </Td>
                    <Td className="hidden text-muted sm:table-cell">{assistant.config.language ?? 'en'}</Td>
                    <Td className="hidden text-muted md:table-cell">{formatRelative(assistant.updatedAt)}</Td>
                  </Tr>
                );
              })}
            </TBody>
          </Table>
          <LoadMore count={list.items.length} noun="assistant" hasNextPage={list.hasNextPage} isFetchingNextPage={list.isFetchingNextPage} fetchNextPage={list.fetchNextPage} />
        </>
      )}
    </PageBody>
  );
}
