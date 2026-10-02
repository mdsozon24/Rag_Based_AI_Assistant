/**
 * Operations endpoints for the platform operator's infrastructure (no org, no customer data):
 *
 * - GET /ready: readiness for the load balancer. 503 while the database does not answer, or while
 *   this node is at VOICE_MAX_SESSIONS, so new connections go to another node; calls already on
 *   it carry on. Liveness stays on GET /health.
 * - GET /metrics: Prometheus text format, only for `Authorization: Bearer <METRICS_TOKEN>`. With no
 *   token configured the route answers 404, exactly like a route that does not exist.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { ApiError } from '../http/errors.ts';

/** A database that has not answered within this long counts as down. */
const DB_CHECK_TIMEOUT_MS = 2000;

const digest = (value: string) => createHash('sha256').update(value).digest();

/** Constant-time comparison of a presented token with the configured one. */
function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(digest(presented), digest(expected));
}

async function databaseAnswers(ctx: AppContext): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('database check timed out')), DB_CHECK_TIMEOUT_MS);
    });
    await Promise.race([ctx.db.query('SELECT 1'), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function registerOpsRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/ready', { config: { auth: 'none' } }, async (request, reply) => {
    const database = await databaseAnswers(ctx);
    const liveSessions = ctx.webCalls.activeCount;
    const maxSessions = ctx.config.voice.maxSessions;
    const capacity = liveSessions < maxSessions;
    const ok = database && capacity;
    if (!database) request.log.warn('readiness: database did not answer');
    return reply.code(ok ? 200 : 503).send({
      ok,
      version: ctx.config.appVersion,
      uptimeSeconds: Math.floor((Date.now() - ctx.startedAt.getTime()) / 1000),
      checks: { database: database ? 'ok' : 'failed', capacity: capacity ? 'ok' : 'full' },
      liveSessions,
      maxSessions,
    });
  });

  app.get('/metrics', { config: { auth: 'none' } }, async (request, reply) => {
    const expected = ctx.config.metricsToken;
    if (!expected) throw new ApiError('not_found', 'Route not found');
    const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '');
    if (!match || !tokenMatches(match[1], expected)) throw new ApiError('unauthorized', 'A valid metrics token is required');
    const body = await ctx.metrics.render();
    return reply.type(ctx.metrics.contentType).send(body);
  });
}
