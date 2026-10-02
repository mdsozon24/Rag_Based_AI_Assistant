/** Reply parsing, rubric checks and JSON Schema handling for call analysis: pure logic. */
import { describe, expect, it } from 'vitest';
import { checkSchema, validateAgainst } from '../src/services/analysis/jsonSchema.ts';
import { parseJsonObject, parseSuccess } from '../src/services/analysis/prompts.ts';
import { transcriptForModel, type TranscriptRow } from '../src/services/analysis/transcript.ts';

describe('model replies', () => {
  it('finds the JSON object in a fenced or chatty reply', () => {
    expect(parseJsonObject('{"a": 1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonObject('```json\n{"a": [1, 2], "b": {"c": null}}\n```')).toEqual({ ok: true, value: { a: [1, 2], b: { c: null } } });
    expect(parseJsonObject('Sure! Here you go: {"a": "x"} Hope that helps.')).toEqual({ ok: true, value: { a: 'x' } });
  });

  it.each(['', 'no json here', '{"a": ', '[1, 2]', '"text"', '{broken}'])('rejects %j with a reason', (reply) => {
    const parsed = parseJsonObject(reply);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(5);
  });

  it('checks each success rubric strictly', () => {
    expect(parseSuccess('pass-fail', undefined, { passed: true, reason: ' ok ' })).toEqual({ ok: true, result: { rubric: 'pass-fail', passed: true, score: null, category: null, reason: 'ok' } });
    expect(parseSuccess('pass-fail', undefined, { passed: 'true' }).ok).toBe(false);
    for (const score of [1, 5, 10]) expect(parseSuccess('numeric-scale', undefined, { score }).ok).toBe(true);
    for (const score of [0, 11, 5.5, '7', null]) expect(parseSuccess('numeric-scale', undefined, { score }).ok).toBe(false);
    expect(parseSuccess('categories', ['a', 'b'], { category: 'b' }).ok).toBe(true);
    expect(parseSuccess('categories', ['a', 'b'], { category: 'c' }).ok).toBe(false);
    expect(parseSuccess('categories', ['a', 'b'], {}).ok).toBe(false);
    expect(parseSuccess('descriptive', undefined, { verdict: 'Fine.' })).toMatchObject({ ok: true, result: { reason: 'Fine.' } });
    expect(parseSuccess('descriptive', undefined, { verdict: '  ' }).ok).toBe(false);
  });
});

describe('JSON Schema for structured outputs', () => {
  it('accepts ordinary object schemas, local references and formats', () => {
    expect(checkSchema({ type: 'object', properties: { a: { type: 'boolean' }, d: { type: 'string', format: 'date' }, e: { enum: ['x', 'y'] } }, required: ['a'] })).toEqual([]);
    expect(checkSchema({ type: 'object', $defs: { n: { type: 'integer' } }, properties: { a: { $ref: '#/$defs/n' } } })).toEqual([]);
  });

  it('refuses what could harm the service', () => {
    const paths = (schema: unknown) => checkSchema(schema).map((i) => i.path);
    expect(paths(null)).toEqual(['schema']);
    expect(paths([])).toEqual(['schema']);
    expect(paths({ type: 'string' })).toContain('schema.type');
    expect(paths({ type: 'object', properties: { a: { type: 'string', pattern: '(a+)+$' } } })).toEqual(['schema.properties.a.pattern']);
    expect(paths({ type: 'object', patternProperties: { x: {} } })).toEqual(['schema.patternProperties']);
    expect(paths({ type: 'object', properties: { a: { $ref: 'http://169.254.169.254/' } } })).toEqual(['schema.properties.a.$ref']);
    expect(paths({ type: 'object', properties: { a: { $dynamicRef: 'other.json' } } })).toEqual(['schema.properties.a.$dynamicRef']);
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 20; i++) deep = { type: 'object', properties: { x: deep } };
    expect(checkSchema(deep).some((i) => i.message.includes('deep'))).toBe(true);
    expect(paths({ type: 'object', properties: { a: { type: 'nonsense' } } })).toEqual(['schema']);
  });

  it('validates values and says what is wrong in short sentences', () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' }, mood: { enum: ['good', 'bad'] }, when: { type: 'string', format: 'date' } }, required: ['ok'], additionalProperties: false };
    expect(validateAgainst(schema, { ok: true, mood: 'good', when: '2026-10-05' })).toEqual({ ok: true });
    const bad = validateAgainst(schema, { ok: 'yes', mood: 'meh', when: 'tomorrow', extra: 1 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      const text = bad.errors.join(' | ');
      expect(text).toMatch(/\/ok must be boolean/);
      expect(text).toMatch(/\/mood must be equal to one of the allowed values/);
      expect(text).toMatch(/\/when must match format "date"/);
      expect(text).toMatch(/must NOT have additional properties/);
    }
    expect(validateAgainst(schema, {}).ok).toBe(false);
  });
});

describe('transcript for the model', () => {
  const at = (s: number) => new Date(Date.parse('2026-10-05T04:00:00Z') + s * 1000);
  const row = (seq: number, patch: Partial<TranscriptRow>): TranscriptRow => ({
    id: String(seq), seq, kind: 'speech', role: 'user', text: 'hi', final: true, interrupted: false, started_at: at(seq), ended_at: at(seq + 1), tool_name: null, tool_args: null, tool_result: null, tool_status: null, created_at: at(seq), ...patch,
  });

  it('shows time, speaker, interruptions and tool calls in order', () => {
    const text = transcriptForModel(
      [row(1, { role: 'assistant', text: 'Hello' }), row(65, { text: 'I need help' }), row(70, { kind: 'tool-call', role: 'tool', text: 'lookup', tool_name: 'lookup', tool_args: { id: 7 }, tool_status: 'success' }), row(80, { role: 'assistant', text: 'Our hours are nine to', interrupted: true })],
      at(0),
      10_000
    );
    expect(text.split('\n')).toEqual([
      '[00:01] Assistant: Hello',
      '[01:05] Caller: I need help',
      '[01:10] (tool call) lookup({"id":7}) -> success',
      '[01:20] Assistant (interrupted): Our hours are nine to',
    ]);
  });

  it('keeps the start and end of a long call and says what was left out', () => {
    const rows = Array.from({ length: 1000 }, (_, i) => row(i + 1, { text: `sentence ${i} ${'x'.repeat(40)}` }));
    const text = transcriptForModel(rows, at(0), 5_000);
    expect(text.length).toBeLessThan(5_200);
    expect(text).toContain('sentence 0 ');
    expect(text).toContain('sentence 999 ');
    expect(text).toContain('the middle of a long call was left out');
    expect(transcriptForModel([], at(0), 100)).toBe('');
  });
});
