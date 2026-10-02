/**
 * Call list filters: the URL holds them (so a filtered view can be shared or bookmarked), the form
 * edits them, and toApiQuery turns them into GET /v1/calls parameters (docs/API.md "Filtering calls").
 */
import { EndReason } from '@engine/engine/endReason.ts';

export type OutputOp = 'eq' | 'gte' | 'gt' | 'lte' | 'lt';

export interface OutputFilter {
  field: string;
  op: OutputOp;
  value: string;
}

export interface CallFilters {
  q?: string;
  /** Local dates (YYYY-MM-DD), both inclusive. */
  from?: string;
  to?: string;
  assistantId?: string;
  status?: string;
  endReason?: string;
  success?: 'true' | 'false';
  analysisStatus?: string;
  outputId?: string;
  outputs: OutputFilter[];
}

export const END_REASON_OPTIONS: { value: string; label: string }[] = [
  ...Object.values(EndReason).map((value) => ({ value, label: value })),
  { value: 'worker-lost', label: 'worker-lost' },
];

/** Every error end reason at once (the API takes a comma-separated list). */
export const ANY_ERROR = [EndReason.ErrorStt, EndReason.ErrorLlm, EndReason.ErrorTts, EndReason.ErrorInternal, 'worker-lost'].join(',');

export const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const NUMBER = /^-?\d+(\.\d+)?$/;
const SIMPLE = ['q', 'from', 'to', 'assistantId', 'status', 'endReason', 'success', 'analysisStatus', 'outputId'] as const;

export function filtersFromParams(params: URLSearchParams): CallFilters {
  const filters: CallFilters = { outputs: [] };
  for (const key of SIMPLE) {
    const value = params.get(key);
    if (value) (filters as unknown as Record<string, string>)[key] = value;
  }
  for (const [key, value] of params) {
    const match = /^output\.([A-Za-z_][A-Za-z0-9_]{0,63})(?:\.(gte|gt|lte|lt))?$/.exec(key);
    if (match) filters.outputs.push({ field: match[1], op: (match[2] as OutputOp | undefined) ?? 'eq', value });
  }
  return filters;
}

export function filtersToParams(filters: CallFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of SIMPLE) {
    const value = filters[key];
    if (value) params.set(key, value);
  }
  for (const output of filters.outputs) {
    if (!output.field || output.value === '') continue;
    params.set(`output.${output.field}${output.op === 'eq' ? '' : `.${output.op}`}`, output.value);
  }
  return params;
}

/** Start of a local date as an ISO instant. */
function localMidnight(date: string, addDays = 0): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d + addDays).toISOString();
}

/** The API query for these filters. `to` is inclusive in the form and exclusive in the API. */
export function toApiQuery(filters: CallFilters): Record<string, string> {
  const query: Record<string, string> = {};
  for (const key of SIMPLE) {
    const value = filters[key];
    if (!value) continue;
    if (key === 'from') query.from = localMidnight(value);
    else if (key === 'to') query.to = localMidnight(value, 1);
    else query[key] = value;
  }
  for (const output of filters.outputs) {
    if (!output.field || output.value === '') continue;
    query[`output.${output.field}${output.op === 'eq' ? '' : `.${output.op}`}`] = output.value;
  }
  return query;
}

/** Problems the API would refuse, per output row (index → message). */
export function outputFilterErrors(outputs: OutputFilter[]): Record<number, string> {
  const errors: Record<number, string> = {};
  const seen = new Set<string>();
  outputs.forEach((output, index) => {
    if (!output.field && output.value === '') return;
    const key = `${output.field}.${output.op}`;
    if (!FIELD_NAME.test(output.field)) errors[index] = 'A field name: letters, digits and underscores';
    else if (output.value === '') errors[index] = 'Give a value';
    else if (output.op !== 'eq' && !NUMBER.test(output.value)) errors[index] = 'Ranges need a number';
    else if (seen.has(key)) errors[index] = 'The same filter twice';
    seen.add(key);
  });
  return errors;
}

export function activeFilterCount(filters: CallFilters): number {
  return SIMPLE.filter((key) => filters[key]).length + filters.outputs.filter((o) => o.field && o.value !== '').length;
}
