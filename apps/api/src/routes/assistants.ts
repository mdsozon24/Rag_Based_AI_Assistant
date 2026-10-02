/**
 * Assistants: CRUD on the draft, publish (immutable versions), version history, rollback, templates.
 *
 * - Edits (POST, PATCH) change the draft only. Calls never run the draft, except dashboard test calls.
 * - Publish snapshots the draft into assistant_version N+1 and makes it the published version.
 * - Rollback points the published version back at an older one (optionally restoring the draft).
 * - PATCH uses JSON Merge Patch on `config` and `metadata` (see packages/engine/src/assistant/merge.ts).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { applyMergePatch, patchedFields } from '../../../../packages/engine/src/assistant/merge.ts';
import { ASSISTANT_SPEC_SCHEMA_VERSION, type AssistantSpec } from '../../../../packages/engine/src/assistant/spec.ts';
import { ASSISTANT_TEMPLATES, findTemplate } from '../../../../packages/engine/src/assistant/templates.ts';
import type { AppContext } from '../context.ts';
import { clientIp } from '../auth/authenticate.ts';
import { newId } from '../auth/crypto.ts';
import { ApiError } from '../http/errors.ts';
import { cursorClause, idParam, pageRequest, parse, toPage } from '../http/validation.ts';
import {
  ASSISTANT_SELECT,
  assistantName,
  assistantView,
  getAssistant,
  getVersion,
  metadataSchema,
  requireValidSpec,
  VERSION_COLUMNS,
  versionView,
  type AssistantRow,
  type VersionRow,
} from '../services/assistants.ts';
import { audit } from '../services/audit.ts';
import { requireTools } from '../services/tools.ts';
import { requireStructuredOutputs } from '../services/structuredOutputs.ts';
import { scope } from './org.ts';

const configObject = z.record(z.unknown());

const createSchema = z
  .object({
    name: assistantName.optional(),
    templateId: z.string().max(100).optional(),
    metadata: metadataSchema.optional(),
    config: configObject.optional(),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.templateId !== undefined, { path: ['name'], message: 'Required (unless templateId is given)' });

const patchSchema = z
  .object({
    name: assistantName.optional(),
    /** Merge patch: keys merge, null removes a key. */
    metadata: configObject.optional(),
    /** Merge patch on the draft config; null resets a field to its default. */
    config: configObject.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'Send at least one of name, metadata, config');

const listQuery = z.object({ search: z.string().trim().max(100).optional() }).passthrough();

const versionParam = (params: unknown): number => {
  const raw = (params as Record<string, unknown>)?.version;
  const version = typeof raw === 'string' && /^[1-9]\d{0,8}$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(version)) throw new ApiError('not_found', 'Version not found');
  return version;
};

/** Escape LIKE wildcards so a search for "50%" means the text "50%". */
const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function registerAssistantRoutes(app: FastifyInstance, ctx: AppContext): void {
  const specContext = { registry: ctx.voice.registry, endpointPolicy: ctx.voice.endpointPolicy };

  app.get('/v1/assistant-templates', { config: { permission: 'assistants:read' } }, async () => ({
    data: ASSISTANT_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, config: t.spec })),
    nextCursor: null,
  }));

  app.post('/v1/assistants', { config: { permission: 'assistants:manage' } }, async (request, reply) => {
    const org = scope(request);
    const body = parse(createSchema, request.body);
    let base: AssistantSpec = {};
    let name = body.name;
    if (body.templateId !== undefined) {
      const template = findTemplate(body.templateId);
      if (!template) {
        throw new ApiError('validation_error', 'The request is invalid', {
          issues: [{ path: 'templateId', message: `Unknown template; available: ${ASSISTANT_TEMPLATES.map((t) => t.id).join(', ')}` }],
        });
      }
      base = template.spec;
      name ??= template.name;
    }
    const draft = requireValidSpec(body.config ? applyMergePatch(base, body.config) : base, specContext, 'config');
    const row = await org.run(async (tx) => {
      const id = newId();
      await requireTools(tx, org.id, draft.toolIds ?? []);
      await requireStructuredOutputs(tx, org.id, draft.analysis?.structuredOutputIds ?? []);
      await tx.query(
        `INSERT INTO assistant (id, org_id, name, metadata, draft, draft_schema, template_id, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, org.id, name, JSON.stringify(body.metadata ?? {}), JSON.stringify(draft), ASSISTANT_SPEC_SCHEMA_VERSION, body.templateId ?? null, org.actor.type === 'user' ? org.actor.id : null]
      );
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'assistant.created', targetType: 'assistant', targetId: id, metadata: { name, templateId: body.templateId ?? null }, ip: clientIp(request) });
      return getAssistant(tx, org.id, id);
    });
    return reply.code(201).send(assistantView(row));
  });

  app.get('/v1/assistants', { config: { permission: 'assistants:read' } }, async (request) => {
    const org = scope(request);
    const page = pageRequest(request.query);
    const { search } = parse(listQuery, request.query);
    const params: unknown[] = [org.id, page.limit + 1];
    let filter = '';
    if (search) {
      params.push(likePattern(search));
      filter = ` AND a.name ILIKE $${params.length} ESCAPE '\\'`;
    }
    const cursor = cursorClause(page, params.length + 1, 'a');
    const rows = await org.run(async (tx) =>
      (await tx.query<AssistantRow>(`${ASSISTANT_SELECT} WHERE a.org_id = $1 AND a.deleted_at IS NULL${filter}${cursor.sql} ORDER BY a.created_at DESC, a.id DESC LIMIT $2`, [...params, ...cursor.params])).rows
    );
    return toPage(rows, page.limit, assistantView);
  });

  app.get('/v1/assistants/:id', { config: { permission: 'assistants:read' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Assistant');
    return assistantView(await org.run((tx) => getAssistant(tx, org.id, id)));
  });

  app.patch('/v1/assistants/:id', { config: { permission: 'assistants:manage' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Assistant');
    const body = parse(patchSchema, request.body);
    const row = await org.run(async (tx) => {
      const current = await getAssistant(tx, org.id, id, { lock: true });
      const draft = body.config ? requireValidSpec(applyMergePatch(current.draft, body.config), specContext, 'config') : current.draft;
      await requireTools(tx, org.id, draft.toolIds ?? []);
      await requireStructuredOutputs(tx, org.id, draft.analysis?.structuredOutputIds ?? []);
      const metadata = body.metadata ? parse(z.object({ metadata: metadataSchema }), { metadata: applyMergePatch(current.metadata, body.metadata) }).metadata : current.metadata;
      await tx.query(
        `UPDATE assistant SET name = $3, metadata = $4, draft = $5, draft_schema = $6, updated_at = now() WHERE org_id = $1 AND id = $2`,
        [org.id, id, body.name ?? current.name, JSON.stringify(metadata), JSON.stringify(draft), ASSISTANT_SPEC_SCHEMA_VERSION]
      );
      await audit(tx, {
        orgId: org.id,
        actor: org.actor,
        action: 'assistant.updated',
        targetType: 'assistant',
        targetId: id,
        metadata: { fields: [...(body.name ? ['name'] : []), ...(body.metadata ? ['metadata'] : []), ...(body.config ? patchedFields(body.config).map((f) => `config.${f}`) : [])] },
        ip: clientIp(request),
      });
      return getAssistant(tx, org.id, id);
    });
    return assistantView(row);
  });

  app.delete('/v1/assistants/:id', { config: { permission: 'assistants:manage' } }, async (request, reply) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Assistant');
    await org.run(async (tx) => {
      const deleted = await tx.query('UPDATE assistant SET deleted_at = now(), updated_at = now() WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL', [org.id, id]);
      if (deleted.rowCount === 0) throw new ApiError('not_found', 'Assistant not found');
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'assistant.deleted', targetType: 'assistant', targetId: id, ip: clientIp(request) });
    });
    return reply.code(204).send();
  });

  app.post('/v1/assistants/:id/publish', { config: { permission: 'assistants:manage' } }, async (request, reply) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Assistant');
    const body = parse(z.object({ note: z.string().trim().max(500).optional() }).strict(), request.body);
    const version = await org.run(async (tx) => {
      const current = await getAssistant(tx, org.id, id, { lock: true });
      if (current.published_version_id && !current.has_unpublished_changes) {
        throw new ApiError('conflict', `Nothing to publish: the draft is identical to the published version ${current.published_version}`);
      }
      // Re-validate: providers or limits may have changed since the draft was saved
      const config = requireValidSpec(current.draft, specContext, 'config');
      await requireTools(tx, org.id, config.toolIds ?? []);
      await requireStructuredOutputs(tx, org.id, config.analysis?.structuredOutputIds ?? []);
      const number = (current.latest_version ?? 0) + 1;
      const versionId = newId();
      await tx.query(
        `INSERT INTO assistant_version (id, org_id, assistant_id, version, config_schema, config, note, created_by_type, created_by_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [versionId, org.id, id, number, ASSISTANT_SPEC_SCHEMA_VERSION, JSON.stringify(config), body.note ?? null, org.actor.type, org.actor.id]
      );
      await tx.query('UPDATE assistant SET published_version_id = $3, published_at = now(), updated_at = now() WHERE org_id = $1 AND id = $2', [org.id, id, versionId]);
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'assistant.published', targetType: 'assistant', targetId: id, metadata: { version: number, versionId }, ip: clientIp(request) });
      return getVersion(tx, org.id, id, number);
    });
    return reply.code(201).send(versionView(version, { withConfig: true }));
  });

  app.get('/v1/assistants/:id/versions', { config: { permission: 'assistants:read' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Assistant');
    const page = pageRequest(request.query);
    const rows = await org.run(async (tx) => {
      await getAssistant(tx, org.id, id);
      const cursor = cursorClause(page, 4, 'v');
      return (
        await tx.query<VersionRow>(
          `SELECT ${VERSION_COLUMNS} FROM assistant_version v JOIN assistant a ON a.id = v.assistant_id AND a.org_id = v.org_id
           WHERE v.org_id = $1 AND v.assistant_id = $3${cursor.sql} ORDER BY v.created_at DESC, v.id DESC LIMIT $2`,
          [org.id, page.limit + 1, id, ...cursor.params]
        )
      ).rows;
    });
    return toPage(rows, page.limit, (r) => versionView(r, { withConfig: false }));
  });

  app.get('/v1/assistants/:id/versions/:version', { config: { permission: 'assistants:read' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Assistant');
    const number = versionParam(request.params);
    const row = await org.run(async (tx) => {
      await getAssistant(tx, org.id, id);
      return getVersion(tx, org.id, id, number);
    });
    return versionView(row, { withConfig: true });
  });

  app.post('/v1/assistants/:id/rollback', { config: { permission: 'assistants:manage' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Assistant');
    const body = parse(z.object({ version: z.number().int().positive(), restoreDraft: z.boolean().default(false) }).strict(), request.body);
    const row = await org.run(async (tx) => {
      const current = await getAssistant(tx, org.id, id, { lock: true });
      const target = await getVersion(tx, org.id, id, body.version);
      if (target.is_published && !body.restoreDraft) throw new ApiError('conflict', `Version ${body.version} is already the published version`);
      await tx.query(
        `UPDATE assistant SET published_version_id = $3, published_at = CASE WHEN published_version_id = $3 THEN published_at ELSE now() END,
           draft = CASE WHEN $4 THEN $5::jsonb ELSE draft END, draft_schema = CASE WHEN $4 THEN $6 ELSE draft_schema END, updated_at = now()
         WHERE org_id = $1 AND id = $2`,
        [org.id, id, target.id, body.restoreDraft, JSON.stringify(target.config), target.config_schema]
      );
      await audit(tx, {
        orgId: org.id,
        actor: org.actor,
        action: 'assistant.rolled_back',
        targetType: 'assistant',
        targetId: id,
        metadata: { fromVersion: current.published_version, toVersion: body.version, restoreDraft: body.restoreDraft },
        ip: clientIp(request),
      });
      return getAssistant(tx, org.id, id);
    });
    return assistantView(row);
  });
}
