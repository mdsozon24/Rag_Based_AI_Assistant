/**
 * The PATCH body that turns the saved assistant draft into the edited one. The API applies it as a
 * JSON merge patch with two exceptions (packages/engine/src/assistant/merge.ts), mirrored here:
 * a component whose provider changes is replaced whole, and analysis.structuredData.schema is
 * replaced whole. So applyMergePatch(saved, createMergePatch(saved, edited)) equals edited.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

const REPLACED_WHOLE = new Set(['analysis.structuredData.schema']);
const COMPONENTS = new Set(['transcriber', 'model', 'voice']);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

function diff(from: Json | undefined, to: Json, path: string): Json | undefined {
  if (deepEqual(from, to)) return undefined;
  if (REPLACED_WHOLE.has(path) || !isObject(from) || !isObject(to)) return to;
  // A new provider replaces the whole component on the server: send all of it
  if (COMPONENTS.has(path) && from.provider !== to.provider) return to;
  const patch: JsonObject = {};
  for (const key of Object.keys(from)) if (!Object.hasOwn(to, key)) patch[key] = null;
  for (const [key, value] of Object.entries(to)) {
    const child = diff(from[key], value, path ? `${path}.${key}` : key);
    if (child !== undefined) patch[key] = child;
  }
  return Object.keys(patch).length ? patch : undefined;
}

/** The merge patch from `from` to `to`, or null when they are equal. */
export function createMergePatch(from: object, to: object): Record<string, unknown> | null {
  const patch = diff(from as Json, to as Json, '');
  return patch === undefined ? null : (patch as Record<string, unknown>);
}
