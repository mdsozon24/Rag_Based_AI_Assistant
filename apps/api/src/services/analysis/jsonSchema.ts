/**
 * JSON Schema handling for structured outputs: checking a schema an org wants to save, and
 * validating the values the model extracted against it.
 *
 * Schemas come from customers and are executed by us against model output, on a process that
 * serves every tenant. So the supported dialect is limited on purpose:
 * - the schema must be an object schema, at most 20,000 characters, and compile (Ajv, draft 2020-12 keywords, formats on);
 * - `pattern` and `patternProperties` are refused: a hostile regular expression can stall the event loop (ReDoS);
 * - `$ref` must point inside the schema ("#/..."), never to another document; nothing is ever fetched.
 */
import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import * as formatsModule from 'ajv-formats';

type FormatsPlugin = (ajv: Ajv) => Ajv;
const addFormats: FormatsPlugin = ((formatsModule as unknown as { default?: FormatsPlugin }).default ?? (formatsModule as unknown as FormatsPlugin));

export const MAX_SCHEMA_CHARS = 20_000;
const MAX_DEPTH = 12;
const FORBIDDEN_KEYWORDS = new Set(['pattern', 'patternProperties']);

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true, validateFormats: true });
addFormats(ajv);

export interface SchemaIssue {
  path: string;
  message: string;
}

/** Problems that make a schema unusable here (an empty list means it can be saved). */
export function checkSchema(schema: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [{ path: 'schema', message: 'Must be a JSON Schema object' }];
  if ((schema as { type?: unknown }).type !== 'object') issues.push({ path: 'schema.type', message: 'The top-level schema must have "type": "object"' });
  if (JSON.stringify(schema).length > MAX_SCHEMA_CHARS) issues.push({ path: 'schema', message: `Must be at most ${MAX_SCHEMA_CHARS} characters of JSON` });

  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH) {
      if (depth === MAX_DEPTH + 1) issues.push({ path, message: `Nested more than ${MAX_DEPTH} levels deep` });
      return;
    }
    if (Array.isArray(node)) return node.forEach((child, i) => walk(child, `${path}.${i}`, depth + 1));
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (FORBIDDEN_KEYWORDS.has(key)) issues.push({ path: `${path}.${key}`, message: `"${key}" is not supported (regular expressions in schemas can stall the service); use enum, format, minLength or maxLength` });
      if ((key === '$ref' || key === '$dynamicRef') && (typeof child !== 'string' || !child.startsWith('#'))) issues.push({ path: `${path}.${key}`, message: 'References must point inside the schema ("#/$defs/...")' });
      walk(child, `${path}.${key}`, depth + 1);
    }
  };
  walk(schema, 'schema', 0);
  if (issues.length) return issues;
  try {
    ajv.compile(schema as object);
  } catch (error) {
    issues.push({ path: 'schema', message: `Not a valid JSON Schema: ${(error as Error).message}` });
  }
  return issues;
}

const cache = new Map<string, ValidateFunction>();
const CACHE_LIMIT = 200;

function validator(schema: object): ValidateFunction {
  const key = JSON.stringify(schema);
  let compiled = cache.get(key);
  if (!compiled) {
    compiled = ajv.compile(schema);
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
    cache.set(key, compiled);
  }
  return compiled;
}

export function describeErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).slice(0, 10).map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}${e.params && 'allowedValues' in e.params ? ` (${JSON.stringify(e.params.allowedValues)})` : ''}`.trim());
}

/** Does `value` satisfy `schema`? Errors are short sentences (also fed back to the model for its retry). */
export function validateAgainst(schema: object, value: unknown): { ok: true } | { ok: false; errors: string[] } {
  const validate = validator(schema);
  if (validate(value)) return { ok: true };
  return { ok: false, errors: describeErrors(validate.errors) };
}
