import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, json, signUp, type SignedUp, type TestApp } from './helpers.ts';

describe('tools API', () => {
  let t: TestApp;
  let owner: SignedUp;

  beforeAll(async () => {
    t = await createTestApp({
      fetch: async (_url, init) => ({ ok: true, status: 200, json: async () => ({ received: JSON.parse(init?.body ?? '{}'), auth: init?.headers?.authorization }) }),
    });
    owner = await signUp(t, { orgName: 'Tool Org' });
  }, 30_000);

  afterAll(async () => t.close());

  it('creates a strictly validated tool, encrypts auth, and executes its test endpoint', async () => {
    const created = await owner.caller.request('POST', '/v1/tools', {
      name: 'lookup_order',
      description: 'Look up an order',
      type: 'function',
      parameters: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
      endpointUrl: 'https://tool.example.test/orders',
      auth: { type: 'bearer' },
      authSecret: 'secret-token',
      sensitivePaths: ['orderId'],
    });
    if (created.statusCode !== 201) throw new Error(created.body);
    expect(created.statusCode).toBe(201);
    const tool = json(created);
    expect(tool.auth.configured).toBe(true);
    expect(JSON.stringify(tool)).not.toContain('secret-token');

    const tested = await owner.caller.request('POST', `/v1/tools/${tool.id}/test`, { orderId: '123' });
    expect(tested.statusCode).toBe(200);
    expect(json(tested).status).toBe('success');
    expect(json(tested).output.auth).toBe('Bearer secret-token');
  });

  it('returns field-level errors and keeps tools tenant scoped', async () => {
    const invalid = await owner.caller.request('POST', '/v1/tools', { name: 'bad', description: 'bad', type: 'function', parameters: { type: 'object' } });
    expect(invalid.statusCode).toBe(400);
    expect(json(invalid).details.issues).toContainEqual({ path: 'endpointUrl', message: 'Required for function tools' });
    const list = await owner.caller.request('GET', '/v1/tools');
    expect(json(list).data).toHaveLength(1);
  });
});