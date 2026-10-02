/**
 * Server-side diagnostics from a CallSession: LLM requests and responses (with the tokens each used),
 * provider errors and fallbacks. They go to onDebug listeners only, never to the transport, because an
 * LLM request holds the system prompt and everything the model was shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DebugEvent } from '../src/engine/events.ts';
import { ModelChain } from '../src/providers/chain.ts';
import { UsageMeter } from '../src/engine/usage.ts';
import { silentLogger } from '../src/logger.ts';
import { FakeLlmProvider } from '../src/testing/fakes.ts';
import { setup, useFakeClock } from './helpers.ts';

beforeEach(() => useFakeClock());
afterEach(() => vi.useRealTimers());

function debugEvents(t: ReturnType<typeof setup>): DebugEvent[] {
  const events: DebugEvent[] = [];
  t.session.onDebug((e) => events.push(e));
  return events;
}

describe('LLM request and response diagnostics', () => {
  it('records what the model was asked and what it answered, per turn, with the tokens used', async () => {
    const t = setup({ config: { systemPrompt: 'You are a dental receptionist.' }, stt: { utterances: ['Do you open on Friday?'] }, llm: [{ text: 'Yes, from nine to five.', usage: { inputTokens: 120, outputTokens: 9 } }] });
    const events = debugEvents(t);
    await t.session.start();
    await t.caller.speak(400);
    await t.caller.silenceUntil(() => t.session.turns.length === 1);

    const request = events.find((e) => e.type === 'llm-request');
    const response = events.find((e) => e.type === 'llm-response');
    expect(request).toMatchObject({
      type: 'llm-request',
      turn: 1,
      provider: 'fake-llm',
      model: 'fake-llm-1',
      messageCount: 1,
      systemPromptChars: 'You are a dental receptionist.'.length,
      toolNames: expect.arrayContaining(['endCall']),
      request: { systemPrompt: 'You are a dental receptionist.', messages: [{ role: 'user', content: 'Do you open on Friday?' }] },
    });
    expect(response).toMatchObject({
      type: 'llm-response',
      turn: 1,
      provider: 'fake-llm',
      outcome: 'completed',
      inputTokens: 120,
      outputTokens: 9,
      response: { text: 'Yes, from nine to five.', toolCalls: [] },
    });
    expect((response as Extract<DebugEvent, { type: 'llm-response' }>).firstTokenMs).toBeGreaterThanOrEqual(0);
    expect((response as Extract<DebugEvent, { type: 'llm-response' }>).durationMs).toBeGreaterThanOrEqual((response as Extract<DebugEvent, { type: 'llm-response' }>).firstTokenMs!);
  });

  it('never sends diagnostics to the transport (the browser), which would expose the system prompt', async () => {
    const t = setup({ config: { systemPrompt: 'SECRET-SYSTEM-PROMPT-DO-NOT-LEAK' }, stt: { utterances: ['hello'] }, llm: ['Hi there.'] });
    await t.session.start();
    await t.caller.speak(400);
    await t.caller.silenceUntil(() => t.session.turns.length === 1);
    const sent = JSON.stringify(t.transport.events);
    expect(sent).not.toContain('SECRET-SYSTEM-PROMPT-DO-NOT-LEAK');
    expect(t.transport.events.some((e) => (e as { type: string }).type.startsWith('llm-') || (e as { type: string }).type.startsWith('provider-'))).toBe(false);
  });

  it('records tool calls in the response and an error outcome when the model fails', async () => {
    const t = setup({ stt: { utterances: ['bye'] }, llm: [{ text: 'Goodbye!', toolCall: { name: 'endCall', args: { reason: 'done' } } }] });
    const events = debugEvents(t);
    await t.session.start();
    await t.caller.speak(400);
    await t.caller.silenceUntil(() => t.session.state === 'ended');
    expect(events.find((e) => e.type === 'llm-response')).toMatchObject({ outcome: 'completed', response: { text: 'Goodbye!', toolCalls: [{ name: 'endCall', args: { reason: 'done' } }] } });

    const failing = setup({ config: { fallback: { message: 'Sorry.' } }, stt: { utterances: ['hello'] }, llm: [{ error: 'before-first-token' }] });
    const failed = debugEvents(failing);
    await failing.session.start();
    await failing.caller.speak(400);
    await failing.caller.silenceUntil(() => failing.session.state === 'ended');
    expect(failed.filter((e) => e.type === 'llm-response')[0]).toMatchObject({ outcome: 'error', error: expect.stringContaining('fake llm failure') });
  });

  it('reports a provider that failed for good, with its name and whether a retry could help', async () => {
    const t = setup({ config: { fallback: { message: 'Sorry.' } }, stt: { utterances: ['hello'] }, llm: [{ error: 'before-first-token' }] });
    const events = debugEvents(t);
    await t.session.start();
    await t.caller.speak(400);
    await t.caller.silenceUntil(() => t.session.state === 'ended');
    const error = events.find((e) => e.type === 'provider-error');
    expect(error).toMatchObject({ type: 'provider-error', stage: 'llm', provider: 'fake-llm', model: 'fake-llm-1', retryable: true, message: expect.stringContaining('fake llm failure') });
  });
});

describe('provider fallback diagnostics', () => {
  // The chains run on their own timers, not a session's fake clock
  beforeEach(() => vi.useRealTimers());

  it('tells the listener which provider took over and why', async () => {
    const seen: unknown[] = [];
    const a = new FakeLlmProvider([{ error: 'before-first-token' }], { firstTokenMs: 1, provider: 'llm-a', model: 'a-1' });
    const b = new FakeLlmProvider(['Fine.'], { firstTokenMs: 1, provider: 'llm-b', model: 'b-1' });
    const entry = (i: FakeLlmProvider) => ({ instance: i, provider: i.provider, model: i.model, credentialSource: 'platform' as const, billing: 'platform' as const });
    const chain = new ModelChain([entry(a), entry(b)], { component: 'model', callId: 'c', logger: silentLogger, meter: new UsageMeter(), retries: 0, onFallback: (info) => seen.push(info) }, { firstTokenTimeoutMs: 1000, idleTimeoutMs: 1000 });
    for await (const _ of chain.stream({ systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] }, new AbortController().signal)) void _;
    expect(seen).toEqual([{ component: 'model', from: { provider: 'llm-a', model: 'a-1' }, to: { provider: 'llm-b', model: 'b-1' }, message: expect.stringContaining('fake llm failure') }]);
  });

  it('a listener that throws never breaks the call', async () => {
    const a = new FakeLlmProvider([{ error: 'before-first-token' }], { firstTokenMs: 1, provider: 'llm-a' });
    const b = new FakeLlmProvider(['Fine.'], { firstTokenMs: 1, provider: 'llm-b' });
    const entry = (i: FakeLlmProvider) => ({ instance: i, provider: i.provider, model: i.model, credentialSource: 'platform' as const, billing: 'platform' as const });
    const chain = new ModelChain([entry(a), entry(b)], { component: 'model', callId: 'c', logger: silentLogger, meter: new UsageMeter(), retries: 0, onFallback: () => { throw new Error('boom'); } }, { firstTokenTimeoutMs: 1000, idleTimeoutMs: 1000 });
    const out: string[] = [];
    for await (const e of chain.stream({ systemPrompt: 's', messages: [{ role: 'user', content: 'hi' }], tools: [] }, new AbortController().signal)) if (e.type === 'text') out.push(e.text);
    expect(out.join('')).toBe('Fine.');
  });
});
