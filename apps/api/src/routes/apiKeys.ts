/**
 * API keys. The full key is returned once, at creation; only its SHA-256 hash is stored.
 * Private keys (sk_) are for servers. Public keys (pk_) are for browsers: they can only start web
 * calls, only from their allowed origins, and (if set) only for their allowed assistants.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { clientIp } from '../auth/authenticate.ts';
import { generateApiKey, maskedKey, newId } from '../auth/crypto.ts';
import { ApiError } from '../http/errors.ts';
import { cursorClause, idParam, iso, pageRequest, parse, toPage } from '../http/validation.ts';
import { audit } from '../services/audit.ts';
import { scope } from './org.ts';

interface ApiKeyRow {
  id: string;
  cursor_ts: string;
  name: string;
  type: 'private' | 'public';
  prefix: string;
  allowed_origins: string[];
  allowed_assistant_ids: string[];
  rate_limit_per_minute: number | null;
  created_at: Date;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}

const COLUMNS = `id, created_at::text AS cursor_ts, name, type, prefix, allowed_origins, allowed_assistant_ids, rate_limit_per_minute, created_at, last_used_at, expires_at, revoked_at`;

export const apiKeyView = (k: ApiKeyRow) => ({
  id: k.id,
  name: k.name,
  type: k.type,
  /** Masked: the full key is only shown at creation. */
  key: maskedKey(k.prefix),
  allowedOrigins: k.allowed_origins,
  allowedAssistantIds: k.allowed_assistant_ids,
  rateLimitPerMinute: k.rate_limit_per_minute,
  status: k.revoked_at ? 'revoked' : k.expires_at && k.expires_at.getTime() <= Date.now() ? 'expired' : 'active',
  createdAt: iso(k.created_at),
  lastUsedAt: iso(k.last_used_at),
  expiresAt: iso(k.expires_at),
  revokedAt: iso(k.revoked_at),
});

/** "https://app.example.com" or "http://localhost:5173": scheme + host (+ port), nothing else. */
const origin = z
  .string()
  .max(200)
  .refine((value) => {
    try {
      const url = new URL(value);
      const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      return (url.protocol === 'https:' || (url.protocol === 'http:' && local)) && url.origin === value;
    } catch {
      return false;
    }
  }, 'Must be an origin like https://app.example.com (http only for localhost)');

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    type: z.enum(['private', 'public']),
    allowedOrigins: z.array(origin).max(20).optional(),
    allowedAssistantIds: z.array(z.string().uuid()).max(100).optional(),
    rateLimitPerMinute: z.number().int().min(1).max(100_000).optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict()
  .superRefine((body, issue) => {
    if (body.type === 'public' && !body.allowedOrigins?.length) {
      issue.addIssue({ code: z.ZodIssueCode.custom, path: ['allowedOrigins'], message: 'Public keys need at least one allowed origin' });
    }
    if (body.type === 'private' && (body.allowedOrigins?.length || body.allowedAssistantIds?.length)) {
      issue.addIssue({ code: z.ZodIssueCode.custom, path: ['type'], message: 'Origin and assistant restrictions apply to public keys only' });
    }
    if (body.expiresAt && Date.parse(body.expiresAt) <= Date.now()) {
      issue.addIssue({ code: z.ZodIssueCode.custom, path: ['expiresAt'], message: 'Must be in the future' });
    }
  });

export function registerApiKeyRoutes(app: FastifyInstance, _ctx: AppContext): void {
  app.post('/v1/api-keys', { config: { permission: 'api_keys:manage' } }, async (request, reply) => {
    const org = scope(request);
    const body = parse(createSchema, request.body);
    const generated = generateApiKey(body.type);
    const row = await org.run(async (tx) => {
      const created = (
        await tx.query<ApiKeyRow>(
          `INSERT INTO api_key (id, org_id, name, type, prefix, key_hash, allowed_origins, allowed_assistant_ids, rate_limit_per_minute, created_by_user_id, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING ${COLUMNS}`,
          [
            newId(),
            org.id,
            body.name,
            body.type,
            generated.prefix,
            generated.hash,
            body.allowedOrigins ?? [],
            body.allowedAssistantIds ?? [],
            body.rateLimitPerMinute ?? null,
            org.actor.type === 'user' ? org.actor.id : null,
            body.expiresAt ?? null,
          ]
        )
      ).rows[0];
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'api_key.created', targetType: 'api_key', targetId: created.id, metadata: { name: body.name, type: body.type }, ip: clientIp(request) });
      return created;
    });
    // The only time the full key is ever returned
    return reply.code(201).send({ ...apiKeyView(row), key: generated.key });
  });

  app.get('/v1/api-keys', { config: { permission: 'api_keys:read' } }, async (request) => {
    const org = scope(request);
    const page = pageRequest(request.query);
    const cursor = cursorClause(page, 3);
    const rows = await org.run(async (tx) =>
      (await tx.query<ApiKeyRow>(`SELECT ${COLUMNS} FROM api_key WHERE org_id = $1${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT $2`, [org.id, page.limit + 1, ...cursor.params])).rows
    );
    return toPage(rows, page.limit, apiKeyView);
  });

  app.get('/v1/api-keys/:id', { config: { permission: 'api_keys:read' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'API key');
    const row = await org.run(async (tx) => (await tx.query<ApiKeyRow>(`SELECT ${COLUMNS} FROM api_key WHERE org_id = $1 AND id = $2`, [org.id, id])).rows[0]);
    if (!row) throw new ApiError('not_found', 'API key not found');
    return apiKeyView(row);
  });

  app.delete('/v1/api-keys/:id', { config: { permission: 'api_keys:manage' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'API key');
    const row = await org.run(async (tx) => {
      const revoked = (
        await tx.query<ApiKeyRow>(
          `UPDATE api_key SET revoked_at = coalesce(revoked_at, now()), revoked_by_user_id = coalesce(revoked_by_user_id, $3)
           WHERE org_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
          [org.id, id, org.actor.type === 'user' ? org.actor.id : null]
        )
      ).rows[0];
      if (!revoked) throw new ApiError('not_found', 'API key not found');
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'api_key.revoked', targetType: 'api_key', targetId: id, ip: clientIp(request) });
      return revoked;
    });
    return apiKeyView(row);
  });
}
