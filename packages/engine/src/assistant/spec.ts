/**
 * The assistant config as customers write it (API, dashboard, templates): the versioned part of an
 * assistant. Stored as written (only the fields the customer set); defaults are applied when a call
 * starts (see engineConfig.ts), so they are documented in one place and presets can evolve.
 *
 * validateAssistantSpec returns field-level issues ({path, message}) for everything: unknown
 * fields, ranges, placeholders, and provider fields checked by the provider registry.
 */
import { z } from 'zod';
import { defaultRegistry } from '../providers/catalog.ts';
import { checkEndpointUrl, type EndpointPolicy } from '../providers/net.ts';
import { mergeComponent, PRESET_NAMES, PRESETS, type PresetName } from '../providers/presets.ts';
import type { ProviderRegistry } from '../providers/registry.ts';
import { parseAssistantConfig, providerFields } from '../engine/config.ts';
import type { ComponentKind } from '../providers/types.ts';
import { toEngineInput } from './engineConfig.ts';
import { invalidPlaceholders, isBuiltInVariable, TEMPLATED_FIELDS, VARIABLE_NAME } from './variables.ts';

/** Version of this schema, stored with every assistant version. Bump on breaking changes. */
export const ASSISTANT_SPEC_SCHEMA_VERSION = 1;

/** Largest stored config (serialized JSON). */
export const MAX_SPEC_BYTES = 100_000;

export const COMPONENT_KINDS = ['transcriber', 'model', 'voice'] as const satisfies readonly ComponentKind[];

const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const text = (max: number) => z.string().max(max);
const uuidList = (max: number, what: string) =>
  z
    .array(z.string().uuid())
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, `${what} must not repeat`);

/** A provider component: `provider` plus that provider's fields (checked by the registry) and engine policy. */
const component = z.object({ provider: z.string().min(1).max(50).optional() }).passthrough();

const endpointing = z
  .object({
    silenceMs: z.number().int().min(100).max(5000),
    minSpeechMs: z.number().int().min(20).max(2000),
    vadMarginDb: z.number().min(3).max(40),
    vadMinSpeechDb: z.number().min(-90).max(-10),
    sttFinalTimeoutMs: z.number().int().min(100).max(10000),
  })
  .partial()
  .strict();

const interruption = z
  .object({
    enabled: z.boolean(),
    minSpeechMs: z.number().int().min(20).max(2000),
    echoGuardDb: z.number().min(0).max(40),
  })
  .partial()
  .strict();

const idle = z
  .object({
    /** No user speech for this long → reminder; 0 disables idle handling. */
    timeoutSeconds: z.number().min(0).max(600),
    message: text(1000),
    maxPrompts: z.number().int().min(0).max(10),
    endMessage: text(1000),
  })
  .partial()
  .strict();

/** A JSON Schema object for structured-data extraction (checked for shape and size only). */
const jsonSchemaObject = z
  .record(z.unknown())
  .refine((schema) => schema.type === 'object', 'Must be a JSON Schema with "type": "object"')
  .refine((schema) => JSON.stringify(schema).length <= 20_000, 'Must be at most 20000 characters of JSON');

const analysis = z
  .object({
    summary: z.object({ enabled: z.boolean(), prompt: text(5000) }).partial().strict(),
    structuredData: z.object({ enabled: z.boolean(), prompt: text(5000), schema: jsonSchemaObject }).partial().strict(),
    /** Rubrics: pass-fail; numeric-scale (a whole score from 1 to 10); descriptive (free-text verdict); categories (one of `categories`). */
    successEvaluation: z
      .object({
        enabled: z.boolean(),
        prompt: text(5000),
        rubric: z.enum(['pass-fail', 'numeric-scale', 'descriptive', 'categories']),
        categories: z.array(z.string().trim().min(1).max(50)).min(2).max(20),
      })
      .partial()
      .strict(),
    /** Reusable structured outputs (org resources) extracted after every call, in addition to `structuredData`. */
    structuredOutputIds: uuidList(16, 'analysis.structuredOutputIds'),
  })
  .partial()
  .strict();

export const assistantSpecSchema = z
  .object({
    firstMessage: text(2000),
    firstMessageMode: z.enum(['assistant-speaks-first', 'assistant-waits-for-user']),
    systemPrompt: text(30_000),
    /** BCP-47 language code: "en", "bn", "en-US". */
    language: z.string().regex(LANGUAGE, 'Must be a language code such as "en", "bn" or "en-US"'),
    preset: z.enum(PRESET_NAMES as [PresetName, ...PresetName[]]),
    transcriber: component,
    model: component,
    voice: component,
    toolIds: uuidList(64, 'toolIds'),
    knowledgeBaseIds: uuidList(16, 'knowledgeBaseIds'),
    endpointing,
    interruption,
    idle,
    maxDurationSeconds: z.number().int().min(10).max(7200),
    maxDurationMessage: text(1000),
    endCallPhrases: z.array(z.string().trim().min(1).max(200)).max(20),
    fallbackMessage: text(1000),
    voicemailMessage: text(1000),
    backgroundSound: z.enum(['off', 'office']),
    /** Webhook URL for this assistant's events (https; private addresses refused). */
    serverUrl: z.string().max(2048),
    analysis,
    /** Per-call debugging. captureLlm stores the full LLM prompts and replies of each call (kept DEBUG_RETENTION_DAYS); off by default because they contain what callers said. */
    debug: z.object({ captureLlm: z.boolean() }).partial().strict(),
    /** Values for {{variables}} the call does not supply. */
    variableDefaults: z.record(z.string().max(1000)).refine((v) => Object.keys(v).length <= 50, 'At most 50 defaults'),
  })
  .partial()
  .strict();

export type AssistantSpec = z.infer<typeof assistantSpecSchema>;

export interface SpecIssue {
  path: string;
  message: string;
}

export type SpecResult = { ok: true; spec: AssistantSpec } | { ok: false; issues: SpecIssue[] };

export interface ValidateOptions {
  registry?: ProviderRegistry;
  /** serverUrl rules; private addresses are allowed only in development. */
  endpointPolicy?: EndpointPolicy;
  /** Prefix for issue paths, e.g. "config" or "assistantOverrides". */
  pathPrefix?: string;
}

/** zod issues → {path, message}; unknown keys are reported per key, at the key's own path. */
export function zodIssues(error: z.ZodError, prefix = ''): SpecIssue[] {
  const join = (parts: (string | number)[]) => [prefix, ...parts.map(String)].filter(Boolean).join('.');
  return error.issues.flatMap((issue) =>
    issue.code === z.ZodIssueCode.unrecognized_keys
      ? issue.keys.map((key) => ({ path: join([...issue.path, key]), message: 'Unknown field' }))
      : [{ path: join(issue.path), message: issue.message }]
  );
}

function crossFieldIssues(spec: AssistantSpec, options: ValidateOptions): SpecIssue[] {
  const issues: SpecIssue[] = [];
  for (const field of TEMPLATED_FIELDS) {
    for (const bad of invalidPlaceholders(spec[field])) {
      issues.push({ path: field, message: `Invalid placeholder ${bad}: names use letters, digits and underscores, e.g. {{customer_name}}` });
    }
  }
  for (const name of Object.keys(spec.variableDefaults ?? {})) {
    if (!VARIABLE_NAME.test(name)) issues.push({ path: `variableDefaults.${name}`, message: 'Variable names use letters, digits and underscores' });
    else if (isBuiltInVariable(name)) issues.push({ path: `variableDefaults.${name}`, message: `{{${name}}} is built in and cannot have a default` });
  }
  if (spec.serverUrl !== undefined) {
    const policy = options.endpointPolicy ?? { allowPrivateNetwork: false };
    try {
      const url = checkEndpointUrl(spec.serverUrl, ['https'], policy);
      if (!policy.allowPrivateNetwork && (url.hostname === 'localhost' || url.hostname.endsWith('.localhost'))) {
        issues.push({ path: 'serverUrl', message: 'Must be a public https URL' });
      }
    } catch (error) {
      issues.push({ path: 'serverUrl', message: (error as Error).message });
    }
  }
  if (spec.analysis?.structuredData?.enabled && !spec.analysis.structuredData.schema) {
    issues.push({ path: 'analysis.structuredData.schema', message: 'Required when structured data extraction is enabled' });
  }
  const success = spec.analysis?.successEvaluation;
  if (success?.rubric === 'categories') {
    if (!success.categories?.length) issues.push({ path: 'analysis.successEvaluation.categories', message: 'List at least two categories for the "categories" rubric' });
    else if (new Set(success.categories).size !== success.categories.length) issues.push({ path: 'analysis.successEvaluation.categories', message: 'Each category only once' });
  } else if (success?.categories) {
    issues.push({ path: 'analysis.successEvaluation.categories', message: 'Only used with rubric "categories"' });
  }
  return issues;
}

/** Each component, merged with its preset exactly as calls will see it, checked by the registry. */
function providerIssues(spec: AssistantSpec, registry: ProviderRegistry): SpecIssue[] {
  const issues: SpecIssue[] = [];
  const preset = PRESETS[spec.preset ?? 'balanced'];
  for (const kind of COMPONENT_KINDS) {
    const merged = mergeComponent(preset[kind], spec[kind]);
    const fallbacks = Array.isArray(merged.fallbacks) ? (merged.fallbacks as Record<string, unknown>[]) : [];
    const entries: [string, unknown][] = [[kind, providerFields(merged)], ...fallbacks.map((f, i): [string, unknown] => [`${kind}.fallbacks.${i}`, f && typeof f === 'object' ? providerFields(f) : f])];
    for (const [path, fields] of entries) {
      try {
        registry.validate(kind, fields, path);
      } catch (error) {
        issues.push({ path, message: (error as Error).message });
      }
    }
  }
  return issues;
}

/**
 * Validate a spec completely. On success `spec` is the parsed spec (what gets stored). The final
 * step builds the engine config, so anything the engine would reject at call time fails here.
 */
export function validateAssistantSpec(input: unknown, options: ValidateOptions = {}): SpecResult {
  const prefix = options.pathPrefix ?? '';
  const withPrefix = (issues: SpecIssue[]) => issues.map((i) => ({ ...i, path: [prefix, i.path].filter(Boolean).join('.') }));
  const parsed = assistantSpecSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, issues: zodIssues(parsed.error, prefix) };
  const spec = parsed.data;
  if (JSON.stringify(spec).length > MAX_SPEC_BYTES) return { ok: false, issues: withPrefix([{ path: '', message: `Config must be at most ${MAX_SPEC_BYTES} bytes of JSON` }]) };

  const registry = options.registry ?? defaultRegistry;
  const issues = [...crossFieldIssues(spec, options), ...providerIssues(spec, registry)];
  if (issues.length) return { ok: false, issues: withPrefix(issues) };

  try {
    parseAssistantConfig(toEngineInput(spec, { name: 'validation' }), registry);
  } catch (error) {
    if (error instanceof z.ZodError) return { ok: false, issues: zodIssues(error, prefix) };
    return { ok: false, issues: withPrefix([{ path: '', message: (error as Error).message }]) };
  }
  return { ok: true, spec };
}
