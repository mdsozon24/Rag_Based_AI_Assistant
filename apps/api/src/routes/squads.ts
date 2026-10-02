import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { newId } from '../auth/crypto.ts';
import { clientIp } from '../auth/authenticate.ts';
import type { AppContext } from '../context.ts';
import { ApiError } from '../http/errors.ts';
import { cursorClause, idParam, iso, pageRequest, parse, toPage } from '../http/validation.ts';
import { audit } from '../services/audit.ts';
import { requireValidSpec } from '../services/assistants.ts';
import { scope } from './org.ts';

const memberSchema = z.object({
  id: z.string().uuid().optional(),
  assistantId: z.string().uuid().optional(),
  inlineConfig: z.record(z.unknown()).optional(),
  memberOverrides: z.record(z.unknown()).default({}),
  contextMode: z.enum(['full', 'summary', 'variables']).default('summary'),
  contextSchema: z.record(z.unknown()).optional(),
  handoffTargets: z.record(z.string().trim().min(1).max(1000)).default({}),
}).strict().refine((member) => Boolean(member.assistantId) !== Boolean(member.inlineConfig), { message: 'Provide exactly one of assistantId or inlineConfig', path: ['assistantId'] });
const squadSchema = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(5000).default(''), maxHandoffs: z.number().int().min(1).max(20).default(4), overrides: z.record(z.unknown()).default({}), members: z.array(memberSchema).min(1).max(20) }).strict();
const patchSchema = squadSchema.partial().extend({ members: z.array(memberSchema).min(1).max(20).optional() }).strict();

interface MemberRow { id: string; position: number; assistant_id: string | null; inline_config: Record<string, unknown> | null; member_overrides: Record<string, unknown>; context_mode: 'full' | 'summary' | 'variables'; context_schema: Record<string, unknown> | null; handoff_targets: Record<string, string>; }
interface SquadRow { id: string; cursor_ts: string; name: string; description: string; max_handoffs: number; overrides: Record<string, unknown>; created_at: Date; updated_at: Date; }

async function validateMembers(tx: { query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }, orgId: string, members: z.infer<typeof memberSchema>, all: z.infer<typeof memberSchema>[], ctx: AppContext): Promise<void> {
  const ids = all.flatMap((member) => member.assistantId ? [member.assistantId] : []);
  if (ids.length) {
    const found = new Set((await tx.query<{ id: string }>('SELECT id FROM assistant WHERE org_id=$1 AND id = ANY($2::uuid[])', [orgId, ids])).rows.map((row) => row.id));
    for (const [index, member] of all.entries()) if (member.assistantId && !found.has(member.assistantId)) throw new ApiError('validation_error', 'The squad references an unavailable assistant', { issues: [{ path: `members.${index}.assistantId`, message: 'Assistant not found in this organization' }] });
  }
  for (const [index, member] of all.entries()) if (member.inlineConfig) requireValidSpec(member.inlineConfig, { registry: ctx.voice.registry, endpointPolicy: ctx.voice.endpointPolicy }, `members.${index}.inlineConfig`);
}

async function memberViews(tx: { query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }, squadId: string) {
  const rows = (await tx.query<MemberRow>('SELECT id, position, assistant_id, inline_config, member_overrides, context_mode, context_schema, handoff_targets FROM squad_member WHERE squad_id=$1 ORDER BY position', [squadId])).rows;
  return rows.map((row) => ({ id: row.id, position: row.position, assistantId: row.assistant_id, inlineConfig: row.inline_config, memberOverrides: row.member_overrides, contextMode: row.context_mode, contextSchema: row.context_schema, handoffTargets: row.handoff_targets }));
}

export function registerSquadRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/v1/squads', { config: { permission: 'assistants:manage' } }, async (request, reply) => {
    const org = scope(request); const body = parse(squadSchema, request.body);
    const result = await org.run(async (tx) => { await validateMembers(tx, org.id, body.members[0], body.members, ctx); const id = newId(); await tx.query('INSERT INTO squad (id,org_id,name,description,max_handoffs,overrides,created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, org.id, body.name, body.description, body.maxHandoffs, JSON.stringify(body.overrides), org.actor.type === 'user' ? org.actor.id : null]); for (const [position, member] of body.members.entries()) await insertMember(tx, org.id, id, position, member); await audit(tx, { orgId: org.id, actor: org.actor, action: 'squad.created', targetType: 'squad', targetId: id, metadata: { name: body.name, members: body.members.length }, ip: clientIp(request) }); return getSquad(tx, org.id, id); });
    return reply.code(201).send(result);
  });

  app.get('/v1/squads', { config: { permission: 'assistants:read' } }, async (request) => { const org = scope(request); const page = pageRequest(request.query); const cursor = cursorClause(page, 3); const rows = await org.run(async (tx) => (await tx.query<SquadRow>(`SELECT id, created_at::text AS cursor_ts, name, description, max_handoffs, overrides, created_at, updated_at FROM squad WHERE org_id=$1${cursor.sql} ORDER BY created_at DESC,id DESC LIMIT $2`, [org.id, page.limit + 1, ...cursor.params])).rows); return toPage(rows, page.limit, (row) => ({ id: row.id, name: row.name, description: row.description, maxHandoffs: row.max_handoffs, overrides: row.overrides, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })); });
  app.get('/v1/squads/:id', { config: { permission: 'assistants:read' } }, async (request) => { const org = scope(request); return org.run((tx) => getSquad(tx, org.id, idParam(request.params, 'id', 'Squad'))); });
  app.patch('/v1/squads/:id', { config: { permission: 'assistants:manage' } }, async (request) => { const org = scope(request); const id = idParam(request.params, 'id', 'Squad'); const patch = parse(patchSchema, request.body); return org.run(async (tx) => { const current = (await tx.query<SquadRow>('SELECT id, created_at::text AS cursor_ts, name, description, max_handoffs, overrides, created_at, updated_at FROM squad WHERE org_id=$1 AND id=$2 FOR UPDATE', [org.id, id])).rows[0]; if (!current) throw new ApiError('not_found', 'Squad not found'); const members = patch.members ?? await getMemberInputs(tx, id); await validateMembers(tx, org.id, members[0], members, ctx); await tx.query('UPDATE squad SET name=$3,description=$4,max_handoffs=$5,overrides=$6,updated_at=now() WHERE org_id=$1 AND id=$2', [org.id, id, patch.name ?? current.name, patch.description ?? current.description, patch.maxHandoffs ?? current.max_handoffs, JSON.stringify(patch.overrides ?? current.overrides)]); if (patch.members) { await tx.query('DELETE FROM squad_member WHERE org_id=$1 AND squad_id=$2', [org.id, id]); for (const [position, member] of patch.members.entries()) await insertMember(tx, org.id, id, position, member); } await audit(tx, { orgId: org.id, actor: org.actor, action: 'squad.updated', targetType: 'squad', targetId: id, ip: clientIp(request) }); return getSquad(tx, org.id, id); }); });
  app.delete('/v1/squads/:id', { config: { permission: 'assistants:manage' } }, async (request, reply) => { const org = scope(request); const id = idParam(request.params, 'id', 'Squad'); await org.run(async (tx) => { const result = await tx.query('DELETE FROM squad WHERE org_id=$1 AND id=$2', [org.id, id]); if (!result.rowCount) throw new ApiError('not_found', 'Squad not found'); }); return reply.code(204).send(); });
}

async function insertMember(tx: { query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }, orgId: string, squadId: string, position: number, member: z.infer<typeof memberSchema>): Promise<void> { await tx.query('INSERT INTO squad_member (id,org_id,squad_id,position,assistant_id,inline_config,member_overrides,context_mode,context_schema,handoff_targets) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [member.id ?? newId(), orgId, squadId, position, member.assistantId ?? null, member.inlineConfig ? JSON.stringify(member.inlineConfig) : null, JSON.stringify(member.memberOverrides), member.contextMode, member.contextSchema ? JSON.stringify(member.contextSchema) : null, JSON.stringify(member.handoffTargets)]); }
async function getMemberInputs(tx: { query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }, squadId: string): Promise<z.infer<typeof memberSchema>[]> { const rows = (await tx.query<MemberRow>('SELECT id, assistant_id, inline_config, member_overrides, context_mode, context_schema, handoff_targets FROM squad_member WHERE squad_id=$1 ORDER BY position', [squadId])).rows; return rows.map((row) => ({ id: row.id, assistantId: row.assistant_id ?? undefined, inlineConfig: row.inline_config ?? undefined, memberOverrides: row.member_overrides, contextMode: row.context_mode, contextSchema: row.context_schema ?? undefined, handoffTargets: row.handoff_targets })); }
async function getSquad(tx: { query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }, orgId: string, id: string) { const row = (await tx.query<SquadRow>('SELECT id, created_at::text AS cursor_ts, name, description, max_handoffs, overrides, created_at, updated_at FROM squad WHERE org_id=$1 AND id=$2', [orgId, id])).rows[0]; if (!row) throw new ApiError('not_found', 'Squad not found'); return { id: row.id, name: row.name, description: row.description, maxHandoffs: row.max_handoffs, overrides: row.overrides, members: await memberViews(tx, id), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }; }