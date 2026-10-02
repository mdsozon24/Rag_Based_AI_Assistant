import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { executeTool } from '../../../../packages/engine/src/tools/executor.ts';
import { rejectionRuleSchema, toolAuthSchema, toolMessagesSchema, toolSpecSchema, TOOL_TYPES, validateToolSpec, type ToolSpec } from '../../../../packages/engine/src/tools/schema.ts';
import { checkEndpointUrl } from '../../../../packages/engine/src/providers/net.ts';
import type { AppContext } from '../context.ts';
import { clientIp } from '../auth/authenticate.ts';
import { newId } from '../auth/crypto.ts';
import { ApiError } from '../http/errors.ts';
import { cursorClause, idParam, iso, pageRequest, parse, toPage } from '../http/validation.ts';
import { audit } from '../services/audit.ts';
import { scope } from './org.ts';
import { TOOL_COLUMNS as COLUMNS, toolSpecFromRow as toSpec, type ToolRow } from '../services/tools.ts';

const requestSchema = z.object({ authSecret: z.string().min(1).max(4096).optional() }).passthrough();
const patchSchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/).optional(),
  description: z.string().trim().min(1).max(5000).optional(),
  type: z.enum(TOOL_TYPES).optional(),
  parameters: z.record(z.unknown()).optional(),
  messages: toolMessagesSchema.optional(),
  endpointUrl: z.string().url().max(2048).nullable().optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  retries: z.number().int().min(0).max(2).optional(),
  auth: toolAuthSchema.optional(),
  authSecret: z.string().min(1).max(4096).optional(),
  staticParameters: z.record(z.unknown()).optional(),
  variableAliases: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)).optional(),
  sensitivePaths: z.array(z.string().regex(/^[A-Za-z0-9_.-]+$/)).max(100).optional(),
  rejectionRules: z.array(rejectionRuleSchema).max(20).optional(),
}).strict();
const argsSchema = z.record(z.unknown()).default({});

function view(row: ToolRow) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    parameters: row.parameters,
    messages: row.messages,
    endpointUrl: row.endpoint_url,
    timeoutMs: row.timeout_ms,
    retries: row.retries,
    auth: { type: row.auth.type, headerName: row.auth.headerName, configured: Boolean(row.auth_encrypted) },
    staticParameters: row.static_parameters,
    variableAliases: row.variable_aliases,
    sensitivePaths: row.sensitive_paths,
    rejectionRules: row.rejection_rules,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}


function validateEndpoint(spec: ToolSpec, policy: AppContext['voice']['endpointPolicy']): void {
  if (!spec.endpointUrl) return;
  try { checkEndpointUrl(spec.endpointUrl, ['https'], policy); } catch (error) {
    throw new ApiError('validation_error', 'The tool is invalid', { issues: [{ path: 'endpointUrl', message: (error as Error).message }] });
  }
}

function parseSpec(input: unknown, policy: AppContext['voice']['endpointPolicy']): { spec: ToolSpec; authSecret?: string } {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) throw new ApiError('validation_error', 'The tool is invalid', { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  const { authSecret, ...raw } = parsed.data;
  const checked = validateToolSpec(raw);
  if (!checked.ok) throw new ApiError('validation_error', 'The tool is invalid', { issues: checked.issues });
  validateEndpoint(checked.spec, policy);
  return { spec: checked.spec, ...(authSecret ? { authSecret } : {}) };
}

export function registerToolRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/v1/tools', { config: { permission: 'assistants:manage' } }, async (request, reply) => {
    const org = scope(request);
    const parsed = parseSpec(request.body, ctx.voice.endpointPolicy);
    if (parsed.authSecret && !ctx.toolCipher) throw new ApiError('not_configured', 'Tool auth storage requires CREDENTIALS_ENCRYPTION_KEY');
    const id = newId();
    const encrypted = parsed.authSecret && ctx.toolCipher ? ctx.toolCipher.encrypt(parsed.authSecret, `${org.id}:tool:${id}:auth`) : null;
    const row = await org.run(async (tx) => {
      await tx.query(
        `INSERT INTO tool (id, org_id, name, description, type, parameters, messages, endpoint_url, timeout_ms, retries, auth,
          auth_encrypted, static_parameters, variable_aliases, sensitive_paths, rejection_rules, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [id, org.id, parsed.spec.name, parsed.spec.description, parsed.spec.type, JSON.stringify(parsed.spec.parameters), JSON.stringify(parsed.spec.messages), parsed.spec.endpointUrl ?? null, parsed.spec.timeoutMs, parsed.spec.retries, JSON.stringify(parsed.spec.auth), encrypted ? JSON.stringify(encrypted) : null, JSON.stringify(parsed.spec.staticParameters), JSON.stringify(parsed.spec.variableAliases), parsed.spec.sensitivePaths, JSON.stringify(parsed.spec.rejectionRules), org.actor.type === 'user' ? org.actor.id : null]
      );
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'tool.created', targetType: 'tool', targetId: id, metadata: { name: parsed.spec.name, type: parsed.spec.type }, ip: clientIp(request) });
      return (await tx.query<ToolRow>(`SELECT ${COLUMNS} FROM tool WHERE org_id = $1 AND id = $2`, [org.id, id])).rows[0];
    });
    return reply.code(201).send(view(row));
  });

  app.get('/v1/tools', { config: { permission: 'assistants:read' } }, async (request) => {
    const org = scope(request);
    const page = pageRequest(request.query);
    const cursor = cursorClause(page, 3);
    const rows = await org.run(async (tx) => (await tx.query<ToolRow>(`SELECT ${COLUMNS} FROM tool WHERE org_id = $1${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT $2`, [org.id, page.limit + 1, ...cursor.params])).rows);
    return toPage(rows, page.limit, view);
  });

  app.get('/v1/tools/:id', { config: { permission: 'assistants:read' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Tool');
    const row = await org.run(async (tx) => (await tx.query<ToolRow>(`SELECT ${COLUMNS} FROM tool WHERE org_id = $1 AND id = $2`, [org.id, id])).rows[0]);
    if (!row) throw new ApiError('not_found', 'Tool not found');
    return view(row);
  });

  app.patch('/v1/tools/:id', { config: { permission: 'assistants:manage' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Tool');
    const patch = parse(patchSchema, request.body);
    const row = await org.run(async (tx) => {
      const current = (await tx.query<ToolRow>(`SELECT ${COLUMNS} FROM tool WHERE org_id = $1 AND id = $2 FOR UPDATE`, [org.id, id])).rows[0];
      if (!current) throw new ApiError('not_found', 'Tool not found');
      const parsed = parseSpec({ ...toSpec(current), ...patch, ...(patch.endpointUrl === null ? { endpointUrl: undefined } : {}), ...(patch.authSecret ? { authSecret: patch.authSecret } : {}) }, ctx.voice.endpointPolicy);
      if (parsed.authSecret && !ctx.toolCipher) throw new ApiError('not_configured', 'Tool auth storage requires CREDENTIALS_ENCRYPTION_KEY');
      const encrypted = parsed.authSecret && ctx.toolCipher ? ctx.toolCipher.encrypt(parsed.authSecret, `${org.id}:tool:${id}:auth`) : current.auth_encrypted;
      await tx.query(`UPDATE tool SET name=$3, description=$4, type=$5, parameters=$6, messages=$7, endpoint_url=$8, timeout_ms=$9, retries=$10, auth=$11, auth_encrypted=$12, static_parameters=$13, variable_aliases=$14, sensitive_paths=$15, rejection_rules=$16, updated_at=now() WHERE org_id=$1 AND id=$2`, [org.id, id, parsed.spec.name, parsed.spec.description, parsed.spec.type, JSON.stringify(parsed.spec.parameters), JSON.stringify(parsed.spec.messages), parsed.spec.endpointUrl ?? null, parsed.spec.timeoutMs, parsed.spec.retries, JSON.stringify(parsed.spec.auth), encrypted ? JSON.stringify(encrypted) : null, JSON.stringify(parsed.spec.staticParameters), JSON.stringify(parsed.spec.variableAliases), parsed.spec.sensitivePaths, JSON.stringify(parsed.spec.rejectionRules)]);
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'tool.updated', targetType: 'tool', targetId: id, metadata: { name: parsed.spec.name }, ip: clientIp(request) });
      return (await tx.query<ToolRow>(`SELECT ${COLUMNS} FROM tool WHERE org_id = $1 AND id = $2`, [org.id, id])).rows[0];
    });
    return view(row);
  });

  app.delete('/v1/tools/:id', { config: { permission: 'assistants:manage' } }, async (request, reply) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Tool');
    await org.run(async (tx) => {
      const deleted = await tx.query('DELETE FROM tool WHERE org_id = $1 AND id = $2', [org.id, id]);
      if (!deleted.rowCount) throw new ApiError('not_found', 'Tool not found');
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'tool.deleted', targetType: 'tool', targetId: id, ip: clientIp(request) });
    });
    return reply.code(204).send();
  });

  app.post('/v1/tools/:id/test', { config: { permission: 'assistants:manage' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Tool');
    const args = parse(argsSchema, request.body);
    const row = await org.run(async (tx) => (await tx.query<ToolRow>(`SELECT ${COLUMNS} FROM tool WHERE org_id = $1 AND id = $2`, [org.id, id])).rows[0]);
    if (!row) throw new ApiError('not_found', 'Tool not found');
    const secret = row.auth_encrypted && ctx.toolCipher ? ctx.toolCipher.decrypt(row.auth_encrypted, `${org.id}:tool:${id}:auth`) : undefined;
    const result = await executeTool(toSpec(row, secret), args, { callId: `tool-test-${id}`, fetch: ctx.fetch, authSecret: secret });
    return { status: result.status, output: result.output, error: result.error, latencyMs: result.latencyMs };
  });
}