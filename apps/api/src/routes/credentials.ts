/**
 * Provider credentials (bring your own key). Secrets go in once and never come back out: every
 * response is the masked view. Encryption and masking live in the engine's CredentialService.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CREDENTIAL_VENDORS, CredentialError } from '../../../../packages/engine/src/credentials/service.ts';
import type { AppContext } from '../context.ts';
import { clientIp } from '../auth/authenticate.ts';
import { ApiError } from '../http/errors.ts';
import { cursorClause, idParam, iso, pageRequest, parse, toPage } from '../http/validation.ts';
import { audit } from '../services/audit.ts';
import { scope } from './org.ts';

interface Row {
  id: string;
  cursor_ts: string;
  provider: string;
  label: string;
  masked: string;
  created_at: Date;
  last_used_at: Date | null;
}
const view = (r: Row) => ({ id: r.id, provider: r.provider, label: r.label, masked: r.masked, createdAt: iso(r.created_at), lastUsedAt: iso(r.last_used_at) });
const COLUMNS = 'id, created_at::text AS cursor_ts, provider, label, masked, created_at, last_used_at';

export function registerCredentialRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/v1/credentials', { config: { permission: 'credentials:manage' } }, async (request, reply) => {
    const org = scope(request);
    const body = parse(
      z.object({ provider: z.enum(CREDENTIAL_VENDORS as [string, ...string[]]), secret: z.string().min(1).max(4096), label: z.string().trim().min(1).max(100).optional() }).strict(),
      request.body
    );
    let created;
    try {
      created = await ctx.credentials.create(org.id, body);
    } catch (error) {
      if (error instanceof CredentialError) {
        if (error.code === 'encryption-unavailable') throw new ApiError('not_configured', 'Storing provider keys is not configured on this server (CREDENTIALS_ENCRYPTION_KEY)');
        throw new ApiError('validation_error', error.message, { issues: [{ path: 'secret', message: error.message }] });
      }
      throw error;
    }
    await org.run((tx) =>
      audit(tx, { orgId: org.id, actor: org.actor, action: 'credential.created', targetType: 'credential', targetId: created.id, metadata: { provider: created.provider, label: created.label }, ip: clientIp(request) })
    );
    return reply.code(201).send({ id: created.id, provider: created.provider, label: created.label, masked: created.masked, createdAt: created.createdAt, lastUsedAt: null });
  });

  app.get('/v1/credentials', { config: { permission: 'credentials:read' } }, async (request) => {
    const org = scope(request);
    const page = pageRequest(request.query);
    const cursor = cursorClause(page, 3);
    const rows = await org.run(async (tx) =>
      (await tx.query<Row>(`SELECT ${COLUMNS} FROM provider_credential WHERE org_id = $1${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT $2`, [org.id, page.limit + 1, ...cursor.params])).rows
    );
    return toPage(rows, page.limit, view);
  });

  app.get('/v1/credentials/:id', { config: { permission: 'credentials:read' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Credential');
    const row = await org.run(async (tx) => (await tx.query<Row>(`SELECT ${COLUMNS} FROM provider_credential WHERE org_id = $1 AND id = $2`, [org.id, id])).rows[0]);
    if (!row) throw new ApiError('not_found', 'Credential not found');
    return view(row);
  });

  app.delete('/v1/credentials/:id', { config: { permission: 'credentials:manage' } }, async (request, reply) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Credential');
    await org.run(async (tx) => {
      const deleted = await tx.query('DELETE FROM provider_credential WHERE org_id = $1 AND id = $2', [org.id, id]);
      if (deleted.rowCount === 0) throw new ApiError('not_found', 'Credential not found');
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'credential.deleted', targetType: 'credential', targetId: id, ip: clientIp(request) });
    });
    return reply.code(204).send();
  });
}
