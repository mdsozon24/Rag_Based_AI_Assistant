/**
 * Chat API: POST /v1/chat (JSON or server-sent events), and the session endpoints.
 *
 * Callers: private keys and dashboard sessions (channel "api"), and public keys from the browser
 * (channel "web": allowed origins and assistants, the override allowlist, the session bound to the
 * key and origin that started it, typed messages limited per session).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { ApiError } from '../http/errors.ts';
import { assertPublicOverrides, isPublicKey } from '../http/publicKeys.ts';
import { openSse } from '../http/sse.ts';
import { idParam, parse } from '../http/validation.ts';
import { MAX_CHAT_MESSAGE_CHARS, sessionView, type SessionRow, type TurnOutcome } from '../services/chat.ts';
import { scope } from './org.ts';

/** Messages per public-key session per minute (each one is an LLM request paid by the org). */
const PUBLIC_MESSAGES_PER_MINUTE = 20;

const chatSchema = z
  .object({
    message: z.string().trim().min(1).max(MAX_CHAT_MESSAGE_CHARS),
    sessionId: z.string().uuid().optional(),
    assistantId: z.string().uuid().optional(),
    squadId: z.string().uuid().optional(),
    assistant: z.record(z.unknown()).optional(),
    version: z.number().int().positive().optional(),
    variables: z.record(z.string().max(10_000)).default({}),
    overrides: z.record(z.unknown()).default({}),
    metadata: z.record(z.unknown()).default({}),
    stream: z.boolean().default(false),
  })
  .strict();

function requestOrigin(request: FastifyRequest): string | null {
  return typeof request.headers.origin === 'string' ? request.headers.origin : null;
}

function turnView(outcome: TurnOutcome) {
  return {
    sessionId: outcome.sessionId,
    message: { role: 'assistant' as const, content: outcome.reply },
    ended: outcome.ended,
    endReason: outcome.endReason,
    memberId: outcome.memberId,
    toolCalls: outcome.toolCalls,
    usage: outcome.usage,
  };
}

export function registerChatRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/v1/chat', { config: { permission: 'chat:create', allowPublicKey: true } }, async (request, reply) => {
    const org = scope(request);
    const body = parse(chatSchema, request.body);
    const publicKey = isPublicKey(request);
    const keyId = request.principal?.kind === 'api_key' ? request.principal.keyId : null;
    const origin = requestOrigin(request);

    let session: SessionRow;
    if (body.sessionId) {
      if (body.assistantId || body.squadId || body.assistant || body.version || Object.keys(body.overrides).length || Object.keys(body.variables).length) {
        throw new ApiError('validation_error', 'The request is invalid', { issues: [{ path: 'sessionId', message: 'A session keeps its assistant, variables and overrides; send only message (and stream)' }] });
      }
      session = await ctx.chat.getSession(org.id, body.sessionId);
      // A browser session continues only from the key and origin that started it
      if (publicKey && (session.created_by_id !== keyId || session.origin !== origin || session.channel !== 'web')) throw new ApiError('not_found', 'Chat session not found');
    } else {
      const targets = [body.assistantId, body.squadId, body.assistant].filter(Boolean).length;
      if (targets !== 1) throw new ApiError('validation_error', 'The request is invalid', { issues: [{ path: 'assistantId', message: 'Provide exactly one of sessionId, assistantId, squadId or assistant' }] });
      if (publicKey) {
        if (!body.assistantId) throw new ApiError('forbidden_key_type', 'Public browser keys require a saved assistantId; start squads and inline assistants from your server with a private key');
        assertPublicOverrides(body.overrides);
      }
      if (body.assistantId) org.assertAssistantAllowed(body.assistantId);
      session = await ctx.chat.createSession(org.id, {
        channel: publicKey ? 'web' : 'api',
        actor: org.actor,
        assistantId: body.assistantId,
        squadId: body.squadId,
        assistant: body.assistant,
        version: body.version,
        variables: body.variables,
        overrides: body.overrides,
        origin: publicKey ? origin : null,
        metadata: body.metadata,
      });
    }

    if (publicKey) {
      const decision = ctx.rateLimiter.consume(`chat-text:${session.id}`, PUBLIC_MESSAGES_PER_MINUTE, 60_000);
      if (!decision.allowed) throw new ApiError('rate_limited', `Too many messages in this chat; retry after ${decision.retryAfterSeconds}s`, { retryAfterSeconds: decision.retryAfterSeconds }, { 'Retry-After': String(decision.retryAfterSeconds) });
    }

    if (!body.stream) {
      const controller = new AbortController();
      request.raw.on('close', () => !reply.sent && controller.abort());
      const outcome = await ctx.chat.runTurn(org.id, session.id, body.message, { logger: request.log, signal: controller.signal });
      return turnView(outcome);
    }

    const sse = openSse(request, reply, { corsOrigin: publicKey ? origin : null });
    sse.send('session', { sessionId: session.id });
    try {
      const outcome = await ctx.chat.runTurn(org.id, session.id, body.message, {
        logger: request.log,
        signal: sse.signal,
        onEvent: (event) => {
          if (event.type === 'delta') sse.send('delta', { text: event.text });
          else if (event.type === 'tool-call') sse.send('tool-call', { name: event.name, args: event.args });
          else if (event.type === 'tool-result') sse.send('tool-result', { name: event.name, status: event.status });
          else sse.send('handoff', { from: event.from ?? null, to: event.to });
        },
      });
      sse.send('done', turnView(outcome));
    } catch (error) {
      const failure = error instanceof ApiError ? error.toJSON() : { code: 'internal_error', message: 'Something went wrong; quote the request id when contacting support', details: { requestId: request.id } };
      if (!(error instanceof ApiError)) request.log.error({ err: error }, 'chat stream failed');
      sse.send('error', failure);
    } finally {
      sse.close();
    }
    return reply;
  });

  app.get('/v1/chat/sessions/:id', { config: { permission: 'chat:read' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Chat session');
    const session = await ctx.chat.getSession(org.id, id);
    return { ...sessionView(session), messages: await ctx.chat.messages(org.id, id) };
  });

  app.post('/v1/chat/sessions/:id/end', { config: { permission: 'chat:create' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Chat session');
    return sessionView(await ctx.chat.endSession(org.id, id, 'api-ended'));
  });
}
