/**
 * CORS for the browser SDK. Only routes that accept public keys (config.allowPublicKey: today
 * POST /v1/calls) are readable cross-origin. The Origin is reflected; whether that origin may use
 * the key is decided by the auth hook (403 origin_not_allowed), and the reflected header lets the
 * SDK read that error. Credentials are never allowed, so dashboard cookies are not sent cross-site.
 */
import type { FastifyInstance } from 'fastify';

const ALLOWED_HEADERS = 'authorization, content-type, idempotency-key, x-request-id';
const EXPOSED_HEADERS = 'x-request-id, retry-after, x-ratelimit-limit, x-ratelimit-remaining';

export function registerCors(app: FastifyInstance, preflightPaths: string[]): void {
  app.addHook('onSend', async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin || !request.routeOptions.config?.allowPublicKey) return;
    reply.header('Access-Control-Allow-Origin', origin);
    reply.header('Access-Control-Expose-Headers', EXPOSED_HEADERS);
    reply.header('Vary', 'Origin');
  });

  for (const url of preflightPaths) {
    app.options(url, { config: { auth: 'none' } }, async (request, reply) => {
      const origin = request.headers.origin;
      if (origin) {
        reply.header('Access-Control-Allow-Origin', origin);
        reply.header('Access-Control-Allow-Methods', 'POST');
        reply.header('Access-Control-Allow-Headers', ALLOWED_HEADERS);
        reply.header('Access-Control-Max-Age', '600');
        reply.header('Vary', 'Origin');
      }
      return reply.code(204).send();
    });
  }
}
