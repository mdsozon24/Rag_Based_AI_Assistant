/**
 * Structured outputs: reusable JSON Schema definitions an org attaches to many assistants
 * (`analysis.structuredOutputIds`). After each call a model fills the schema from the transcript
 * and the values are validated against it (see services/analysis).
 *
 * Deleting is a soft delete: calls already analysed keep a snapshot of the schema they were checked
 * against, and an assistant that still lists a deleted output simply skips it.
 */
import { z } from 'zod';
import type { Queryable } from '../db/database.ts';
import { ApiError } from '../http/errors.ts';
import { iso } from '../http/validation.ts';
import { newId } from '../auth/crypto.ts';
import type { Actor } from './audit.ts';
import { checkSchema } from './analysis/jsonSchema.ts';

export interface StructuredOutputRow {
  id: string;
  cursor_ts: string;
  name: string;
  description: string;
  schema: Record<string, unknown>;
  prompt: string | null;
  created_at: Date;
  updated_at: Date;
}

export const OUTPUT_COLUMNS = 'id, created_at::text AS cursor_ts, name, description, schema, prompt, created_at, updated_at';

export const structuredOutputView = (row: StructuredOutputRow, usedBy?: number) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  schema: row.schema,
  prompt: row.prompt,
  ...(usedBy !== undefined ? { assistantCount: usedBy } : {}),
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

export const structuredOutputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1000).default(''),
    /** A JSON Schema with "type": "object". Example: {"type":"object","properties":{"appointment_booked":{"type":"boolean"}},"required":["appointment_booked"]} */
    schema: z.record(z.unknown()),
    /** Extra instructions for the model when it fills this schema. */
    prompt: z.string().trim().max(5000).nullable().optional(),
  })
  .strict();

export const structuredOutputPatchSchema = structuredOutputSchema.partial().strict();

/** Throws a 400 listing why a schema cannot be used. */
export function assertUsableSchema(schema: unknown): asserts schema is Record<string, unknown> {
  const issues = checkSchema(schema);
  if (issues.length) throw new ApiError('validation_error', 'The schema cannot be used', { issues });
}

export async function createStructuredOutput(tx: Queryable, orgId: string, actor: Actor, input: z.infer<typeof structuredOutputSchema>): Promise<StructuredOutputRow> {
  assertUsableSchema(input.schema);
  await assertNameFree(tx, orgId, input.name, null);
  const id = newId();
  await tx.query('INSERT INTO structured_output (id, org_id, name, description, schema, prompt, created_by_user_id) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)', [
    id, orgId, input.name, input.description, JSON.stringify(input.schema), input.prompt ?? null, actor.type === 'user' ? actor.id : null,
  ]);
  return getStructuredOutput(tx, orgId, id);
}

async function assertNameFree(tx: Queryable, orgId: string, name: string, exceptId: string | null): Promise<void> {
  const taken = await tx.query('SELECT 1 FROM structured_output WHERE org_id = $1 AND lower(name) = lower($2) AND deleted_at IS NULL AND ($3::uuid IS NULL OR id <> $3)', [orgId, name, exceptId]);
  if (taken.rowCount) throw new ApiError('conflict', `A structured output named "${name}" already exists`, { reason: 'name_taken' });
}

export async function getStructuredOutput(tx: Queryable, orgId: string, id: string, options: { lock?: boolean } = {}): Promise<StructuredOutputRow> {
  const row = (await tx.query<StructuredOutputRow>(`SELECT ${OUTPUT_COLUMNS} FROM structured_output WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL${options.lock ? ' FOR UPDATE' : ''}`, [orgId, id])).rows[0];
  if (!row) throw new ApiError('not_found', 'Structured output not found');
  return row;
}

export async function updateStructuredOutput(tx: Queryable, orgId: string, id: string, patch: z.infer<typeof structuredOutputPatchSchema>): Promise<StructuredOutputRow> {
  const current = await getStructuredOutput(tx, orgId, id, { lock: true });
  if (patch.schema !== undefined) assertUsableSchema(patch.schema);
  if (patch.name !== undefined) await assertNameFree(tx, orgId, patch.name, id);
  await tx.query('UPDATE structured_output SET name = $3, description = $4, schema = $5::jsonb, prompt = $6, updated_at = now() WHERE org_id = $1 AND id = $2', [
    orgId, id, patch.name ?? current.name, patch.description ?? current.description, JSON.stringify(patch.schema ?? current.schema), patch.prompt === undefined ? current.prompt : patch.prompt,
  ]);
  return getStructuredOutput(tx, orgId, id);
}

/** How many live assistants list this output (drafts and published versions are not counted twice). */
export async function assistantsUsing(tx: Queryable, orgId: string, ids: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!ids.length) return counts;
  const rows = (
    await tx.query<{ id: string; n: number }>(
      `SELECT o.id::text AS id, count(a.id)::int AS n
       FROM unnest($2::uuid[]) AS o(id)
       LEFT JOIN assistant a ON a.org_id = $1 AND a.deleted_at IS NULL AND a.draft -> 'analysis' -> 'structuredOutputIds' ? o.id::text
       GROUP BY o.id`,
      [orgId, ids]
    )
  ).rows;
  for (const row of rows) counts.set(row.id, row.n);
  return counts;
}

/** The assistant may only list outputs that exist in its org (and are not deleted). */
export async function requireStructuredOutputs(tx: Queryable, orgId: string, ids: string[], path = 'config.analysis.structuredOutputIds'): Promise<void> {
  if (!ids.length) return;
  const rows = await tx.query<{ id: string }>('SELECT id FROM structured_output WHERE org_id = $1 AND deleted_at IS NULL AND id = ANY ($2::uuid[])', [orgId, ids]);
  const found = new Set(rows.rows.map((row) => row.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) throw new ApiError('validation_error', 'The assistant references unavailable structured outputs', { issues: missing.map((id) => ({ path, message: `Structured output ${id} was not found in this organization` })) });
}
