/**
 * Per-assistant call configuration. This is the voice-engine slice of the future versioned
 * assistant config (ARCHITECTURE section 4.2); Phase 4 stores it in `assistant_version`.
 */
import { z } from 'zod';
import { defaultRegistry } from '../providers/catalog.ts';
import { mergeComponent, PRESETS, type PresetName } from '../providers/presets.ts';
import type { ComponentConfig, ProviderRegistry } from '../providers/registry.ts';
import type { ComponentKind } from '../providers/types.ts';

/** Keys of a component that are engine policy, not provider fields. */
const POLICY_KEYS = new Set(['fallbacks', 'retries', 'connectTimeoutMs', 'firstTokenTimeoutMs', 'firstByteTimeoutMs', 'idleTimeoutMs']);

function componentSchema<P extends z.ZodRawShape>(policy: P) {
  return z
    .object({
      provider: z.string().min(1),
      /** Attempts per provider after the first, when it failed before producing output. */
      retries: z.number().int().min(0).max(2).default(1),
      /** Tried in order when the provider above fails (after its retries). */
      fallbacks: z.array(z.object({ provider: z.string().min(1) }).passthrough()).max(3).default([]),
      ...policy,
    })
    .passthrough();
}

/** Provider fields of a component (what the registry validates and builds from). */
export function providerFields(component: Record<string, unknown>): ComponentConfig {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(component)) if (!POLICY_KEYS.has(key)) fields[key] = value;
  return fields as ComponentConfig;
}

export const transferDestinationSchema = z.object({
  /** Name the LLM uses to pick this destination. */
  name: z.string().min(1),
  /** Phone number (E.164) or SIP URI; interpreted by the telephony transport. */
  target: z.string().min(1),
  description: z.string().optional(),
  /** Spoken before transferring. */
  message: z.string().optional(),
});

export const assistantConfigSchema = z.object({
  name: z.string().min(1).default('Assistant'),
  /** BCP-47 / ISO 639-1 language code, e.g. "bn", "en". Drives STT, TTS and sentence splitting. */
  language: z.string().min(2).default('en'),
  systemPrompt: z.string().default('You are a helpful voice assistant. Keep answers short and conversational.'),

  firstMessage: z
    .object({
      mode: z.enum(['assistant-speaks-first', 'wait-for-user']).default('assistant-speaks-first'),
      text: z.string().default('Hello! How can I help you today?'),
    })
    .default({}),

  endpointing: z
    .object({
      /** Silence after the user stops talking before the turn ends. */
      silenceMs: z.number().int().min(100).max(5000).default(600),
      /** Speech needed to open a user turn. */
      minSpeechMs: z.number().int().min(20).max(2000).default(120),
      /** Speech must be this far above the noise floor (dB). */
      vadMarginDb: z.number().min(3).max(40).default(12),
      /** Never treat audio quieter than this (dBFS) as speech. */
      vadMinSpeechDb: z.number().min(-90).max(-10).default(-50),
      /** Wait this long for the STT final transcript after the endpoint. */
      sttFinalTimeoutMs: z.number().int().min(100).max(10000).default(1500),
    })
    .default({}),

  interruption: z
    .object({
      enabled: z.boolean().default(true),
      /** Speech needed while the agent talks before it stops (keep low: stop must happen in ~200 ms). */
      minSpeechMs: z.number().int().min(20).max(2000).default(140),
      /** Extra dB above the noise floor needed while the agent talks, against echo. */
      echoGuardDb: z.number().min(0).max(40).default(6),
    })
    .default({}),

  idle: z
    .object({
      /** Silence (no user speech) before a reminder; 0 disables idle handling. */
      timeoutMs: z.number().int().min(0).default(10000),
      message: z.string().default('Are you still there?'),
      /** Reminders before the call ends with silence-timeout. */
      maxPrompts: z.number().int().min(0).default(2),
      /** Spoken before ending on silence; empty = hang up quietly. */
      endMessage: z.string().default(''),
    })
    .default({}),

  /**
   * The call ends (assistant-ended) after the assistant finishes saying a reply that contains one
   * of these phrases. Matching ignores case, punctuation and extra spaces.
   */
  endCallPhrases: z.array(z.string().trim().min(1).max(200)).max(20).default([]),

  /** Hard limit on call length; 0 disables. */
  maxDurationMs: z.number().int().min(0).default(10 * 60 * 1000),
  /** Spoken when the max duration is reached; empty = hang up quietly. */
  maxDurationMessage: z.string().default(''),

  /** What to do when a provider fails after its retry. */
  fallback: z
    .object({
      message: z.string().default("Sorry, I'm having technical difficulties. Please call again later."),
      action: z.enum(['end', 'transfer']).default('end'),
      /** Destination name from `tools.transferCall.destinations` when action is "transfer". */
      transferTo: z.string().optional(),
      /** Synthesize the fallback message at call start, so it can play even if TTS later fails. */
      prefetchAudio: z.boolean().default(true),
    })
    .default({}),

  tools: z
    .object({
      endCall: z
        .object({
          enabled: z.boolean().default(true),
          /** Spoken if the model ends the call without saying anything. */
          message: z.string().default(''),
        })
        .default({}),
      transferCall: z
        .object({
          enabled: z.boolean().default(false),
          destinations: z.array(transferDestinationSchema).default([]),
        })
        .default({}),
    })
    .default({}),

  /** Provider preset: "fast", "balanced" or "quality". Components below override it. */
  preset: z.enum(['fast', 'balanced', 'quality']).default('balanced'),
  /** Speech-to-text: provider fields (validated by the provider registry) plus policy and fallbacks. */
  transcriber: componentSchema({ connectTimeoutMs: z.number().int().positive().max(30000).default(5000) }),
  /** LLM: provider fields (model, temperature, maxTokens, ...) plus policy and fallbacks. */
  model: componentSchema({
    firstTokenTimeoutMs: z.number().int().positive().max(60000).default(5000),
    idleTimeoutMs: z.number().int().positive().max(60000).default(10000),
  }),
  /** Text-to-speech: provider fields (voiceId, model, ...) plus policy and fallbacks. */
  voice: componentSchema({
    firstByteTimeoutMs: z.number().int().positive().max(60000).default(5000),
    idleTimeoutMs: z.number().int().positive().max(60000).default(10000),
  }),
});

export type AssistantConfig = z.infer<typeof assistantConfigSchema>;
/** Component as written by a user: any provider fields, policy and fallbacks; all optional (the preset fills gaps). */
export type ComponentInput = { provider?: string; fallbacks?: ({ provider: string } & Record<string, unknown>)[] } & Record<string, unknown>;
export type AssistantConfigInput = Omit<z.input<typeof assistantConfigSchema>, 'transcriber' | 'model' | 'voice'> & {
  transcriber?: ComponentInput;
  model?: ComponentInput;
  voice?: ComponentInput;
};
export type TransferDestination = z.infer<typeof transferDestinationSchema>;

/**
 * Validate an assistant config: apply the preset, merge component overrides, fill defaults, and
 * validate every provider (and fallback) against the registry. Throws with a readable message.
 */
export function parseAssistantConfig(input: AssistantConfigInput, registry: ProviderRegistry = defaultRegistry): AssistantConfig {
  const presetName: PresetName = (input.preset as PresetName | undefined) ?? 'balanced';
  const preset = PRESETS[presetName];
  if (!preset) throw new Error(`Unknown preset "${String(input.preset)}". Available: ${Object.keys(PRESETS).join(', ')}`);
  const raw = input as Record<string, unknown>;
  const config = assistantConfigSchema.parse({
    ...input,
    endpointing: { silenceMs: preset.silenceMs, ...(input.endpointing ?? {}) },
    transcriber: mergeComponent(preset.transcriber, raw.transcriber as Record<string, unknown> | undefined),
    model: mergeComponent(preset.model, raw.model as Record<string, unknown> | undefined),
    voice: mergeComponent(preset.voice, raw.voice as Record<string, unknown> | undefined),
  });
  for (const kind of ['transcriber', 'model', 'voice'] as const satisfies readonly ComponentKind[]) {
    const component = config[kind];
    registry.validate(kind, providerFields(component), kind);
    component.fallbacks.forEach((fallback, i) => registry.validate(kind, providerFields(fallback), `${kind}.fallbacks[${i}]`));
  }
  const names = new Set(config.tools.transferCall.destinations.map((d) => d.name));
  if (config.fallback.action === 'transfer') {
    if (!config.fallback.transferTo || !names.has(config.fallback.transferTo)) {
      throw new Error('fallback.transferTo must name one of tools.transferCall.destinations when fallback.action is "transfer"');
    }
  }
  return config;
}
