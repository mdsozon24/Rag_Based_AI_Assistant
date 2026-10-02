/**
 * Scorecards: org-defined metrics computed from structured outputs and analysis results, tracked
 * over time. A scorecard is only a definition; its value and its series are computed on demand from
 * the calls themselves (the same code the boards and alert policies use), so history always agrees
 * with the data and nothing needs backfilling when a definition is created.
 *
 * Examples:
 *   booking rate:      {source: {type: "output", field: "appointment_booked"}, aggregate: "rate", equals: true}
 *   average score:     {source: {type: "success", property: "score"}, aggregate: "avg"}
 *   positive calls:    {source: {type: "output", field: "sentiment"}, aggregate: "rate", equals: "positive"}
 */
import { z } from 'zod';
import { newId } from '../auth/crypto.ts';
import type { Queryable } from '../db/database.ts';
import { ApiError } from '../http/errors.ts';
import { iso } from '../http/validation.ts';
import type { ScorecardSpec } from '../observability/stats.ts';
import type { Actor } from './audit.ts';

const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const uuid = z.string().uuid();

export const scorecardSpecSchema = z
  .object({
    source: z.discriminatedUnion('type', [
      z.object({ type: z.literal('output'), field: z.string().regex(FIELD, 'A field name: letters, digits and underscores'), outputId: z.union([uuid, z.literal('inline')]).optional() }).strict(),
      z.object({ type: z.literal('success'), property: z.enum(['passed', 'score', 'category']) }).strict(),
    ]),
    aggregate: z.enum(['rate', 'avg', 'min', 'max', 'sum', 'count']),
    equals: z.union([z.string().max(200), z.number().finite(), z.boolean()]).optional(),
    filters: z.object({ assistantId: uuid.optional(), phoneNumberId: uuid.optional() }).strict().optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const add = (path: string, message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    const passed = spec.source.type === 'success' && spec.source.property === 'passed';
    if (spec.aggregate === 'rate' && spec.equals === undefined && !passed) add('equals', 'A rate needs the value that counts as a hit, for example true or "positive"');
    if (spec.aggregate !== 'rate' && spec.equals !== undefined) add('equals', 'Only used with aggregate "rate"');
    if (spec.source.type === 'success') {
      const allowed = { passed: ['rate', 'count'], score: ['avg', 'min', 'max', 'sum', 'count'], category: ['rate', 'count'] }[spec.source.property];
      if (!allowed.includes(spec.aggregate)) add('aggregate', `For success.${spec.source.property} use one of: ${allowed.join(', ')}`);
    }
  });

export const scorecardSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1000).default(''),
    spec: scorecardSpecSchema,
  })
  .strict();

export const scorecardPatchSchema = scorecardSchema.partial().strict();

export interface ScorecardRow {
  id: string;
  cursor_ts: string;
  name: string;
  description: string;
  spec: ScorecardSpec;
  created_at: Date;
  updated_at: Date;
}

export const SCORECARD_COLUMNS = 'id, created_at::text AS cursor_ts, name, description, spec, created_at, updated_at';

export const scorecardView = (row: ScorecardRow) => ({ id: row.id, name: row.name, description: row.description, spec: row.spec, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });

async function assertReferences(tx: Queryable, orgId: string, spec: ScorecardSpec): Promise<void> {
  const issues: { path: string; message: string }[] = [];
  if (spec.filters?.assistantId && !(await tx.query('SELECT 1 FROM assistant WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL', [orgId, spec.filters.assistantId])).rowCount) issues.push({ path: 'spec.filters.assistantId', message: 'Assistant not found' });
  if (spec.filters?.phoneNumberId && !(await tx.query('SELECT 1 FROM phone_number WHERE org_id = $1 AND id = $2', [orgId, spec.filters.phoneNumberId])).rowCount) issues.push({ path: 'spec.filters.phoneNumberId', message: 'Phone number not found' });
  const outputId = spec.source.type === 'output' ? spec.source.outputId : undefined;
  if (outputId && outputId !== 'inline' && !(await tx.query('SELECT 1 FROM structured_output WHERE org_id = $1 AND id = $2', [orgId, outputId])).rowCount) issues.push({ path: 'spec.source.outputId', message: 'Structured output not found' });
  if (issues.length) throw new ApiError('validation_error', 'The request is invalid', { issues });
}

async function assertNameFree(tx: Queryable, orgId: string, name: string, exceptId: string | null): Promise<void> {
  const taken = await tx.query('SELECT 1 FROM scorecard WHERE org_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL AND ($3::uuid IS NULL OR id <> $3)', [orgId, name, exceptId]);
  if (taken.rowCount) throw new ApiError('conflict', `A scorecard named "${name}" already exists`, { reason: 'name_taken' });
}

export async function getScorecard(tx: Queryable, orgId: string, id: string, options: { lock?: boolean } = {}): Promise<ScorecardRow> {
  const row = (await tx.query<ScorecardRow>(`SELECT ${SCORECARD_COLUMNS} FROM scorecard WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL${options.lock ? ' FOR UPDATE' : ''}`, [orgId, id])).rows[0];
  if (!row) throw new ApiError('not_found', 'Scorecard not found');
  return row;
}

export async function createScorecard(tx: Queryable, orgId: string, actor: Actor, input: z.infer<typeof scorecardSchema>): Promise<ScorecardRow> {
  await assertNameFree(tx, orgId, input.name, null);
  await assertReferences(tx, orgId, input.spec as ScorecardSpec);
  const id = newId();
  await tx.query('INSERT INTO scorecard (id, org_id, name, description, spec, created_by_user_id) VALUES ($1, $2, $3, $4, $5::jsonb, $6)', [id, orgId, input.name, input.description, JSON.stringify(input.spec), actor.type === 'user' ? actor.id : null]);
  return getScorecard(tx, orgId, id);
}

export async function updateScorecard(tx: Queryable, orgId: string, id: string, patch: z.infer<typeof scorecardPatchSchema>): Promise<ScorecardRow> {
  const current = await getScorecard(tx, orgId, id, { lock: true });
  if (patch.name !== undefined) await assertNameFree(tx, orgId, patch.name, id);
  if (patch.spec !== undefined) await assertReferences(tx, orgId, patch.spec as ScorecardSpec);
  await tx.query('UPDATE scorecard SET name = $3, description = $4, spec = $5::jsonb, updated_at = now() WHERE org_id = $1 AND id = $2', [orgId, id, patch.name ?? current.name, patch.description ?? current.description, JSON.stringify(patch.spec ?? current.spec)]);
  return getScorecard(tx, orgId, id);
}

/** Soft delete. A policy that watches the scorecard must be changed first (otherwise it would watch nothing). */
export async function deleteScorecard(tx: Queryable, orgId: string, id: string): Promise<void> {
  await getScorecard(tx, orgId, id, { lock: true });
  const used = await tx.query<{ name: string }>('SELECT name FROM alert_policy WHERE org_id = $1 AND scorecard_id = $2 LIMIT 3', [orgId, id]);
  if (used.rowCount) throw new ApiError('conflict', 'Alert policies still watch this scorecard; change or delete them first', { reason: 'in_use', policies: used.rows.map((r) => r.name) });
  await tx.query('UPDATE scorecard SET deleted_at = now(), updated_at = now() WHERE org_id = $1 AND id = $2', [orgId, id]);
}
