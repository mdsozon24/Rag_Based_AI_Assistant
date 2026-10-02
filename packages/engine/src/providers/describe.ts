/**
 * The provider catalog as data, for pickers and docs (GET /v1/providers): every registered provider
 * with the fields its strict schema accepts, the engine policy fields each component takes (retries,
 * timeouts, fallbacks), the presets, and the credential vendors.
 *
 * Everything is derived from the registry and the zod schemas themselves, so the catalog cannot
 * drift from what assistant validation accepts. Model names are suggestions only (the default and
 * the ones the presets use); providers accept any model string.
 */
import { z } from 'zod';
import { CREDENTIAL_VENDORS } from '../credentials/service.ts';
import { assistantConfigSchema } from '../engine/config.ts';
import { PRESET_NAMES, PRESETS, type PresetComponent } from './presets.ts';
import type { ProviderRegistry } from './registry.ts';
import type { ComponentKind } from './types.ts';

export const COMPONENT_KINDS: readonly ComponentKind[] = ['transcriber', 'model', 'voice'];

export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'enum' | 'string-list' | 'map' | 'object-list';

export interface FieldDescriptor {
  name: string;
  type: FieldType;
  required: boolean;
  /** Allowed values (type "enum"). */
  values?: (string | number)[];
  /** Numbers: smallest and largest value. Strings: shortest and longest length. */
  min?: number;
  max?: number;
  /** Decimals only: the bound itself is not allowed (positive() is min 0, exclusive). */
  exclusiveMin?: boolean;
  exclusiveMax?: boolean;
  /** Lists: most items. */
  maxItems?: number;
  /** Strings that must be URLs. */
  format?: 'url';
  default?: unknown;
}

export interface ProviderDescriptor {
  id: string;
  description: string;
  defaultModel: string;
  /** Models seen in the presets (the default first). Any model string is accepted. */
  suggestedModels: string[];
  /** The `provider` name of an org credential (POST /v1/credentials) this provider uses. */
  credentialVendor: string;
  fields: FieldDescriptor[];
}

export interface ComponentCatalog {
  providers: ProviderDescriptor[];
  /** Engine policy fields of the component, whatever the provider: retries, timeouts, fallbacks. */
  policy: FieldDescriptor[];
}

export interface PresetDescriptor {
  name: string;
  description: string;
  default: boolean;
  /** Milliseconds of silence that end the caller's turn, unless the assistant sets endpointing.silenceMs. */
  silenceMs: number;
  transcriber: PresetComponent;
  model: PresetComponent;
  voice: PresetComponent;
}

export interface ProviderCatalog {
  components: Record<ComponentKind, ComponentCatalog>;
  presets: PresetDescriptor[];
  credentialVendors: string[];
}

/** Unwrap optional/default/effects, keeping whether a value is required and its default. */
function unwrap(schema: z.ZodTypeAny): { inner: z.ZodTypeAny; required: boolean; default?: unknown } {
  let inner = schema;
  let required = true;
  let fallback: unknown;
  for (;;) {
    if (inner instanceof z.ZodOptional || inner instanceof z.ZodNullable) {
      required = false;
      inner = inner._def.innerType;
    } else if (inner instanceof z.ZodDefault) {
      required = false;
      fallback = inner._def.defaultValue();
      inner = inner._def.innerType;
    } else if (inner instanceof z.ZodEffects) {
      inner = inner._def.schema;
    } else {
      break;
    }
  }
  return { inner, required, ...(fallback !== undefined ? { default: fallback } : {}) };
}

type Check = { kind: string; value?: number; inclusive?: boolean };
type Range = Pick<FieldDescriptor, 'min' | 'max' | 'exclusiveMin' | 'exclusiveMax'>;

/** Bounds as inclusive values; an exclusive bound on an integer moves by one, on a decimal it is flagged. */
function rangeOf(checks: Check[], integer = false): Range {
  const range: Range = {};
  for (const check of checks) {
    if ((check.kind !== 'min' && check.kind !== 'max') || check.value === undefined) continue;
    const min = check.kind === 'min';
    const exclusive = check.inclusive === false;
    const value = exclusive && integer ? check.value + (min ? 1 : -1) : check.value;
    if (min) range.min = value;
    else range.max = value;
    if (exclusive && !integer) range[min ? 'exclusiveMin' : 'exclusiveMax'] = true;
  }
  return range;
}

/** One field of a provider or policy schema, or null for what a picker cannot offer (the provider literal). */
export function describeField(name: string, schema: z.ZodTypeAny): FieldDescriptor | null {
  const { inner, required, default: fallback } = unwrap(schema);
  const base = { name, required, ...(fallback !== undefined ? { default: fallback } : {}) };
  if (inner instanceof z.ZodString) {
    const checks = inner._def.checks as Check[];
    return { ...base, type: 'string', ...rangeOf(checks), ...(checks.some((c) => c.kind === 'url') ? { format: 'url' as const } : {}) };
  }
  if (inner instanceof z.ZodNumber) {
    const checks = inner._def.checks as Check[];
    const integer = checks.some((c) => c.kind === 'int');
    return { ...base, type: integer ? 'integer' : 'number', ...rangeOf(checks, integer) };
  }
  if (inner instanceof z.ZodBoolean) return { ...base, type: 'boolean' };
  if (inner instanceof z.ZodEnum) return { ...base, type: 'enum', values: [...(inner._def.values as string[])] };
  if (inner instanceof z.ZodUnion) {
    const options = inner._def.options as z.ZodTypeAny[];
    if (options.every((o) => o instanceof z.ZodLiteral)) return { ...base, type: 'enum', values: options.map((o) => o._def.value as string | number) };
  }
  if (inner instanceof z.ZodLiteral) return null;
  if (inner instanceof z.ZodArray) {
    const element = unwrap(inner._def.type).inner;
    const maxItems = (inner._def.maxLength as { value: number } | null)?.value;
    return { ...base, type: element instanceof z.ZodString ? 'string-list' : 'object-list', ...(maxItems !== undefined ? { maxItems } : {}) };
  }
  if (inner instanceof z.ZodRecord) return { ...base, type: 'map' };
  throw new Error(`Cannot describe field "${name}" (${inner._def.typeName})`);
}

function describeObject(schema: z.ZodTypeAny, skip: string[] = []): FieldDescriptor[] {
  const { inner } = unwrap(schema);
  if (!(inner instanceof z.ZodObject)) throw new Error('Expected an object schema');
  return Object.entries(inner.shape as Record<string, z.ZodTypeAny>)
    .filter(([name]) => !skip.includes(name))
    .map(([name, field]) => describeField(name, field))
    .filter((f): f is FieldDescriptor => f !== null);
}

/** Models a preset uses for this provider, primary or fallback. */
function presetModels(kind: ComponentKind, provider: string): string[] {
  const models: string[] = [];
  for (const name of PRESET_NAMES) {
    const component = PRESETS[name][kind];
    for (const entry of [component, ...(component.fallbacks ?? [])]) {
      if (entry.provider === provider && typeof entry.model === 'string') models.push(entry.model);
    }
  }
  return models;
}

export function describeProviders(registry: ProviderRegistry): ProviderCatalog {
  const components = {} as Record<ComponentKind, ComponentCatalog>;
  for (const kind of COMPONENT_KINDS) {
    const providers = registry.ids(kind).map((id): ProviderDescriptor => {
      const spec = registry.spec(kind, id);
      return {
        id,
        description: spec.description,
        defaultModel: spec.defaultModel,
        suggestedModels: [...new Set([spec.defaultModel, ...presetModels(kind, id)])].filter((m) => m !== 'custom'),
        credentialVendor: id,
        fields: describeObject(spec.schema, ['provider']),
      };
    });
    components[kind] = { providers, policy: describeObject(assistantConfigSchema.shape[kind], ['provider']) };
  }
  return {
    components,
    presets: PRESET_NAMES.map((name) => ({ name, description: PRESETS[name].description, default: name === 'balanced', silenceMs: PRESETS[name].silenceMs, transcriber: PRESETS[name].transcriber, model: PRESETS[name].model, voice: PRESETS[name].voice })),
    credentialVendors: [...CREDENTIAL_VENDORS],
  };
}
