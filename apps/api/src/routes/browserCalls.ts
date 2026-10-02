/**
 * Browser call endpoints that do not use API-key auth:
 * - GET /v1/calls/:id/connect: the call's media WebSocket. Authenticated by the one-time connect
 *   token in the first frame (see voice/webCalls.ts), never by a cookie or key.
 * - GET /sdk/:file: the built @octo/web bundles (packages/sdk/dist), for the <script> embed.
 */
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';
import type { AppContext } from '../context.ts';
import { ApiError } from '../http/errors.ts';

export const SDK_DIST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../packages/sdk/dist');
const SDK_FILES = new Set(['widget.js', 'widget.js.map', 'octo-web.js', 'octo-web.js.map']);

export function registerBrowserCallRoutes(app: FastifyInstance, ctx: AppContext, options: { sdkDir?: string } = {}): void {
  app.get('/v1/calls/:id/connect', { websocket: true, config: { auth: 'none' } }, (socket: WebSocket, request) => {
    ctx.webCalls.accept(socket, request, (request.params as { id: string }).id);
  });

  app.get('/sdk/:file', { config: { auth: 'none' } }, async (request, reply) => {
    const file = (request.params as { file: string }).file;
    if (!SDK_FILES.has(file)) throw new ApiError('not_found', 'Unknown SDK file');
    let body: Buffer;
    try {
      body = await fs.readFile(path.join(options.sdkDir ?? SDK_DIST_DIR, file));
    } catch {
      throw new ApiError('not_configured', 'The SDK bundle is not built on this server (npm run sdk:build)');
    }
    reply.header('Content-Type', file.endsWith('.map') ? 'application/json' : 'text/javascript; charset=utf-8');
    // ES module imports from customer pages need CORS; the bundle is public and has no secrets
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    return reply.send(body);
  });
}
