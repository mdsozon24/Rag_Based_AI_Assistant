import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, json, signUp, type SignedUp, type TestApp } from './helpers.ts';

describe('squads API', () => {
  let t: TestApp; let owner: SignedUp; let other: SignedUp; let first: string; let second: string;
  beforeAll(async () => { t = await createTestApp(); owner = await signUp(t, { orgName: 'Squad A' }); other = await signUp(t, { orgName: 'Squad B' }); const a = json(await owner.caller.request('POST', '/v1/assistants', { name: 'Receptionist', config: { language: 'bn', firstMessage: 'আসসালামু আলাইকুম' } })); const b = json(await owner.caller.request('POST', '/v1/assistants', { name: 'Booking', config: { language: 'bn', firstMessage: 'আমি বুকিং সহায়তা করছি' } })); first = a.id; second = b.id; }, 30_000);
  afterAll(async () => t.close());

  it('creates ordered Bangladesh-focused members with handoff rules and overrides', async () => {
    const created = await owner.caller.request('POST', '/v1/squads', { name: 'Bangladesh service desk', description: 'Bangla receptionist to booking flow', overrides: { language: 'bn' }, members: [{ assistantId: first, contextMode: 'summary', handoffTargets: { booking: 'Use when the caller wants an appointment' } }, { assistantId: second, contextMode: 'variables', contextSchema: { required: ['name', 'reason'] }, memberOverrides: { voice: { provider: 'custom' } }, handoffTargets: {} }, { inlineConfig: { language: 'bn', firstMessage: 'আপনার বিলিং সহায়তা করছি' }, contextMode: 'full', handoffTargets: {} }] });
    expect(created.statusCode).toBe(201); expect(json(created).members).toHaveLength(3); expect(json(created).members[1].contextMode).toBe('variables');
    const fetched = await owner.caller.request('GET', `/v1/squads/${json(created).id}`); expect(fetched.statusCode).toBe(200); expect(json(fetched).overrides.language).toBe('bn');
    expect((await other.caller.request('GET', `/v1/squads/${json(created).id}`)).statusCode).toBe(404);
  });
});