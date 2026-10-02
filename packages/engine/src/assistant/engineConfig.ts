/**
 * Assistant spec → engine config. The only place that knows how API fields map onto the voice
 * engine, and where call-time defaults come from (the engine's schema defaults, plus the
 * ones below).
 *
 * Fields the engine does not use yet (stored for later phases): toolIds, knowledgeBaseIds,
 * voicemailMessage, backgroundSound, serverUrl, analysis.
 */
import { parseAssistantConfig, type AssistantConfig, type AssistantConfigInput, type ComponentInput } from '../engine/config.ts';
import { defaultRegistry } from '../providers/catalog.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import type { AssistantSpec } from './spec.ts';
import { renderFields } from './variables.ts';

/** Defaults that differ from the engine's own (e.g. no English greeting is ever invented). */
export const SPEC_DEFAULTS = {
  firstMessage: '',
  firstMessageMode: 'assistant-speaks-first',
  language: 'en',
  preset: 'balanced',
  maxDurationSeconds: 600,
} as const;

export interface EngineInputOptions {
  name: string;
  /** Rendered texts (variables filled); the spec's raw texts are used when omitted. */
  firstMessage?: string;
  systemPrompt?: string;
}

export function toEngineInput(spec: AssistantSpec, options: EngineInputOptions): AssistantConfigInput {
  const input: AssistantConfigInput = {
    name: options.name,
    language: spec.language ?? SPEC_DEFAULTS.language,
    preset: spec.preset ?? SPEC_DEFAULTS.preset,
    firstMessage: {
      mode: (spec.firstMessageMode ?? SPEC_DEFAULTS.firstMessageMode) === 'assistant-waits-for-user' ? 'wait-for-user' : 'assistant-speaks-first',
      text: options.firstMessage ?? spec.firstMessage ?? SPEC_DEFAULTS.firstMessage,
    },
    maxDurationMs: (spec.maxDurationSeconds ?? SPEC_DEFAULTS.maxDurationSeconds) * 1000,
    endCallPhrases: spec.endCallPhrases ?? [],
  };
  const systemPrompt = options.systemPrompt ?? spec.systemPrompt;
  if (systemPrompt?.trim()) input.systemPrompt = systemPrompt;
  if (spec.maxDurationMessage !== undefined) input.maxDurationMessage = spec.maxDurationMessage;
  if (spec.fallbackMessage !== undefined) input.fallback = { message: spec.fallbackMessage };
  if (spec.endpointing) input.endpointing = { ...spec.endpointing };
  if (spec.interruption) input.interruption = { ...spec.interruption };
  if (spec.idle) {
    const { timeoutSeconds, ...rest } = spec.idle;
    input.idle = { ...rest, ...(timeoutSeconds !== undefined ? { timeoutMs: Math.round(timeoutSeconds * 1000) } : {}) };
  }
  for (const kind of ['transcriber', 'model', 'voice'] as const) {
    if (spec[kind]) input[kind] = structuredClone(spec[kind]) as ComponentInput;
  }
  return input;
}

export interface CallConfigInput {
  spec: AssistantSpec;
  name: string;
  callId: string;
  startedAt: Date;
  /** The call's variableValues. */
  variables?: Readonly<Record<string, string>>;
}

/**
 * The engine config for one call: variables rendered, defaults applied, providers validated.
 * Throws MissingVariablesError when a placeholder has no value.
 */
export function buildCallConfig(input: CallConfigInput, registry: ProviderRegistry = defaultRegistry): AssistantConfig {
  const rendered = renderFields({
    fields: { firstMessage: input.spec.firstMessage, systemPrompt: input.spec.systemPrompt },
    values: input.variables,
    defaults: input.spec.variableDefaults,
    callId: input.callId,
    startedAt: input.startedAt,
  });
  return parseAssistantConfig(toEngineInput(input.spec, { name: input.name, ...rendered }), registry);
}
