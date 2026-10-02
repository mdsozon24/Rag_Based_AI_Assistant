/**
 * How PATCH /v1/assistants/{id} and call-time assistantOverrides change a spec: JSON Merge Patch
 * (RFC 7396) with two exceptions.
 *
 * - Objects merge key by key; arrays and scalars replace; null removes the field (back to its default).
 * - Exception 1: a component (transcriber, model, voice) whose `provider` changes is replaced, not
 *   merged, because another provider's fields would not fit (the same rule as presets, D31).
 * - Exception 2: analysis.structuredData.schema (a JSON Schema) is replaced as a whole.
 *
 * Inputs are never modified.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

const REPLACED_WHOLE = new Set(['analysis.structuredData.schema']);
const COMPONENTS = new Set(['transcriber', 'model', 'voice']);

/** Drop nulls recursively (a null inside a new value means "absent"). */
function withoutNulls(value: Json): Json {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(value)) if (child !== null) out[key] = withoutNulls(child);
  return out;
}

function merge(target: Json | undefined, patch: Json, path: string): Json {
  // Kept verbatim: null can be meaningful inside a JSON Schema ("default": null)
  if (REPLACED_WHOLE.has(path)) return patch;
  if (!isObject(patch)) return withoutNulls(patch);
  if (COMPONENTS.has(path) && isObject(target) && typeof patch.provider === 'string' && patch.provider !== target.provider) {
    return withoutNulls(patch);
  }
  const out: JsonObject = isObject(target) ? { ...target } : {};
  for (const [key, child] of Object.entries(patch)) {
    if (child === null) delete out[key];
    else out[key] = merge(out[key], child, path ? `${path}.${key}` : key);
  }
  return out;
}

/** Apply `patch` to `target` (both plain JSON objects). Returns a new object. */
export function applyMergePatch<T extends object>(target: T, patch: object): T {
  return merge(structuredClone(target) as unknown as Json, structuredClone(patch) as unknown as Json, '') as unknown as T;
}

/** Top-level fields a patch touches, for audit logs and override records. */
export function patchedFields(patch: object): string[] {
  return Object.keys(patch).sort();
}
