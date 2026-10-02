/**
 * OpenAI-compatible Chat Completions: POST /v1/chat/completions, so code written for the OpenAI SDK
 * can talk to an assistant by pointing baseURL at this API and using a private key.
 *
 * - `model`: the assistant id (or "assistant:<id>", or "squad:<id>").
 * - `messages` is the history, as with OpenAI (stateless). The assistant's own system prompt, tools
 *   and squad always apply; the client's system/developer messages are added as extra instructions.
 * - Each request is recorded as a chat session (channel "openai") for usage, billing and webhooks.
 *   Send `x-octo-session-id` (returned on every response) to group requests into one session.
 * - Streaming (`stream: true`) sends chat.completion.chunk events and `data: [DONE]`.
 * - Errors use OpenAI's shape: {"error": {"message", "type", "param", "code"}}.
 * Not supported: client-defined `tools`/`functions` (the assistant's tools run server-side), n > 1.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ChatMessage } from '../../../../packages/engine/src/providers/types.ts';
import type { AppContext } from '../context.ts';
import { ApiError } from '../http/errors.ts';
import { openSse } from '../http/sse.ts';
import { scope } from './org.ts';

const SESSION_HEADER = 'x-octo-session-id';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const contentSchema = z.union([
  z.string(),
  z.null(),
  z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
]);
const messageSchema = z
  .object({ role: z.enum(['system', 'developer', 'user', 'assistant', 'tool', 'function']), content: contentSchema.optional(), name: z.string().optional() })
  .passthrough();
const completionSchema = z
  .object({
    model: z.string().min(1).max(200),
    messages: z.array(messageSchema).min(1).max(500),
    stream: z.boolean().nullish(),
    stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().nullish(),
    temperature: z.number().min(0).max(2).nullish(),
    max_tokens: z.number().int().positive().max(32_000).nullish(),
    max_completion_tokens: z.number().int().positive().max(32_000).nullish(),
    n: z.number().int().nullish(),
    tools: z.array(z.unknown()).nullish(),
    functions: z.array(z.unknown()).nullish(),
    /** Extension: values for the assistant's {{variables}} (new sessions only). */
    variables: z.record(z.string().max(10_000)).nullish(),
  })
  .passthrough();

const ERROR_TYPES: Record<number, string> = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 409: 'invalid_request_error', 429: 'rate_limit_error' };

function openAiError(status: number, message: string, code: string, param: string | null = null) {
  return { error: { message, type: ERROR_TYPES[status] ?? 'api_error', param, code } };
}

function invalid(message: string, param: string): ApiError {
  return new ApiError('validation_error', message, { issues: [{ path: param, message }] });
}

function textOf(content: z.infer<typeof contentSchema> | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  return content.filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
}

function parseModel(model: string): { assistantId?: string; squadId?: string } {
  const [kind, id] = model.includes(':') ? model.split(':', 2) : ['assistant', model];
  if (!UUID.test(id ?? '')) throw new ApiError('not_found', `The model "${model}" does not exist; use an assistant id, or "squad:<id>"`, { param: 'model' });
  if (kind === 'assistant') return { assistantId: id };
  if (kind === 'squad') return { squadId: id };
  throw new ApiError('not_found', `The model "${model}" does not exist; use an assistant id, or "squad:<id>"`, { param: 'model' });
}

export function registerOpenAiRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    '/v1/chat/completions',
    {
      config: { permission: 'chat:create' },
      // OpenAI clients parse this shape (including errors from the auth hook)
      errorHandler: (error: FastifyError | ApiError, request: FastifyRequest, reply: FastifyReply) => {
        if (error instanceof ApiError) {
          if (error.headers) for (const [k, v] of Object.entries(error.headers)) reply.header(k, v);
          const param = (error.details?.param as string | undefined) ?? ((error.details?.issues as { path: string }[] | undefined)?.[0]?.path ?? null);
          return reply.code(error.status).send(openAiError(error.status, error.message, error.code, param));
        }
        const status = (error as { statusCode?: number }).statusCode;
        if (status && status >= 400 && status < 500) return reply.code(status).send(openAiError(status, error.message, 'bad_request'));
        request.log.error({ err: error }, 'unhandled error');
        return reply.code(500).send(openAiError(500, `Something went wrong; quote request id ${request.id}`, 'internal_error'));
      },
    },
    async (request, reply) => {
      const org = scope(request);
      const parsed = completionSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw invalid(`${issue.path.join('.') || 'body'}: ${issue.message}`, issue.path.join('.'));
      }
      const body = parsed.data;
      if (body.tools?.length || body.functions?.length) throw invalid("Client-defined tools are not supported; the assistant's own tools run on the server", 'tools');
      if (body.n && body.n !== 1) throw invalid('Only n = 1 is supported', 'n');

      // OpenAI messages → instructions, history and the new user message
      const instructions: string[] = [];
      const history: ChatMessage[] = [];
      for (const message of body.messages) {
        const text = textOf(message.content);
        if (message.role === 'system' || message.role === 'developer') {
          if (text.trim()) instructions.push(`Additional instructions from the caller:\n${text.trim()}`);
        } else if (message.role === 'user') {
          history.push({ role: 'user', content: text });
        } else if (message.role === 'assistant' && text) {
          history.push({ role: 'assistant', content: text });
        }
        // tool/function messages from the client have no meaning here: the assistant's tools run server-side
      }
      const last = history.pop();
      if (!last || last.role !== 'user' || !last.content.trim()) throw invalid('The last message must be a user message with text', 'messages');

      const headerSession = request.headers[SESSION_HEADER];
      let sessionId: string;
      let oneShot = false;
      if (typeof headerSession === 'string' && headerSession) {
        const session = await ctx.chat.getSession(org.id, headerSession).catch(() => null);
        if (!session || session.channel !== 'openai') throw new ApiError('not_found', `Session ${headerSession} not found`, { param: SESSION_HEADER });
        sessionId = session.id;
      } else {
        const target = parseModel(body.model);
        if (target.assistantId) org.assertAssistantAllowed(target.assistantId);
        const session = await ctx.chat.createSession(org.id, { channel: 'openai', actor: org.actor, ...target, variables: body.variables ?? {} });
        sessionId = session.id;
        oneShot = true;
      }

      const id = `chatcmpl-${randomBytes(12).toString('hex')}`;
      const created = Math.floor(Date.now() / 1000);
      const turnOptions = {
        logger: request.log,
        instructions,
        history,
        model: { temperature: body.temperature ?? undefined, maxTokens: body.max_completion_tokens ?? body.max_tokens ?? undefined },
      };
      const finish = async () => {
        // Without x-octo-session-id each request is its own session
        if (oneShot) await ctx.chat.endSession(org.id, sessionId, 'completed').catch((err: unknown) => request.log.warn({ err }, 'could not end one-shot session'));
      };

      if (!body.stream) {
        const controller = new AbortController();
        const outcome = await ctx.chat.runTurn(org.id, sessionId, last.content, { ...turnOptions, signal: controller.signal });
        await finish();
        reply.header(SESSION_HEADER, sessionId);
        return {
          id,
          object: 'chat.completion',
          created,
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: outcome.reply, refusal: null }, logprobs: null, finish_reason: 'stop' }],
          usage: { prompt_tokens: outcome.usage.inputTokens, completion_tokens: outcome.usage.outputTokens, total_tokens: outcome.usage.inputTokens + outcome.usage.outputTokens },
          system_fingerprint: null,
        };
      }

      reply.raw.setHeader(SESSION_HEADER, sessionId);
      const sse = openSse(request, reply);
      const chunk = (delta: Record<string, unknown>, finishReason: string | null) => ({ id, object: 'chat.completion.chunk', created, model: body.model, system_fingerprint: null, choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }] });
      sse.send(null, chunk({ role: 'assistant', content: '' }, null));
      try {
        const outcome = await ctx.chat.runTurn(org.id, sessionId, last.content, {
          ...turnOptions,
          signal: sse.signal,
          onEvent: (event) => {
            if (event.type === 'delta') sse.send(null, chunk({ content: event.text }, null));
          },
        });
        sse.send(null, chunk({}, 'stop'));
        if (body.stream_options?.include_usage) {
          sse.send(null, { id, object: 'chat.completion.chunk', created, model: body.model, system_fingerprint: null, choices: [], usage: { prompt_tokens: outcome.usage.inputTokens, completion_tokens: outcome.usage.outputTokens, total_tokens: outcome.usage.inputTokens + outcome.usage.outputTokens } });
        }
        sse.raw('[DONE]');
      } catch (error) {
        if (!(error instanceof ApiError)) request.log.error({ err: error }, 'completion stream failed');
        const failure = error instanceof ApiError ? openAiError(error.status, error.message, error.code) : openAiError(500, `Something went wrong; quote request id ${request.id}`, 'internal_error');
        sse.send(null, failure);
      } finally {
        await finish();
        sse.close();
      }
      return reply;
    }
  );
}
