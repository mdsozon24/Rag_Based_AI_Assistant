/**
 * {{variable}} placeholders in an assistant's firstMessage and systemPrompt.
 *
 * - Names: a letter or underscore, then letters, digits or underscores (case-sensitive), with
 *   optional spaces inside the braces: {{customer_name}}, {{ customer_name }}.
 * - Values come from, in order: built-ins (cannot be overridden), the call's variableValues, the
 *   assistant's variableDefaults.
 * - Missing values: the call is refused (MissingVariablesError) before it starts, so the agent
 *   never speaks a raw "{{name}}" or an empty gap.
 * - Rendering is a single pass: a value that itself contains "{{x}}" is inserted as-is.
 * - Anything else in double braces (e.g. "{{first name}}") is rejected when the assistant is saved.
 */

export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,63})\s*\}\}/g;
const ANY_BRACES = /\{\{([^{}]*)\}\}/g;

/** Filled by the platform for every call. */
export const BUILT_IN_VARIABLES = {
  now: 'Call start time, ISO 8601 UTC (2026-10-01T09:30:00Z)',
  date: 'Call start date, UTC (2026-10-01)',
  time: 'Call start time, UTC, 24-hour (09:30)',
  call_id: 'The call id',
} as const;
export type BuiltInVariable = keyof typeof BUILT_IN_VARIABLES;

export const isBuiltInVariable = (name: string): name is BuiltInVariable => Object.hasOwn(BUILT_IN_VARIABLES, name);

/** Fields that may contain placeholders. */
export const TEMPLATED_FIELDS = ['firstMessage', 'systemPrompt'] as const;
export type TemplatedField = (typeof TEMPLATED_FIELDS)[number];

/** Variable names used in `text`, in order of first use. */
export function variablesIn(text: string | undefined): string[] {
  if (!text) return [];
  const names = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) names.add(match[1]);
  return [...names];
}

/** Double-brace expressions in `text` that are not valid placeholders. */
export function invalidPlaceholders(text: string | undefined): string[] {
  if (!text) return [];
  const bad: string[] = [];
  for (const match of text.matchAll(ANY_BRACES)) {
    if (!VARIABLE_NAME.test(match[1].trim())) bad.push(match[0]);
  }
  return bad;
}

export function builtInValues(callId: string, startedAt: Date): Record<BuiltInVariable, string> {
  const iso = startedAt.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return { now: iso, date: iso.slice(0, 10), time: iso.slice(11, 16), call_id: callId };
}

export interface MissingVariable {
  name: string;
  /** Which fields use it. */
  usedIn: TemplatedField[];
}

export class MissingVariablesError extends Error {
  constructor(readonly missing: MissingVariable[]) {
    super(`Missing values for ${missing.map((m) => `{{${m.name}}}`).join(', ')}`);
    this.name = 'MissingVariablesError';
  }
}

/** Variables the caller must supply: used, not built in, and without an assistant default. */
export function requiredVariables(fields: Partial<Record<TemplatedField, string>>, defaults: Record<string, string> = {}): MissingVariable[] {
  const byName = new Map<string, TemplatedField[]>();
  for (const field of TEMPLATED_FIELDS) {
    for (const name of variablesIn(fields[field])) {
      if (isBuiltInVariable(name) || Object.hasOwn(defaults, name)) continue;
      byName.set(name, [...(byName.get(name) ?? []), field]);
    }
  }
  return [...byName].map(([name, usedIn]) => ({ name, usedIn }));
}

/** Replace placeholders in `text`. Unknown names are left in place (callers check missing first). */
export function renderTemplate(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => (Object.hasOwn(values, name) ? values[name] : whole));
}

export interface RenderInput {
  fields: Partial<Record<TemplatedField, string>>;
  /** Supplied for this call. */
  values?: Readonly<Record<string, string>>;
  /** The assistant's defaults. */
  defaults?: Readonly<Record<string, string>>;
  callId: string;
  startedAt: Date;
}

/** Render every templated field for one call. Throws MissingVariablesError listing every gap. */
export function renderFields(input: RenderInput): Record<TemplatedField, string> {
  const values: Record<string, string> = { ...(input.defaults ?? {}), ...(input.values ?? {}), ...builtInValues(input.callId, input.startedAt) };
  const missing = requiredVariables(input.fields, { ...(input.defaults ?? {}), ...(input.values ?? {}) });
  if (missing.length) throw new MissingVariablesError(missing);
  const out = {} as Record<TemplatedField, string>;
  for (const field of TEMPLATED_FIELDS) out[field] = renderTemplate(input.fields[field] ?? '', values);
  return out;
}
