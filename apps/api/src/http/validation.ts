/**
 * Request validation (zod) and cursor pagination helpers.
 */
import { z } from 'zod';
import { ApiError } from './errors.ts';
import { isUuid } from '../db/tenant.ts';

/** Parse `value` with `schema`, or throw a 400 validation_error listing each problem. */
export function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new ApiError('validation_error', 'The request is invalid', {
      issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

/** Path parameter that must be a UUID; anything else is simply "not found". */
export function idParam(params: unknown, name = 'id', what = 'Resource'): string {
  const value = (params as Record<string, unknown>)?.[name];
  if (!isUuid(value)) throw new ApiError('not_found', `${what} not found`);
  return value;
}

// ---------------------------------------------------------------- pagination

export interface PageRequest {
  limit: number;
  /** Rows strictly older than this (created_at, id) position. */
  after?: { createdAt: string; id: string };
}

export interface Page<T> {
  data: T[];
  /** Pass as ?cursor= to get the next page; null when there are no more rows. */
  nextCursor: string | null;
}

/** Postgres timestamptz text with full (microsecond) precision, e.g. "2026-10-01 09:00:00.123456+00". */
const CURSOR_TS = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)$/;

const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});

export function pageRequest(query: unknown): PageRequest {
  const { limit, cursor } = parse(pageQuery, query);
  if (!cursor) return { limit };
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { c?: unknown; i?: unknown };
    if (typeof decoded.c !== 'string' || !CURSOR_TS.test(decoded.c) || !isUuid(decoded.i)) throw new Error('bad cursor');
    return { limit, after: { createdAt: decoded.c, id: decoded.i } };
  } catch {
    throw new ApiError('validation_error', 'The request is invalid', { issues: [{ path: 'cursor', message: 'Invalid cursor' }] });
  }
}

/**
 * Build a page from rows fetched with LIMIT limit + 1, ordered by (created_at DESC, id DESC).
 * Rows must include `cursor_ts` (created_at::text, full precision: a JS Date would drop the
 * microseconds and make the next page skip rows created in the same millisecond).
 */
export function toPage<R extends { cursor_ts: string; id: string }, T>(rows: R[], limit: number, map: (row: R) => T): Page<T> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows[pageRows.length - 1];
  let nextCursor: string | null = null;
  if (hasMore && last) nextCursor = Buffer.from(JSON.stringify({ c: last.cursor_ts, i: last.id })).toString('base64url');
  return { data: pageRows.map(map), nextCursor };
}

/** SQL fragment and params for "older than the cursor" (keyset pagination). */
export function cursorClause(page: PageRequest, firstParam: number, alias = ''): { sql: string; params: unknown[] } {
  if (!page.after) return { sql: '', params: [] };
  const p = alias ? `${alias}.` : '';
  return { sql: ` AND (${p}created_at, ${p}id) < ($${firstParam}::timestamptz, $${firstParam + 1}::uuid)`, params: [page.after.createdAt, page.after.id] };
}

export function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
