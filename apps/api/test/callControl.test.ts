import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, json, signUp, type SignedUp, type TestApp } from './helpers.ts';
import type { LiveCallHandle, TransferFailureAction, TransferMode } from '../src/services/liveCalls.ts';

class FakeLiveCall implements LiveCallHandle {
  readonly actions: { type: string; value?: unknown }[] = [];
  private listeners = new Set<(event: Record<string, unknown>) => void>();
  async say(message: string) { this.actions.push({ type: 'say', value: message }); }
  async injectContext(context: string) { this.actions.push({ type: 'context', value: context }); }
  async setMuted(muted: boolean) { this.actions.push({ type: 'mute', value: muted }); }
  async end(reason: string) { this.actions.push({ type: 'end', value: reason }); }
  async transfer(destination: string, options: { mode: TransferMode; summary?: string; failureAction: TransferFailureAction }) { this.actions.push({ type: 'transfer', value: { destination, ...options } }); }
  subscribe(listener: (event: Record<string, unknown>) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: Record<string, unknown>) { for (const listener of this.listeners) listener(event); }
}

describe('live call control', () => {
  let t: TestApp; let owner: SignedUp; let other: SignedUp; let callId: string; let handle: FakeLiveCall;
  beforeAll(async () => {
    t = await createTestApp(); owner = await signUp(t, { orgName: 'Call A' }); other = await signUp(t, { orgName: 'Call B' }); callId = randomUUID(); handle = new FakeLiveCall();
    await t.ctx.tenants.withOrg(owner.orgId, (tx) => tx.query(`INSERT INTO call (id, org_id, type, test, config_source, assistant_name, config, config_schema, variable_values, status, created_by_type, direction) VALUES ($1,$2,'web',true,'transient','Test','{}',1,'{}','in-progress','user','inbound')`, [callId, owner.orgId]));
    t.ctx.liveCalls.register(callId, handle);
  }, 30_000);
  afterAll(async () => t.close());

  it('authorizes every control action and records its timeline', async () => {
    expect((await owner.caller.request('POST', `/v1/calls/${callId}/say`, { message: 'Please hold.' })).statusCode).toBe(200);
    expect((await owner.caller.request('POST', `/v1/calls/${callId}/context`, { context: 'Customer is a priority account.' })).statusCode).toBe(200);
    expect((await owner.caller.request('POST', `/v1/calls/${callId}/mute`, { muted: true })).statusCode).toBe(200);
    expect((await owner.caller.request('POST', `/v1/calls/${callId}/transfer`, { destination: '+8801712345678', mode: 'warm', summary: 'Customer needs billing help.', failureAction: 'return-to-agent' })).statusCode).toBe(200);
    expect((await owner.caller.request('POST', `/v1/calls/${callId}/end`, {})).statusCode).toBe(200);
    expect(handle.actions.map((action) => action.type)).toEqual(['say', 'context', 'mute', 'transfer', 'end']);
    const status = await owner.caller.request('GET', `/v1/calls/${callId}`); expect(status.statusCode).toBe(200); expect(json(status).timeline.map((event: { type: string }) => event.type)).toContain('control.transfer');
  });

  it('prevents another org from controlling or reading the call', async () => {
    expect((await other.caller.request('POST', `/v1/calls/${callId}/say`, { message: 'attack' })).statusCode).toBe(404);
    expect((await other.caller.request('GET', `/v1/calls/${callId}`)).statusCode).toBe(404);
  });
});