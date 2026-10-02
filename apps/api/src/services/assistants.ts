/**
 * Assistants: rows, views and the lookups shared by the assistant and call routes.
 * Every function takes the org transaction (request.org.run) and filters by org_id explicitly;
 * row-level security is the second layer.
 */
import { z } from 'zod';
import { validateAssistantSpec, type AssistantSpec, type SpecIssue } from '../../../../packages/engine/src/assistant/spec.ts';
import { requiredVariables } from '../../../../packages/engine/src/assistant/variables.ts';
import type { EndpointPolicy } from '../../../../packages/engine/src/providers/net.ts';
import type { ProviderRegistry } from '../../../../packages/engine/src/providers/registry.ts';
import type { Queryable } from '../db/database.ts';
import { ApiError } from '../http/errors.ts';
import { iso } from '../http/validation.ts';

export interface AssistantRow {
  id: string;
  cursor_ts: string;
  name: string;
  metadata: Record<string, unknown>;
  draft: AssistantSpec;
  draft_schema: number;
  template_id: string | null;
  created_at: Date;
  updated_at: Date;
  published_at: Date | null;
  published_version_id: string | null;
  published_version: number | null;
  latest_version: number | null;
  has_unpublished_changes: boolean;
}

/** Select list for AssistantRow; `a` is the assistant, `v` its published version (LEFT JOIN). */
export const ASSISTANT_SELECT = `
  SELECT a.id, a.created_at::text AS cursor_ts, a.name, a.metadata, a.draft, a.draft_schema, a.template_id,
         a.created_at, a.updated_at, a.published_at, a.published_version_id, v.version AS published_version,
         (SELECT max(x.version) FROM assistant_version x WHERE x.assistant_id = a.id AND x.org_id = a.org_id) AS latest_version,
         (v.id IS NULL OR v.config <> a.draft OR v.config_schema <> a.draft_schema) AS has_unpublished_changes
  FROM assistant a
  LEFT JOIN assistant_version v ON v.id = a.published_version_id AND v.org_id = a.org_id`;

export const assistantView = (r: AssistantRow) => ({
  id: r.id,
  name: r.name,
  metadata: r.metadata,
  /** The draft: what edits change and what the next publish snapshots. */
  config: r.draft,
  configSchema: r.draft_schema,
  publishedVersion: r.published_version_id ? { id: r.published_version_id, version: r.published_version, publishedAt: iso(r.published_at) } : null,
  latestVersion: r.latest_version,
  hasUnpublishedChanges: r.has_unpublished_changes,
  /** {{variables}} the draft uses that calls must supply (no default, not built in). */
  requiredVariables: requiredVariables({ firstMessage: r.draft.firstMessage, systemPrompt: r.draft.systemPrompt }, r.draft.variableDefaults).map((v) => v.name),
  templateId: r.template_id,
  createdAt: iso(r.created_at),
  updatedAt: iso(r.updated_at),
});

export interface VersionRow {
  id: string;
  cursor_ts: string;
  assistant_id: string;
  version: number;
  config_schema: number;
  config: AssistantSpec;
  note: string | null;
  created_by_type: string;
  created_by_id: string | null;
  created_at: Date;
  is_published: boolean;
}

export const VERSION_COLUMNS = `v.id, v.created_at::text AS cursor_ts, v.assistant_id, v.version, v.config_schema, v.config, v.note,
  v.created_by_type, v.created_by_id, v.created_at, coalesce(a.published_version_id = v.id, false) AS is_published`;

export function versionView(r: VersionRow, options: { withConfig: boolean }) {
  return {
    id: r.id,
    assistantId: r.assistant_id,
    version: r.version,
    configSchema: r.config_schema,
    note: r.note,
    published: r.is_published,
    createdBy: { type: r.created_by_type, id: r.created_by_id },
    createdAt: iso(r.created_at),
    ...(options.withConfig ? { config: r.config } : {}),
  };
}

/** A live (not deleted) assistant of the org, or 404. `lock` takes a row lock for publish/rollback. */
export async function getAssistant(tx: Queryable, orgId: string, id: string, options: { lock?: boolean } = {}): Promise<AssistantRow> {
  if (options.lock) {
    const locked = await tx.query('SELECT 1 FROM assistant WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE', [orgId, id]);
    if (locked.rowCount === 0) throw new ApiError('not_found', 'Assistant not found');
  }
  const row = (await tx.query<AssistantRow>(`${ASSISTANT_SELECT} WHERE a.org_id = $1 AND a.id = $2 AND a.deleted_at IS NULL`, [orgId, id])).rows[0];
  if (!row) throw new ApiError('not_found', 'Assistant not found');
  return row;
}

export async function getVersion(tx: Queryable, orgId: string, assistantId: string, version: number): Promise<VersionRow> {
  const row = (
    await tx.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM assistant_version v JOIN assistant a ON a.id = v.assistant_id AND a.org_id = v.org_id
       WHERE v.org_id = $1 AND v.assistant_id = $2 AND v.version = $3`,
      [orgId, assistantId, version]
    )
  ).rows[0];
  if (!row) throw new ApiError('not_found', `Version ${version} not found`);
  return row;
}

// ---------------------------------------------------------------- validation

export function specError(issues: SpecIssue[]): ApiError {
  return new ApiError('validation_error', 'The assistant config is invalid', { issues });
}

export interface SpecContext {
  registry: ProviderRegistry;
  endpointPolicy: EndpointPolicy;
}

/** Validate a spec or throw 400 with field-level issues under `prefix`. */
export function requireValidSpec(input: unknown, context: SpecContext, prefix: string): AssistantSpec {
  const result = validateAssistantSpec(input, { registry: context.registry, endpointPolicy: context.endpointPolicy, pathPrefix: prefix });
  if (!result.ok) throw specError(result.issues);
  return result.spec;
}

/** Customer metadata: free-form JSON object, at most 16 KB. */
export const metadataSchema = z
  .record(z.unknown())
  .refine((value) => JSON.stringify(value).length <= 16_000, 'Must be at most 16000 characters of JSON')
  .refine((value) => Object.keys(value).length <= 100, 'At most 100 keys');

export const assistantName = z.string().trim().min(1).max(100);
