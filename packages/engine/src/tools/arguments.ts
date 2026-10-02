export interface ArgumentIssue { path: string; message: string }

/** Small offline JSON Schema subset for tool arguments: object properties, required, arrays, enums and primitives. */
export function validateToolArguments(schema: Record<string, unknown>, value: unknown): ArgumentIssue[] {
  const issues: ArgumentIssue[] = [];
  validate(schema, value, '', issues);
  return issues;
}

function validate(schema: Record<string, unknown>, value: unknown, path: string, issues: ArgumentIssue[]): void {
  const type = schema.type;
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { issues.push({ path, message: 'Expected an object' }); return; }
    const object = value as Record<string, unknown>;
    for (const required of Array.isArray(schema.required) ? schema.required : []) if (typeof required === 'string' && !Object.hasOwn(object, required)) issues.push({ path: join(path, required), message: 'Required' });
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties as Record<string, unknown> : {};
    for (const [key, child] of Object.entries(object)) {
      const property = properties[key];
      if (property && typeof property === 'object') validate(property as Record<string, unknown>, child, join(path, key), issues);
      else if (schema.additionalProperties === false) issues.push({ path: join(path, key), message: 'Unknown field' });
    }
    return;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) { issues.push({ path, message: 'Expected an array' }); return; }
    if (schema.items && typeof schema.items === 'object') value.forEach((item, index) => validate(schema.items as Record<string, unknown>, item, join(path, String(index)), issues));
    return;
  }
  if (type && !matches(type, value)) issues.push({ path, message: `Expected ${String(type)}` });
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => Object.is(candidate, value))) issues.push({ path, message: 'Value is not allowed' });
}

function matches(type: unknown, value: unknown): boolean {
  if (type === 'string') return typeof value === 'string';
  if (type === 'number' || type === 'integer') return typeof value === 'number' && Number.isFinite(value) && (type !== 'integer' || Number.isInteger(value));
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return true;
}

const join = (parent: string, child: string) => parent ? `${parent}.${child}` : child;