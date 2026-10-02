/**
 * Idempotency-Key support for routes with `config.idempotent` (POSTs that create calls or charge
 * money). Keys are scoped to the org and kept 24 h:
 * - first request: runs, and its response (status + body) is stored;
 * - same key + same request: the stored response is replayed (header Idempotent-Replayed: true);
 * - same key + different request: 422 idempotency_key_reused;
 * - same key while the first is still running: 409 idempotency_in_progress.
 * 5xx responses are not stored, so the client can retry with the same key.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sha256 } from '../auth/crypto.ts';
import { ApiError } from './errors.ts';

const TTL_MS = 24 * 60 * 60 * 1000;
const HEADER = 'idempotency-key';

interface Pending {
  key: string;
}

function requestHash(request: FastifyRequest): string {
  return sha256(`${request.method} ${request.routeOptions.url} ${JSON.stringify(request.params ?? {})} ${JSON.stringify(request.body ?? null)}`);
}

export function registerIdempotency(app: FastifyInstance): void {
  app.addHook('preHandler', async (request, reply) => {
    if (!request.routeOptions.config?.idempotent || !request.org) return;
    const raw = request.headers[HEADER];
    if (raw === undefined) return;
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!key || key.length > 255) throw new ApiError('validation_error', 'Idempotency-Key must be 1-255 characters');
    const hash = requestHash(request);
    const org = request.org;

    const outcome = await org.run(async (tx) => {
      await tx.query('DELETE FROM idempotency_key WHERE org_id = $1 AND key = $2 AND expires_at <= now()', [org.id, key]);
      const inserted = await tx.query(
        `INSERT INTO idempotency_key (org_id, key, request_hash, status, expires_at)
         VALUES ($1, $2, $3, 'in_progress', now() + ($4::bigint * interval '1 millisecond'))
         ON CONFLICT (org_id, key) DO NOTHING`,
        [org.id, key, hash, TTL_MS]
      );
      if (inserted.rowCount === 1) return { kind: 'new' as const };
      const existing = await tx.query<{ request_hash: string; status: string; response_status: number | null; response_body: unknown }>(
        'SELECT request_hash, status, response_status, response_body FROM idempotency_key WHERE org_id = $1 AND key = $2',
        [org.id, key]
      );
      return { kind: 'existing' as const, row: existing.rows[0] };
    });

    if (outcome.kind === 'new') {
      (request as FastifyRequest & { idempotency?: Pending }).idempotency = { key };
      return;
    }
    const row = outcome.row;
    if (row.request_hash !== hash) throw new ApiError('idempotency_key_reused', 'This Idempotency-Key was already used for a different request');
    if (row.status !== 'completed') throw new ApiError('idempotency_in_progress', 'A request with this Idempotency-Key is still being processed');
    reply.header('Idempotent-Replayed', 'true');
    return reply.code(row.response_status ?? 200).send(row.response_body);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const pending = (request as FastifyRequest & { idempotency?: Pending }).idempotency;
    if (!pending || !request.org) return payload;
    const org = request.org;
    try {
      if (reply.statusCode >= 500) {
        await org.run((tx) => tx.query('DELETE FROM idempotency_key WHERE org_id = $1 AND key = $2', [org.id, pending.key]));
      } else {
        const body = typeof payload === 'string' && payload.length > 0 ? payload : 'null';
        await org.run((tx) =>
          tx.query(`UPDATE idempotency_key SET status = 'completed', response_status = $3, response_body = $4::jsonb WHERE org_id = $1 AND key = $2`, [
            org.id,
            pending.key,
            reply.statusCode,
            body,
          ])
        );
      }
    } catch (err) {
      request.log.error({ err }, 'could not store idempotent response');
    }
    return payload;
  });
}
