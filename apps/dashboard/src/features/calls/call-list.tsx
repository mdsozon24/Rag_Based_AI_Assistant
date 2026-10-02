'use client';

import { AudioLines, Filter, Plus, SearchX, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input, Select } from '@/components/ui/input';
import { LoadMore } from '@/components/ui/load-more';
import { PageBody, PageHeader } from '@/components/ui/page';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { Table, TBody, Td, Th, THead, Tr } from '@/components/ui/table';
import { useAllAssistants } from '@/features/assistants/api';
import { useStructuredOutputOptions } from '@/features/shared/lookups';
import type { AnalysisView } from '@/lib/api/types';
import { formatDateTime, formatDuration, humanize } from '@/lib/format';
import { useCallList } from './api';
import { activeFilterCount, ANY_ERROR, END_REASON_OPTIONS, filtersFromParams, filtersToParams, outputFilterErrors, toApiQuery, type CallFilters, type OutputFilter } from './filters';

const OPS: { value: OutputFilter['op']; label: string }[] = [
  { value: 'eq', label: 'is' },
  { value: 'gte', label: '≥' },
  { value: 'gt', label: '>' },
  { value: 'lte', label: '≤' },
  { value: 'lt', label: '<' },
];

export function SuccessBadge({ analysis }: { analysis: AnalysisView | null }) {
  const s = analysis?.successEvaluation;
  if (!s) return <span className="text-muted">—</span>;
  if (s.passed === true) return <Badge tone="success">Passed</Badge>;
  if (s.passed === false) return <Badge tone="danger">Failed</Badge>;
  if (s.score !== null) return <Badge tone={s.score >= 7 ? 'success' : s.score >= 4 ? 'warning' : 'danger'}>{s.score}/10</Badge>;
  if (s.category) return <Badge tone="info">{s.category}</Badge>;
  return <Badge>Evaluated</Badge>;
}

export function StatusBadge({ status, endReason }: { status: string; endReason: string | null }) {
  if (status === 'in-progress' || status === 'ringing' || status === 'queued') return <Badge tone="info">{humanize(status)}</Badge>;
  if (status === 'failed' || endReason?.startsWith('error-') || endReason === 'worker-lost') return <Badge tone="danger">{humanize(endReason ?? status)}</Badge>;
  return <Badge>{humanize(endReason ?? status)}</Badge>;
}

export function CallList() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const applied = filtersFromParams(params);
  const list = useCallList(toApiQuery(applied));
  const count = activeFilterCount(applied);

  return (
    <PageBody wide>
      <PageHeader title="Calls" description="Every call with its outcome and analysis. Filter by date, assistant, end reason, success, or the values extracted from calls." />
      <FilterForm
        key={params.toString()}
        initial={applied}
        onApply={(filters) => router.replace(`${pathname}?${filtersToParams(filters).toString()}`)}
        onReset={() => router.replace(pathname)}
        activeCount={count}
      />
      {list.isPending ? (
        <LoadingState label="Loading calls…" rows={6} />
      ) : list.isError ? (
        <ErrorState error={list.error} title="Could not load calls" onRetry={() => void list.refetch()} />
      ) : list.items.length === 0 ? (
        count ? (
          <EmptyState icon={<SearchX />} title="No calls match these filters" action={<Button onClick={() => router.replace(pathname)}>Clear filters</Button>} />
        ) : (
          <EmptyState icon={<AudioLines />} title="No calls yet" description="Calls appear here as soon as they start: test calls from an assistant’s page, website calls, phone calls and campaigns." />
        )
      ) : (
        <>
          <Table label="Calls">
            <THead>
              <Tr>
                <Th>Started</Th>
                <Th>Assistant</Th>
                <Th>Outcome</Th>
                <Th className="hidden md:table-cell">Duration</Th>
                <Th>Success</Th>
                <Th className="hidden lg:table-cell">Summary</Th>
              </Tr>
            </THead>
            <TBody>
              {list.items.map((call) => (
                <Tr key={call.id}>
                  <Td className="whitespace-nowrap">
                    <Link href={`/calls/${call.id}`} className="font-medium text-accent-text underline-offset-4 hover:underline">
                      {formatDateTime(call.startedAt ?? call.createdAt)}
                    </Link>
                    <div className="text-xs text-muted capitalize">{call.direction}</div>
                  </Td>
                  <Td>{call.assistantName}</Td>
                  <Td>
                    <StatusBadge status={call.status} endReason={call.endReason} />
                  </Td>
                  <Td className="hidden text-muted tabular-nums md:table-cell">{formatDuration(call.durationMs)}</Td>
                  <Td>
                    <SuccessBadge analysis={call.analysis} />
                  </Td>
                  <Td className="hidden max-w-sm text-muted lg:table-cell">
                    <span className="line-clamp-2">{call.analysis?.summary ?? '—'}</span>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
          <LoadMore count={list.items.length} noun="call" hasNextPage={list.hasNextPage} isFetchingNextPage={list.isFetchingNextPage} fetchNextPage={list.fetchNextPage} />
        </>
      )}
    </PageBody>
  );
}

function FilterForm({ initial, onApply, onReset, activeCount }: { initial: CallFilters; onApply: (filters: CallFilters) => void; onReset: () => void; activeCount: number }) {
  const assistants = useAllAssistants();
  const outputs = useStructuredOutputOptions();
  const [filters, setFilters] = useState<CallFilters>(initial);
  const [open, setOpen] = useState(activeCount > 0);
  const [submitted, setSubmitted] = useState(false);
  const rowErrors = outputFilterErrors(filters.outputs);
  const set = (patch: Partial<CallFilters>) => setFilters((current) => ({ ...current, ...patch }));
  const setRow = (index: number, patch: Partial<OutputFilter>) => set({ outputs: filters.outputs.map((row, i) => (i === index ? { ...row, ...patch } : row)) });

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (Object.keys(rowErrors).length) return;
    if (filters.from && filters.to && filters.from > filters.to) return;
    onApply(filters);
  }
  const dateError = filters.from && filters.to && filters.from > filters.to ? 'The start date is after the end date' : null;

  return (
    <Card className="mb-5">
      <CardBody className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <form
            role="search"
            onSubmit={submit}
            className="flex min-w-0 flex-1 gap-2"
          >
            <label htmlFor="call-search" className="sr-only">
              Search transcripts
            </label>
            <Input id="call-search" type="search" placeholder="Search what was said (e.g. refund -cancel)" value={filters.q ?? ''} onChange={(e) => set({ q: e.target.value || undefined })} className="max-w-md" />
            <Button type="submit" variant="primary">
              Search
            </Button>
          </form>
          <Button aria-expanded={open} aria-controls="call-filters" onClick={() => setOpen(!open)}>
            <Filter aria-hidden="true" />
            Filters{activeCount ? ` (${activeCount})` : ''}
          </Button>
        </div>
        {open ? (
          <form id="call-filters" onSubmit={submit} noValidate className="flex flex-col gap-4 border-t border-border pt-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="From" error={submitted ? dateError : null}>
                {(props) => <Input {...props} type="date" value={filters.from ?? ''} onChange={(e) => set({ from: e.target.value || undefined })} />}
              </Field>
              <Field label="To">{(props) => <Input {...props} type="date" value={filters.to ?? ''} onChange={(e) => set({ to: e.target.value || undefined })} />}</Field>
              <Field label="Assistant">
                {(props) => (
                  <Select {...props} value={filters.assistantId ?? ''} onChange={(e) => set({ assistantId: e.target.value || undefined })}>
                    <option value="">Any</option>
                    {assistants.data?.data.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="End reason">
                {(props) => (
                  <Select {...props} value={filters.endReason ?? ''} onChange={(e) => set({ endReason: e.target.value || undefined })}>
                    <option value="">Any</option>
                    <option value={ANY_ERROR}>Any error</option>
                    {END_REASON_OPTIONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {humanize(r.label)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Status">
                {(props) => (
                  <Select {...props} value={filters.status ?? ''} onChange={(e) => set({ status: e.target.value || undefined })}>
                    <option value="">Any</option>
                    {['queued', 'ringing', 'in-progress', 'ended', 'failed'].map((s) => (
                      <option key={s} value={s}>
                        {humanize(s)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Success">
                {(props) => (
                  <Select {...props} value={filters.success ?? ''} onChange={(e) => set({ success: (e.target.value || undefined) as CallFilters['success'] })}>
                    <option value="">Any</option>
                    <option value="true">Passed</option>
                    <option value="false">Failed</option>
                  </Select>
                )}
              </Field>
              <Field label="Analysis">
                {(props) => (
                  <Select {...props} value={filters.analysisStatus ?? ''} onChange={(e) => set({ analysisStatus: e.target.value || undefined })}>
                    <option value="">Any</option>
                    {['pending', 'running', 'succeeded', 'failed', 'skipped'].map((s) => (
                      <option key={s} value={s}>
                        {humanize(s)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>

            <fieldset className="flex flex-col gap-3">
              <legend className="text-sm font-semibold text-text">Structured output values</legend>
              <p className="-mt-1 text-xs text-muted">Calls whose extracted values match, e.g. appointment_booked is true, or score ≥ 7.</p>
              {filters.outputs.map((row, index) => (
                <div key={index} className="flex flex-col gap-1">
                  <div className="flex flex-wrap items-end gap-2">
                    <Field label="Field" className="w-44">
                      {(props) => <Input {...props} value={row.field} placeholder="appointment_booked" aria-invalid={submitted && rowErrors[index] ? true : undefined} onChange={(e) => setRow(index, { field: e.target.value.trim() })} />}
                    </Field>
                    <Field label="Comparison" className="w-28">
                      {(props) => (
                        <Select {...props} value={row.op} onChange={(e) => setRow(index, { op: e.target.value as OutputFilter['op'] })}>
                          {OPS.map((op) => (
                            <option key={op.value} value={op.value}>
                              {op.label}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Field label="Value" className="w-40">
                      {(props) => <Input {...props} value={row.value} placeholder={row.op === 'eq' ? 'true' : '7'} onChange={(e) => setRow(index, { value: e.target.value })} />}
                    </Field>
                    <Button variant="ghost" className="w-10 px-0" aria-label={`Remove value filter ${index + 1}`} onClick={() => set({ outputs: filters.outputs.filter((_, i) => i !== index) })}>
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </div>
                  {submitted && rowErrors[index] ? (
                    <p role="alert" className="text-xs font-medium text-danger">
                      {rowErrors[index]}
                    </p>
                  ) : null}
                </div>
              ))}
              <div className="flex flex-wrap items-end gap-3">
                <Button size="sm" onClick={() => set({ outputs: [...filters.outputs, { field: '', op: 'eq', value: '' }] })}>
                  <Plus aria-hidden="true" />
                  Add value filter
                </Button>
                {filters.outputs.length ? (
                  <Field label="In output" className="w-56">
                    {(props) => (
                      <Select {...props} value={filters.outputId ?? ''} onChange={(e) => set({ outputId: e.target.value || undefined })}>
                        <option value="">Any output</option>
                        <option value="inline">Inline schema</option>
                        {outputs.data?.data.map((o) => (
                          <option key={o.id} value={o.id}>
                            {o.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                ) : null}
              </div>
            </fieldset>

            <div className="flex gap-2">
              <Button type="submit" variant="primary">
                Apply filters
              </Button>
              <Button
                onClick={() => {
                  setFilters({ outputs: [] });
                  setSubmitted(false);
                  onReset();
                }}
              >
                Reset
              </Button>
            </div>
          </form>
        ) : null}
      </CardBody>
    </Card>
  );
}
