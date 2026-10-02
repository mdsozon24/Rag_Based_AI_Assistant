/**
 * Named provider combinations. An assistant picks one with `preset` (default "balanced") and may
 * override any component (see mergeComponent). Fallbacks whose credentials are missing are
 * skipped at call start with a warning, so presets work with whatever keys the platform has.
 *
 * All providers here support Bangla ("bn") per vendor docs as of 2026-10-01.
 */
import type { ComponentConfig } from './registry.ts';

export type PresetName = 'fast' | 'balanced' | 'quality';
export const PRESET_NAMES: readonly PresetName[] = ['fast', 'balanced', 'quality'];

export interface PresetComponent extends ComponentConfig {
  fallbacks?: ComponentConfig[];
}

export interface Preset {
  description: string;
  transcriber: PresetComponent;
  model: PresetComponent;
  voice: PresetComponent;
  /** Turn-taking default for the preset (the assistant's own value wins). */
  silenceMs: number;
}

export const PRESETS: Record<PresetName, Preset> = {
  fast: {
    description: 'Lowest latency: Deepgram Nova-3, GPT-4.1 mini, Cartesia Sonic, shorter end-of-turn silence',
    transcriber: { provider: 'deepgram', model: 'nova-3', fallbacks: [{ provider: 'elevenlabs', model: 'scribe_v2_realtime' }] },
    model: { provider: 'openai', model: 'gpt-4.1-mini', fallbacks: [{ provider: 'google', model: 'gemini-3.1-flash-lite' }] },
    voice: { provider: 'cartesia', model: 'sonic-3.6', fallbacks: [{ provider: 'elevenlabs', model: 'eleven_v3_conversational' }] },
    silenceMs: 400,
  },
  balanced: {
    description: 'Default, and the stack measured in production tests: ElevenLabs Scribe, Gemini Flash-Lite, ElevenLabs v3 conversational',
    transcriber: { provider: 'elevenlabs', model: 'scribe_v2_realtime', fallbacks: [{ provider: 'deepgram', model: 'nova-3' }] },
    model: { provider: 'google', model: 'gemini-3.1-flash-lite', fallbacks: [{ provider: 'openai', model: 'gpt-4.1-mini' }] },
    voice: { provider: 'elevenlabs', model: 'eleven_v3_conversational', fallbacks: [{ provider: 'cartesia', model: 'sonic-3.6' }] },
    silenceMs: 600,
  },
  quality: {
    description: 'Best answers and most expressive voice, slower: GPT-4.1, ElevenLabs v3, longer end-of-turn silence',
    transcriber: { provider: 'elevenlabs', model: 'scribe_v2_realtime', fallbacks: [{ provider: 'deepgram', model: 'nova-3' }] },
    model: { provider: 'openai', model: 'gpt-4.1', fallbacks: [{ provider: 'google', model: 'gemini-3.8-flash' }] },
    voice: { provider: 'elevenlabs', model: 'eleven_v3', fallbacks: [{ provider: 'cartesia', model: 'sonic-3.6' }] },
    silenceMs: 800,
  },
};

/**
 * Apply an assistant's component override to the preset component:
 * - no override: the preset component;
 * - same provider (or no provider given): fields merged over the preset; `fallbacks` replaced only if given;
 * - different provider: the override replaces the preset component, including its fallbacks.
 */
export function mergeComponent(preset: PresetComponent, override: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!override) return structuredClone(preset);
  if (override.provider !== undefined && override.provider !== preset.provider) return { fallbacks: [], ...structuredClone(override) };
  return { ...structuredClone(preset), ...structuredClone(override), provider: preset.provider };
}
