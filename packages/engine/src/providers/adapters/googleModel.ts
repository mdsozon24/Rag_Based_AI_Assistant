/**
 * Google Gemini streaming LLM (generateContentStream) with function calling and token usage.
 */
import { randomUUID } from 'node:crypto';
import { GoogleGenAI, type Content, type GenerateContentConfig, type GenerateContentResponse, type Part, type ThinkingLevel } from '@google/genai';
import { ProviderError, type LanguageModel, type LlmEvent, type LlmRequest, type ProviderContext } from '../types.ts';

/** The subset of the @google/genai client this adapter uses (lets tests inject a fake). */
export interface GeminiClientLike {
  models: {
    generateContentStream(params: { model: string; contents: Content[]; config?: GenerateContentConfig }): Promise<AsyncIterable<GenerateContentResponse>>;
  };
}

export interface GoogleModelOptions {
  apiKey?: string;
  model?: string;
  /** e.g. MINIMAL for lower latency on models that think by default; unset = model default. */
  thinkingLevel?: ThinkingLevel;
  client?: GeminiClientLike;
}

/** Gemini wants alternating user/model turns starting with the user. */
export function toGeminiContents(request: LlmRequest): Content[] {
  const contents: Content[] = [];
  const push = (role: 'user' | 'model', part: Part) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts!.push(part);
    else contents.push({ role, parts: [part] });
  };
  for (const message of request.messages) {
    if (message.role === 'user') {
      push('user', { text: message.content });
    } else if (message.role === 'assistant') {
      if (message.content) push('model', { text: message.content });
      for (const call of message.toolCalls ?? []) push('model', { functionCall: { id: call.id, name: call.name, args: call.args } });
    } else {
      push('user', { functionResponse: { id: message.toolCallId, name: message.name, response: { result: message.content } } });
    }
  }
  if (contents[0]?.role === 'model') contents.unshift({ role: 'user', parts: [{ text: '(The call has connected.)' }] });
  return contents;
}

export class GoogleModel implements LanguageModel {
  readonly provider = 'google';
  readonly model: string;
  private readonly client: GeminiClientLike;

  constructor(private readonly options: GoogleModelOptions) {
    this.model = options.model ?? 'gemini-3.1-flash-lite';
    if (options.client) {
      this.client = options.client;
    } else {
      if (!options.apiKey) throw new Error('Google model needs an API key');
      this.client = new GoogleGenAI({ apiKey: options.apiKey });
    }
  }

  async *stream(request: LlmRequest, context: ProviderContext & { signal: AbortSignal }): AsyncGenerator<LlmEvent> {
    const config: GenerateContentConfig = {
      systemInstruction: request.systemPrompt,
      abortSignal: context.signal,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
      ...(this.options.thinkingLevel ? { thinkingConfig: { thinkingLevel: this.options.thinkingLevel } } : {}),
      ...(request.tools.length > 0
        ? { tools: [{ functionDeclarations: request.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }] }
        : {}),
    };
    let stream: AsyncIterable<GenerateContentResponse>;
    try {
      stream = await this.client.models.generateContentStream({ model: this.model, contents: toGeminiContents(request), config });
    } catch (error) {
      throw wrap(error, this.model);
    }
    let usage: { inputTokens: number; outputTokens: number } | null = null;
    try {
      for await (const chunk of stream) {
        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          if (part.thought) continue;
          if (part.text) yield { type: 'text', text: part.text };
          if (part.functionCall?.name) {
            yield { type: 'tool-call', id: part.functionCall.id ?? randomUUID(), name: part.functionCall.name, args: (part.functionCall.args as Record<string, unknown>) ?? {} };
          }
        }
        const meta = chunk.usageMetadata;
        if (meta?.promptTokenCount !== undefined) {
          usage = { inputTokens: meta.promptTokenCount ?? 0, outputTokens: (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0) };
        }
      }
    } catch (error) {
      throw wrap(error, this.model);
    }
    if (usage) yield { type: 'usage', ...usage };
  }
}

function wrap(error: unknown, model: string): unknown {
  if (error instanceof Error && error.name === 'AbortError') return error;
  const message = error instanceof Error ? error.message : String(error);
  const status = (error as { status?: number })?.status;
  const fatal = status === 400 || status === 401 || status === 403 || /api key not valid|permission|billing/i.test(message);
  return new ProviderError(`Gemini ${model}: ${message}`, 'llm', 'google', { retryable: !fatal, code: status ? String(status) : undefined, cause: error });
}
