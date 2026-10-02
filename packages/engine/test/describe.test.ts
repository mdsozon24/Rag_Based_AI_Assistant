import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDefaultRegistry } from '../src/providers/catalog.ts';
import { describeField, describeProviders, type FieldDescriptor } from '../src/providers/describe.ts';
import { PRESET_NAMES } from '../src/providers/presets.ts';

/** A value the descriptor says is valid: the smallest allowed, or a plain sample. */
function sample(field: FieldDescriptor): unknown {
  switch (field.type) {
    case 'string':
      return field.format === 'url' ? 'https://example.com/endpoint' : 'x'.repeat(Math.max(1, field.min ?? 1));
    case 'number':
    case 'integer':
      return field.min ?? 1;
    case 'boolean':
      return true;
    case 'enum':
      return field.values![0];
    case 'string-list':
      return ['term'];
    case 'map':
      return { 'X-Test': 'yes' };
    case 'object-list':
      return [];
  }
}

describe('provider catalog', () => {
  const registry = createDefaultRegistry();
  const catalog = describeProviders(registry);

  it('lists every registered provider per component', () => {
    for (const kind of ['transcriber', 'model', 'voice'] as const) {
      expect(catalog.components[kind].providers.map((p) => p.id).sort()).toEqual(registry.ids(kind).sort());
    }
    expect(catalog.presets.map((p) => p.name)).toEqual([...PRESET_NAMES]);
    expect(catalog.presets.filter((p) => p.default).map((p) => p.name)).toEqual(['balanced']);
    expect(catalog.credentialVendors).toEqual(expect.arrayContaining(['elevenlabs', 'deepgram', 'google', 'openai', 'cartesia', 'custom']));
  });

  it('describes fields exactly as the provider schemas accept them', () => {
    // Every field set to a value its descriptor allows passes the provider's own validation
    for (const kind of ['transcriber', 'model', 'voice'] as const) {
      for (const provider of catalog.components[kind].providers) {
        const config = Object.fromEntries(provider.fields.map((f) => [f.name, sample(f)]));
        expect(() => registry.validate(kind, { provider: provider.id, ...config }), `${kind}:${provider.id}`).not.toThrow();
        // And the fields are all of them: an unlisted one is refused
        expect(() => registry.validate(kind, { provider: provider.id, ...config, notAField: 1 })).toThrow(/unknown field/);
      }
    }
  });

  it('gives ranges, enums and suggested models for the pickers', () => {
    const voice = catalog.components.voice.providers.find((p) => p.id === 'elevenlabs')!;
    expect(voice.fields.find((f) => f.name === 'speed')).toEqual({ name: 'speed', type: 'number', required: false, min: 0.7, max: 1.2 });
    expect(voice.suggestedModels).toEqual(['eleven_v3_conversational', 'eleven_v3']);
    const google = catalog.components.model.providers.find((p) => p.id === 'google')!;
    expect(google.fields.find((f) => f.name === 'thinkingLevel')).toMatchObject({ type: 'enum', values: ['MINIMAL', 'LOW', 'MEDIUM', 'HIGH'] });
    expect(google.suggestedModels[0]).toBe('gemini-3.1-flash-lite');
    const custom = catalog.components.model.providers.find((p) => p.id === 'custom')!;
    expect(custom.fields.find((f) => f.name === 'url')).toMatchObject({ type: 'string', required: true, format: 'url' });
    expect(custom.suggestedModels).toEqual([]);
    expect(catalog.components.model.policy.find((f) => f.name === 'retries')).toEqual({ name: 'retries', type: 'integer', required: false, default: 1, min: 0, max: 2 });
    expect(catalog.components.voice.policy.map((f) => f.name)).toEqual(['retries', 'fallbacks', 'firstByteTimeoutMs', 'idleTimeoutMs']);
  });

  it('describes the zod shapes it supports and refuses the ones it does not', () => {
    expect(describeField('sampleRate', z.union([z.literal(8000), z.literal(16000)]).optional())).toEqual({ name: 'sampleRate', type: 'enum', required: false, values: [8000, 16000] });
    expect(describeField('timeout', z.number().int().positive().max(5))).toEqual({ name: 'timeout', type: 'integer', required: true, min: 1, max: 5 });
    expect(describeField('ratio', z.number().positive().lt(1))).toEqual({ name: 'ratio', type: 'number', required: true, min: 0, exclusiveMin: true, max: 1, exclusiveMax: true });
    expect(describeField('provider', z.literal('x'))).toBeNull();
    expect(() => describeField('when', z.date())).toThrow(/Cannot describe/);
  });
});
