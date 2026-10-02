/**
 * The assistant config rules the editor checks before saving: the same fields, limits and messages
 * as the API's (packages/engine/src/assistant/spec.ts), without the provider registry (provider
 * fields are checked by the API, which answers with field paths the editor shows in place).
 * apps/api/test/dashboardParity.test.ts runs both schemas over the same inputs.
 */
import { z } from 'zod';
import { BUILT_IN_VARIABLES, invalidPlaceholders, VARIABLE_NAME } from '@engine/assistant/variables.ts';

const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const text = (max: number) => z.string().max(max);
const uuidList = (max: number, what: string) =>
  z
    .array(z.string().uuid())
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, `${what} must not repeat`);

const component = z.object({ provider: z.string().min(1).max(50).optional() }).passthrough();

const jsonSchemaObject = z
  .record(z.unknown())
  .refine((schema) => schema.type === 'object', 'Must be a JSON Schema with "type": "object"')
  .refine((schema) => JSON.stringify(schema).length <= 20_000, 'Must be at most 20000 characters of JSON');

export const RUBRICS = ['pass-fail', 'numeric-scale', 'descriptive', 'categories'] as const;
export const PRESETS = ['fast', 'balanced', 'quality'] as const;

export const assistantSpecSchema = z
  .object({
    firstMessage: text(2000),
    firstMessageMode: z.enum(['assistant-speaks-first', 'assistant-waits-for-user']),
    systemPrompt: text(30_000),
    language: z.string().regex(LANGUAGE, 'Must be a language code such as "en", "bn" or "en-US"'),
    preset: z.enum(PRESETS),
    transcriber: component,
    model: component,
    voice: component,
    toolIds: uuidList(64, 'toolIds'),
    knowledgeBaseIds: uuidList(16, 'knowledgeBaseIds'),
    endpointing: z
      .object({
        silenceMs: z.number().int().min(100).max(5000),
        minSpeechMs: z.number().int().min(20).max(2000),
        vadMarginDb: z.number().min(3).max(40),
        vadMinSpeechDb: z.number().min(-90).max(-10),
        sttFinalTimeoutMs: z.number().int().min(100).max(10000),
      })
      .partial()
      .strict(),
    interruption: z.object({ enabled: z.boolean(), minSpeechMs: z.number().int().min(20).max(2000), echoGuardDb: z.number().min(0).max(40) }).partial().strict(),
    idle: z.object({ timeoutSeconds: z.number().min(0).max(600), message: text(1000), maxPrompts: z.number().int().min(0).max(10), endMessage: text(1000) }).partial().strict(),
    maxDurationSeconds: z.number().int().min(10).max(7200),
    maxDurationMessage: text(1000),
    endCallPhrases: z.array(z.string().trim().min(1).max(200)).max(20),
    fallbackMessage: text(1000),
    voicemailMessage: text(1000),
    backgroundSound: z.enum(['off', 'office']),
    serverUrl: z.string().max(2048),
    analysis: z
      .object({
        summary: z.object({ enabled: z.boolean(), prompt: text(5000) }).partial().strict(),
        structuredData: z.object({ enabled: z.boolean(), prompt: text(5000), schema: jsonSchemaObject }).partial().strict(),
        successEvaluation: z
          .object({ enabled: z.boolean(), prompt: text(5000), rubric: z.enum(RUBRICS), categories: z.array(z.string().trim().min(1).max(50)).min(2).max(20) })
          .partial()
          .strict(),
        structuredOutputIds: uuidList(16, 'analysis.structuredOutputIds'),
      })
      .partial()
      .strict(),
    debug: z.object({ captureLlm: z.boolean() }).partial().strict(),
    variableDefaults: z.record(z.string().max(1000)).refine((v) => Object.keys(v).length <= 50, 'At most 50 defaults'),
  })
  .partial()
  .strict()
  .superRefine((spec, ctx) => {
    const add = (path: (string | number)[], message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    for (const field of ['firstMessage', 'systemPrompt'] as const) {
      for (const bad of invalidPlaceholders(spec[field])) add([field], `Invalid placeholder ${bad}: names use letters, digits and underscores, e.g. {{customer_name}}`);
    }
    for (const name of Object.keys(spec.variableDefaults ?? {})) {
      if (!VARIABLE_NAME.test(name)) add(['variableDefaults', name], 'Variable names use letters, digits and underscores');
      else if (Object.hasOwn(BUILT_IN_VARIABLES, name)) add(['variableDefaults', name], `{{${name}}} is built in and cannot have a default`);
    }
    if (spec.serverUrl !== undefined && !/^https:\/\/[^\s/]+/i.test(spec.serverUrl)) add(['serverUrl'], 'Must be a public https URL');
    if (spec.analysis?.structuredData?.enabled && !spec.analysis.structuredData.schema) add(['analysis', 'structuredData', 'schema'], 'Required when structured data extraction is enabled');
    const success = spec.analysis?.successEvaluation;
    if (success?.rubric === 'categories') {
      if (!success.categories?.length) add(['analysis', 'successEvaluation', 'categories'], 'List at least two categories for the "categories" rubric');
      else if (new Set(success.categories).size !== success.categories.length) add(['analysis', 'successEvaluation', 'categories'], 'Each category only once');
    } else if (success?.categories) {
      add(['analysis', 'successEvaluation', 'categories'], 'Only used with rubric "categories"');
    }
  });

export type AssistantSpec = z.infer<typeof assistantSpecSchema>;

export const assistantName = z.string().trim().min(1, 'Enter a name').max(100, 'At most 100 characters');
export const publishNote = z.string().trim().max(500, 'At most 500 characters');
