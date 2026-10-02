/**
 * Structured outputs API: reusable JSON Schema definitions attached to assistants through
 * `config.analysis.structuredOutputIds`. Endpoint reference: docs/API.md ("Call analysis").
 */
import type { FastifyInstance } from 'fastify';
import { clientIp } from '../auth/authenticate.ts';
import type { AppContext } from '../context.ts';
import { ApiError } from '../http/errors.ts';
import { cursorClause, idParam, pageRequest, parse, toPage } from '../http/validation.ts';
import { audit } from '../services/audit.ts';
import { assistantsUsing, createStructuredOutput, getStructuredOutput, OUTPUT_COLUMNS, structuredOutputPatchSchema, structuredOutputSchema, structuredOutputView, updateStructuredOutput, type StructuredOutputRow } from '../services/structuredOutputs.ts';
import { scope } from './org.ts';

export function registerStructuredOutputRoutes(app: FastifyInstance, _ctx: AppContext): void {
  app.post('/v1/structured-outputs', { config: { permission: 'assistants:manage' } }, async (request, reply) => {
    const org = scope(request);
    const input = parse(structuredOutputSchema, request.body);
    const row = await org.run(async (tx) => {
      const created = await createStructuredOutput(tx, org.id, org.actor, input);
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'structured_output.created', targetType: 'structured_output', targetId: created.id, metadata: { name: created.name }, ip: clientIp(request) });
      return created;
    });
    return reply.code(201).send(structuredOutputView(row, 0));
  });

  app.get('/v1/structured-outputs', { config: { permission: 'assistants:read' } }, async (request) => {
    const org = scope(request);
    const page = pageRequest(request.query);
    const cursor = cursorClause(page, 3);
    return org.run(async (tx) => {
      const rows = (await tx.query<StructuredOutputRow>(`SELECT ${OUTPUT_COLUMNS} FROM structured_output WHERE org_id = $1 AND deleted_at IS NULL${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT $2`, [org.id, page.limit + 1, ...cursor.params])).rows;
      const counts = await assistantsUsing(tx, org.id, rows.map((r) => r.id));
      return toPage(rows, page.limit, (row) => structuredOutputView(row, counts.get(row.id) ?? 0));
    });
  });

  app.get('/v1/structured-outputs/:id', { config: { permission: 'assistants:read' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Structured output');
    return org.run(async (tx) => {
      const row = await getStructuredOutput(tx, org.id, id);
      return structuredOutputView(row, (await assistantsUsing(tx, org.id, [id])).get(id) ?? 0);
    });
  });

  app.patch('/v1/structured-outputs/:id', { config: { permission: 'assistants:manage' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Structured output');
    const patch = parse(structuredOutputPatchSchema, request.body);
    return org.run(async (tx) => {
      const row = await updateStructuredOutput(tx, org.id, id, patch);
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'structured_output.updated', targetType: 'structured_output', targetId: id, metadata: { fields: Object.keys(patch) }, ip: clientIp(request) });
      return structuredOutputView(row, (await assistantsUsing(tx, org.id, [id])).get(id) ?? 0);
    });
  });

  app.delete('/v1/structured-outputs/:id', { config: { permission: 'assistants:manage' } }, async (request, reply) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Structured output');
    await org.run(async (tx) => {
      const done = await tx.query('UPDATE structured_output SET deleted_at = now(), updated_at = now() WHERE org_id = $1 AND id = $2 AND deleted_at IS NULL', [org.id, id]);
      if (!done.rowCount) throw new ApiError('not_found', 'Structured output not found');
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'structured_output.deleted', targetType: 'structured_output', targetId: id, ip: clientIp(request) });
    });
    return reply.code(204).send();
  });
}
