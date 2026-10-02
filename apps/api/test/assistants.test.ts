import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addMember, createKey, createTestApp, json, keyCaller, signUp, type SignedUp, type TestApp } from './helpers.ts';

describe('assistants and calls', () => {
  let t: TestApp;
  let owner: SignedUp;

  beforeAll(async () => {
    t = await createTestApp();
    owner = await signUp(t, { orgName: 'Assistant Org' });
  }, 30_000);

  afterAll(async () => t.close());

  it('creates, publishes, versions, and rolls back an assistant', async () => {
    const created = await owner.caller.request('POST', '/v1/assistants', {
      name: 'Support',
      config: { firstMessage: 'Hello {{customer_name}}', systemPrompt: 'Help {{customer_name}}', variableDefaults: {} },
    });
    expect(created.statusCode).toBe(201);
    const assistant = json(created);

    const published = await owner.caller.request('POST', `/v1/assistants/${assistant.id}/publish`, { note: 'Initial' });
    expect(published.statusCode).toBe(201);
    expect(json(published).version).toBe(1);

    const updated = await owner.caller.request('PATCH', `/v1/assistants/${assistant.id}`, { config: { firstMessage: 'Welcome {{customer_name}}' } });
    expect(updated.statusCode).toBe(200);
    const second = await owner.caller.request('POST', `/v1/assistants/${assistant.id}/publish`, {});
    expect(second.statusCode).toBe(201);
    expect(json(second).version).toBe(2);

    const rollback = await owner.caller.request('POST', `/v1/assistants/${assistant.id}/rollback`, { version: 1, restoreDraft: true });
    expect(rollback.statusCode).toBe(200);
    expect(json(rollback).config.firstMessage).toBe('Hello {{customer_name}}');
  });

  it('enforces variables and keeps overrides out of the saved assistant', async () => {
    const list = await owner.caller.request('GET', '/v1/assistants?search=Support');
    const assistant = json(list).data[0];

    const missing = await owner.caller.request('POST', '/v1/calls', { assistantId: assistant.id });
    expect(missing.statusCode).toBe(400);
    expect(json(missing).details.issues).toContainEqual({ path: 'variables.customer_name', message: 'Required by firstMessage and systemPrompt' });

    const call = await owner.caller.request('POST', '/v1/calls', {
      assistantId: assistant.id,
      variables: { customer_name: 'Ada' },
      overrides: { maxDurationSeconds: 120 },
    });
    expect(call.statusCode).toBe(201);
    expect(json(call).configSource).toBe('published');
    expect(json(call).config.maxDurationSeconds).toBe(120);

    const unchanged = await owner.caller.request('GET', `/v1/assistants/${assistant.id}`);
    expect(json(unchanged).config.maxDurationSeconds).toBeUndefined();
  });

  it('starts validated transient and browser test calls', async () => {
    const transient = await owner.caller.request('POST', '/v1/calls', {
      assistant: { firstMessage: 'Hi {{name}}' },
      variables: { name: 'Ada' },
    });
    expect(transient.statusCode).toBe(201);
    expect(json(transient).configSource).toBe('transient');
    expect(json(transient).assistantId).toBeNull();
    expect(json(transient).connectToken).toEqual(expect.any(String));

    const list = await owner.caller.request('GET', '/v1/assistants?search=Support');
    const assistant = json(list).data[0];
    const testCall = await owner.caller.request('POST', `/v1/assistants/${assistant.id}/test-call`, { variables: { customer_name: 'Ada' } });
    expect(testCall.statusCode).toBe(201);
    expect(json(testCall).status).toBe('queued');
  });

  it('serves the provider catalog that assistant validation accepts', async () => {
    const res = await owner.caller.request('GET', '/v1/providers');
    expect(res.statusCode).toBe(200);
    const catalog = json(res);
    expect(Object.keys(catalog.components)).toEqual(['transcriber', 'model', 'voice']);
    expect(catalog.presets.map((p: { name: string }) => p.name)).toEqual(['fast', 'balanced', 'quality']);
    // Every provider with each suggested model is a valid assistant draft
    for (const kind of ['transcriber', 'model', 'voice'] as const) {
      for (const provider of catalog.components[kind].providers as { id: string; suggestedModels: string[] }[]) {
        for (const model of provider.suggestedModels) {
          const draft = await owner.caller.request('POST', '/v1/assistants', { name: `${kind} ${provider.id} ${model}`, config: { [kind]: { provider: provider.id, model, ...(kind === 'voice' ? { voiceId: 'voice-1' } : {}) } } });
          expect(draft.statusCode, draft.body).toBe(201);
        }
      }
    }
    // Every role can read it; a public key cannot
    const viewer = await addMember(t, owner, 'viewer');
    expect((await viewer.caller.request('GET', '/v1/providers')).statusCode).toBe(200);
    const { key } = await createKey(owner.caller, { name: 'site', type: 'public', allowedOrigins: ['https://shop.example'] });
    const refused = await keyCaller(t, key, 'public', 'https://shop.example').request('GET', '/v1/providers');
    expect(refused.statusCode).toBe(403);
    expect(json(refused).code).toBe('forbidden_key_type');
  });
});