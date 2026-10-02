/**
 * OpenAI Chat Completions streaming (SSE) with tool calling and token usage.
 *
 * Also used for "custom" models: any OpenAI-compatible `/chat/completions` endpoint the customer
 * runs (their own server, a proxy, vLLM, ...). Custom endpoints go through the guarded HTTP
 * client (https only, no private addresses).
 */
import { randomUUID } from 'node:crypto';
import { fetchHttpClient, sseData, type HttpClient } from '../net.ts';
import { ProviderError, type LanguageModel, type LlmEvent, type LlmRequest, type ProviderContext } from '../types.ts';

export interface OpenAiModelOptions {
  /** Bearer token; optional for custom endpoints without auth. */
  apiKey?: string;
  model: string;
  /** Default https://api.openai.com/v1; for custom endpoints the URL up to (not including) /chat/completions. */
  baseUrl?: string;
  /** Registry id recorded for billing: "openai" or "custom". */
  provider?: 'openai' | 'custom';
  /** OpenAI uses max_completion_tokens; many compatible servers only know max_tokens. */
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';
  headers?: Record<string, string>;
  http?: HttpClient;
}

type OpenAiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export function toOpenAiMessages(request: LlmRequest): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [];
  if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt });
  for (const m of request.messages) {
    if (m.role === 'user') messages.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls?.length
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.args) } })) }
          : {}),
      });
    } else messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
  }
  return messages;
}

interface ChunkToolCall {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface Chunk {
  choices?: { delta?: { content?: string | null; tool_calls?: ChunkToolCall[] }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string };
}

export class OpenAiModel implements LanguageModel {
  readonly provider: 'openai' | 'custom';
  readonly model: string;
  private readonly http: HttpClient;

  constructor(private readonly options: OpenAiModelOptions) {
    this.provider = options.provider ?? 'openai';
    this.model = options.model;
    if (this.provider === 'openai' && !options.apiKey) throw new Error('OpenAI model needs an API key');
    this.http = options.http ?? fetchHttpClient;
  }

  async *stream(request: LlmRequest, context: ProviderContext & { signal: AbortSignal }): AsyncGenerator<LlmEvent> {
    const base = (this.options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
    const body = {
      model: this.model,
      messages: toOpenAiMessages(request),
      stream: true,
      stream_options: { include_usage: true },
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { [this.options.maxTokensField ?? 'max_completion_tokens']: request.maxTokens } : {}),
      ...(request.tools.length > 0
        ? { tools: request.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }
        : {}),
    };
    let response;
    try {
      response = await this.http(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...this.options.headers,
          ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: context.signal,
      });
    } catch (error) {
      if (context.signal.aborted) throw error;
      const blocked = (error as Error).name === 'EndpointNotAllowedError' || (error as NodeJS.ErrnoException).code === 'EENDPOINTBLOCKED';
      throw new ProviderError(`${this.provider} LLM request failed: ${(error as Error).message}`, 'llm', this.provider, { retryable: !blocked, cause: error });
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const status = response.status;
      throw new ProviderError(`${this.provider} ${this.model} failed (${status}): ${detail.slice(0, 300)}`, 'llm', this.provider, {
        retryable: status >= 500 || status === 429 || status === 408,
        code: String(status),
      });
    }

    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    const flushTools = function* (): Generator<LlmEvent> {
      for (const call of [...toolCalls.values()]) {
        let args: Record<string, unknown> = {};
        try {
          args = call.args ? JSON.parse(call.args) : {};
        } catch {
          context.logger.warn({ provider: 'openai', tool: call.name }, 'tool call arguments were not valid JSON');
        }
        yield { type: 'tool-call', id: call.id, name: call.name, args };
      }
      toolCalls.clear();
    };

    for await (const data of sseData(response.body)) {
      if (data === '[DONE]') break;
      let chunk: Chunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      if (chunk.error) throw new ProviderError(`${this.provider} stream error: ${chunk.error.message ?? 'unknown'}`, 'llm', this.provider);
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta?.content) yield { type: 'text', text: delta.content };
      for (const part of delta?.tool_calls ?? []) {
        const current = toolCalls.get(part.index) ?? { id: part.id ?? randomUUID(), name: '', args: '' };
        if (part.id) current.id = part.id;
        if (part.function?.name) current.name += part.function.name;
        if (part.function?.arguments) current.args += part.function.arguments;
        toolCalls.set(part.index, current);
      }
      if (choice?.finish_reason) yield* flushTools();
      if (chunk.usage) yield { type: 'usage', inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
    }
    yield* flushTools();
  }
}
