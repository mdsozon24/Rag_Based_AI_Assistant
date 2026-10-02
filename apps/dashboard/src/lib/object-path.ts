/**
 * Immutable nested reads and writes for config objects ("endpointing.silenceMs").
 * Writing undefined removes the key, and objects left empty are removed too, so clearing a field
 * puts it back to its default instead of storing an empty value.
 */

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

export function getIn(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const key of path.split('.')) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

export function setIn<T extends object>(source: T, path: string, value: unknown): T {
  const keys = path.split('.');
  const write = (node: unknown, index: number): unknown => {
    const base: Obj = isObject(node) ? { ...node } : {};
    const key = keys[index];
    if (index === keys.length - 1) {
      if (value === undefined) delete base[key];
      else base[key] = value;
    } else {
      const child = write(base[key], index + 1);
      if (isObject(child) && Object.keys(child).length === 0) delete base[key];
      else base[key] = child;
    }
    return base;
  };
  return write(source, 0) as T;
}

/** Text input → value: empty means "not set". */
export const textValue = (value: string): string | undefined => (value === '' ? undefined : value);

/** Number input → value: empty or not a number means "not set". */
export function numberValue(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
