import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { executeTool, executeTools } from '../src/tools/executor.ts';
import { runToolTurn } from '../src/tools/runtime.ts';
import { validateToolSpec, type ToolSpec } from '../src/tools/schema.ts';
import { FakeLlmProvider } from '../src/testing/fakes.ts';
import { createLogger } from '../src/logger.ts';

function tool(overrides: Partial<ToolSpec> = {}): ToolSpec {
  return validateToolSpec({ name: 'lookup', description: 'Look something up', type: 'function', endpointUrl: 'https://tool.example.test/run', messages: { requestStart: 'working' }, parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, ...overrides }).ok
    ? (validateToolSpec({ name: 'lookup', description: 'Look something up', type: 'function', endpointUrl: 'https://tool.example.test/run', messages: { requestStart: 'working' }, parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, ...overrides }) as { ok: true; spec: ToolSpec }).spec
    : (() => { throw new Error('invalid test tool'); })();
}

describe('tool executor', () => {
  it('returns structured invalid-argument errors before calling the server', async () => {
    let calls = 0;
    const result = await executeTool(tool(), { id: 4 }, { callId: 'call-1', fetch: async () => { calls++; throw new Error('should not call'); } });
    expect(result.status).toBe('invalid-arguments');
    expect(result.output).toMatchObject({ code: 'invalid_arguments' });
    expect(calls).toBe(0);
  });

  it('times out and retries a failed HTTP tool', async () => {
    let attempts = 0;
    const result = await executeTool(tool({ timeoutMs: 100, retries: 1 }), { id: 'x' }, {
      callId: 'call-1',
      fetch: (_url, init) => new Promise((_resolve, reject) => { attempts++; init.signal.addEventListener('abort', () => { const error = new Error('aborted'); error.name = 'AbortError'; reject(error); }); }),
    });
    expect(result.status).toBe('failed');
    expect(attempts).toBe(2);
    expect(result.error).toContain('timed out');
  });

  it('signs requests and merges hidden static and variable-alias parameters', async () => {
    let received: { body: string; headers: Record<string, string> } | undefined;
    const secret = 'test-secret';
    const result = await executeTool(tool({ parameters: { type: 'object', properties: { id: { type: 'string' }, customerId: { type: 'string' }, tenant: { type: 'string' } }, required: ['id', 'customerId', 'tenant'] }, auth: { type: 'hmac' }, staticParameters: { tenant: 'org-a' }, variableAliases: { customerId: 'customer_id' }, sensitivePaths: ['customerId'] }), { id: 'x', tenant: 'attacker' }, {
      callId: 'call-1', authSecret: secret, variables: { customer_id: 'cust-7' },
      fetch: async (_url, init) => { received = { body: init.body, headers: init.headers }; return { ok: true, status: 200, json: async () => ({ ok: true }) }; },
      protect: (value) => `encrypted:${String(value)}`,
    });
    expect(result.status).toBe('success');
    expect(JSON.parse(received!.body)).toEqual({ id: 'x', tenant: 'org-a', customerId: 'cust-7' });
    expect(received!.headers['x-octo-signature']).toBe(createHmac('sha256', secret).update(received!.body).digest('hex'));
    expect(result.loggedArgs).toMatchObject({ customerId: 'encrypted:cust-7' });
  });

  it('executes parallel calls and applies rejection rules', async () => {
    const messages: string[] = [];
    const [first, second, rejected] = await executeTools([
      { tool: tool({ name: 'a' }), args: { id: 'a' } },
      { tool: tool({ name: 'b' }), args: { id: 'b' } },
      { tool: tool({ name: 'guard', rejectionRules: [{ when: { lastUserMessageContains: 'question' }, message: 'Please answer first' }] }), args: { id: 'c' } },
    ], {
      callId: 'call-1', lastUserMessage: 'This is a question', onMessage: (_stage, message) => messages.push(message),
      fetch: async (_url, init) => { await new Promise((resolve) => setTimeout(resolve, 5)); return { ok: true, status: 200, json: async () => JSON.parse(init.body) }; },
    });
    expect(first.status).toBe('success');
    expect(second.status).toBe('success');
    expect(rejected.status).toBe('rejected');
    expect(messages.length).toBe(2);
  });

  it('lets a fake LLM call a tool and use its result', async () => {
    const model = new FakeLlmProvider((request) => request.messages.some((message) => message.role === 'tool') ? 'Your order is ready.' : { toolCall: { name: 'lookup', args: { id: 'order-7' } } });
    const result = await runToolTurn(model, 'Be helpful', [{ role: 'user', content: 'Where is my order?' }], [tool()], {
      callId: 'call-1', signal: new AbortController().signal, logger: createLogger({ level: 'silent' }),
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ order: 'ready' }) }),
    });
    expect(result.text).toBe('Your order is ready.');
    expect(result.executions[0].output).toEqual({ order: 'ready' });
    expect(result.messages.at(-1)).toMatchObject({ role: 'tool', name: 'lookup' });
  });
});