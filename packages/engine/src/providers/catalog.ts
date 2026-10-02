/**
 * Built-in providers.
 *
 * | kind        | id         | vendor key        | notes                                        |
 * |-------------|------------|-------------------|----------------------------------------------|
 * | transcriber | elevenlabs | ELEVENLABS_API_KEY| Scribe v2 Realtime                           |
 * | transcriber | deepgram   | DEEPGRAM_API_KEY  | Nova-3                                       |
 * | transcriber | custom     | org credential    | customer WebSocket endpoint                  |
 * | model       | google     | GEMINI_API_KEY    | Gemini                                       |
 * | model       | openai     | OPENAI_API_KEY    | Chat Completions                             |
 * | model       | custom     | org credential    | OpenAI-compatible endpoint                   |
 * | voice       | elevenlabs | ELEVENLABS_API_KEY|                                              |
 * | voice       | cartesia   | CARTESIA_API_KEY  | Sonic                                        |
 * | voice       | custom     | org credential    | customer HTTPS endpoint                      |
 */
import type { ThinkingLevel } from '@google/genai';
import { z } from 'zod';
import type { ResolvedKey } from '../credentials/service.ts';
import { CustomTranscriber } from './adapters/customTranscriber.ts';
import { DeepgramTranscriber } from './adapters/deepgramTranscriber.ts';
import { ElevenLabsTranscriber } from './adapters/elevenlabsTranscriber.ts';
import { GoogleModel } from './adapters/googleModel.ts';
import { OpenAiModel } from './adapters/openaiModel.ts';
import { CartesiaVoice, CustomVoice, ElevenLabsVoice } from './adapters/voices.ts';
import { checkEndpointUrl, guardedHttpClient } from './net.ts';
import { ProviderConfigError, ProviderRegistry, type BuildContext, type BuiltProvider, type ComponentConfig } from './registry.ts';
import type { ComponentKind } from './types.ts';

export class MissingCredentialError extends Error {
  constructor(
    readonly vendor: string,
    envName: string | null
  ) {
    super(`No API key for "${vendor}": add an org credential for ${vendor}${envName ? ` or set ${envName} on the platform` : ''}`);
    this.name = 'MissingCredentialError';
  }
}

const VENDOR_ENV: Record<string, string> = {
  elevenlabs: 'ELEVENLABS_API_KEY',
  deepgram: 'DEEPGRAM_API_KEY',
  google: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  cartesia: 'CARTESIA_API_KEY',
};

async function vendorKey(context: BuildContext, vendor: string): Promise<ResolvedKey> {
  const key = await context.credentials.resolveKey(context.orgId, vendor);
  if (!key) throw new MissingCredentialError(vendor, VENDOR_ENV[vendor] ?? null);
  return key;
}

function billed<K extends ComponentKind>(instance: BuiltProvider<K>['instance'], key: ResolvedKey): BuiltProvider<K> {
  return { instance, credentialSource: key.source, ...(key.credentialId ? { credentialId: key.credentialId } : {}), billing: key.source === 'platform' ? 'platform' : 'customer' };
}

/** Custom endpoints: optional org secret by id; usage is always customer-side. */
async function customSecret(config: { credentialId?: string }, context: BuildContext): Promise<{ secret?: string; credentialSource: 'org' | 'none'; credentialId?: string }> {
  if (!config.credentialId) return { credentialSource: 'none' };
  const key = await context.credentials.resolveById(context.orgId, config.credentialId, 'custom');
  return { secret: key.secret.reveal(), credentialSource: 'org', credentialId: key.credentialId };
}

// ---------------------------------------------------------------- shared field schemas

const language = z.string().min(2).max(20).optional();
const model = z.string().min(1).max(200).optional();
const keyterms = z.array(z.string().min(1).max(100)).max(50).optional();
const headers = z.record(z.string().regex(/^[A-Za-z0-9-]+$/), z.string().max(1000)).optional();
const url = z.string().url().max(2000);
const credentialId = z.string().min(1).max(100).optional();

const llmOptions = {
  model,
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(32000).optional(),
};

export function createDefaultRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();

  // ------------------------------------------------------------ transcribers
  registry.register({
    kind: 'transcriber',
    id: 'elevenlabs',
    description: 'ElevenLabs Scribe v2 Realtime',
    defaultModel: 'scribe_v2_realtime',
    schema: z.object({ provider: z.literal('elevenlabs'), model, language, keyterms }).strict(),
    async build(config, context) {
      const key = await vendorKey(context, 'elevenlabs');
      return billed(new ElevenLabsTranscriber({ apiKey: key.secret.reveal(), model: config.model, keyterms: config.keyterms as string[] | undefined }), key);
    },
  });
  registry.register({
    kind: 'transcriber',
    id: 'deepgram',
    description: 'Deepgram Nova-3 streaming',
    defaultModel: 'nova-3',
    schema: z.object({ provider: z.literal('deepgram'), model, language, keyterms, smartFormat: z.boolean().optional() }).strict(),
    async build(config, context) {
      const key = await vendorKey(context, 'deepgram');
      return billed(
        new DeepgramTranscriber({ apiKey: key.secret.reveal(), model: config.model, keyterms: config.keyterms as string[] | undefined, smartFormat: config.smartFormat as boolean | undefined }),
        key
      );
    },
  });
  registry.register({
    kind: 'transcriber',
    id: 'custom',
    description: 'Customer WebSocket speech-to-text endpoint (wss)',
    defaultModel: 'custom',
    schema: z.object({ provider: z.literal('custom'), url, model, language, credentialId, headers }).strict(),
    async build(config, context) {
      const auth = await customSecret(config as { credentialId?: string }, context);
      const instance = new CustomTranscriber({
        url: config.url as string,
        model: config.model,
        secret: auth.secret,
        headers: config.headers as Record<string, string> | undefined,
        policy: context.endpointPolicy,
      });
      return { instance, credentialSource: auth.credentialSource, ...(auth.credentialId ? { credentialId: auth.credentialId } : {}), billing: 'customer' };
    },
  });

  // ------------------------------------------------------------ models
  registry.register({
    kind: 'model',
    id: 'google',
    description: 'Google Gemini',
    defaultModel: 'gemini-3.1-flash-lite',
    schema: z.object({ provider: z.literal('google'), ...llmOptions, thinkingLevel: z.enum(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']).optional() }).strict(),
    async build(config, context) {
      const key = await vendorKey(context, 'google');
      return billed(new GoogleModel({ apiKey: key.secret.reveal(), model: config.model, thinkingLevel: config.thinkingLevel as ThinkingLevel | undefined }), key);
    },
  });
  registry.register({
    kind: 'model',
    id: 'openai',
    description: 'OpenAI Chat Completions',
    defaultModel: 'gpt-4.1-mini',
    schema: z.object({ provider: z.literal('openai'), ...llmOptions }).strict(),
    async build(config, context) {
      const key = await vendorKey(context, 'openai');
      return billed(new OpenAiModel({ apiKey: key.secret.reveal(), model: config.model ?? 'gpt-4.1-mini' }), key);
    },
  });
  registry.register({
    kind: 'model',
    id: 'custom',
    description: 'Customer OpenAI-compatible /chat/completions endpoint (https)',
    defaultModel: 'custom',
    schema: z
      .object({ provider: z.literal('custom'), url, ...llmOptions, credentialId, headers, maxTokensField: z.enum(['max_completion_tokens', 'max_tokens']).optional() })
      .strict(),
    async build(config, context) {
      const auth = await customSecret(config as { credentialId?: string }, context);
      const base = checkEndpointUrl(config.url as string, ['https'], context.endpointPolicy).toString().replace(/\/chat\/completions\/?$/, '');
      const instance = new OpenAiModel({
        provider: 'custom',
        model: config.model ?? 'custom',
        baseUrl: base,
        apiKey: auth.secret,
        headers: config.headers as Record<string, string> | undefined,
        maxTokensField: (config.maxTokensField as 'max_tokens' | undefined) ?? 'max_tokens',
        http: guardedHttpClient(context.endpointPolicy),
      });
      return { instance, credentialSource: auth.credentialSource, ...(auth.credentialId ? { credentialId: auth.credentialId } : {}), billing: 'customer' };
    },
  });

  // ------------------------------------------------------------ voices
  const voiceId = z.string().min(1).max(200).optional();
  function requireVoiceId(config: ComponentConfig, context: BuildContext, vendor: string, envName: string): string {
    const id = (config.voiceId as string | undefined) ?? context.defaults.voiceIds[vendor];
    if (!id) throw new ProviderConfigError(`voice.voiceId is required for "${vendor}" (set it on the assistant or ${envName} on the platform)`, 'voice', vendor);
    return id;
  }
  registry.register({
    kind: 'voice',
    id: 'elevenlabs',
    description: 'ElevenLabs streaming TTS',
    defaultModel: 'eleven_v3_conversational',
    schema: z
      .object({
        provider: z.literal('elevenlabs'),
        model,
        voiceId,
        stability: z.number().min(0).max(1).optional(),
        similarityBoost: z.number().min(0).max(1).optional(),
        style: z.number().min(0).max(1).optional(),
        speed: z.number().min(0.7).max(1.2).optional(),
      })
      .strict(),
    async build(config, context) {
      const key = await vendorKey(context, 'elevenlabs');
      const settings: Record<string, unknown> = {};
      if (config.stability !== undefined) settings.stability = config.stability;
      if (config.similarityBoost !== undefined) settings.similarity_boost = config.similarityBoost;
      if (config.style !== undefined) settings.style = config.style;
      if (config.speed !== undefined) settings.speed = config.speed;
      return billed(
        new ElevenLabsVoice({
          apiKey: key.secret.reveal(),
          voiceId: requireVoiceId(config, context, 'elevenlabs', 'ELEVENLABS_VOICE_ID'),
          model: config.model,
          ...(Object.keys(settings).length ? { voiceSettings: settings } : {}),
        }),
        key
      );
    },
  });
  registry.register({
    kind: 'voice',
    id: 'cartesia',
    description: 'Cartesia Sonic',
    defaultModel: 'sonic-3.6',
    schema: z.object({ provider: z.literal('cartesia'), model, voiceId, speed: z.number().min(0.6).max(1.5).optional() }).strict(),
    async build(config, context) {
      const voice = requireVoiceId(config, context, 'cartesia', 'CARTESIA_VOICE_ID');
      const key = await vendorKey(context, 'cartesia');
      return billed(new CartesiaVoice({ apiKey: key.secret.reveal(), voiceId: voice, model: config.model, speed: config.speed as number | undefined }), key);
    },
  });
  registry.register({
    kind: 'voice',
    id: 'custom',
    description: 'Customer HTTPS TTS endpoint returning raw PCM16',
    defaultModel: 'custom',
    schema: z
      .object({
        provider: z.literal('custom'),
        url,
        model,
        voiceId,
        credentialId,
        headers,
        sampleRate: z.union([z.literal(8000), z.literal(16000), z.literal(22050), z.literal(24000), z.literal(44100), z.literal(48000)]).optional(),
      })
      .strict(),
    async build(config, context) {
      const auth = await customSecret(config as { credentialId?: string }, context);
      const instance = new CustomVoice({
        url: config.url as string,
        model: config.model,
        voiceId: config.voiceId as string | undefined,
        secret: auth.secret,
        headers: config.headers as Record<string, string> | undefined,
        sampleRate: config.sampleRate as number | undefined,
        policy: context.endpointPolicy,
      });
      return { instance, credentialSource: auth.credentialSource, ...(auth.credentialId ? { credentialId: auth.credentialId } : {}), billing: 'customer' };
    },
  });

  return registry;
}

/** Registry used by parseAssistantConfig when none is given. */
export const defaultRegistry = createDefaultRegistry();
