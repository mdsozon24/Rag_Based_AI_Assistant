import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_USER_TEXT_CHARS } from '../src/engine/callSession.ts';
import { EndReason } from '../src/engine/endReason.ts';
import type { SessionEvent } from '../src/engine/events.ts';
import { setup, useFakeClock } from './helpers.ts';

beforeEach(() => useFakeClock());
afterEach(() => vi.useRealTimers());

const tick = (ms: number) => vi.advanceTimersByTimeAsync(ms);

function transcripts(events: SessionEvent[]) {
  return events.flatMap((e) => (e.type === 'transcript' && e.final ? [[e.role, e.text]] : []));
}

describe('chat mode', () => {
  it('answers typed text without STT or TTS and keeps the normal history', async () => {
    const t = setup({ mode: 'chat', config: { firstMessage: { mode: 'assistant-speaks-first', text: 'Hi! How can I help?' } }, llm: ['Your order ships tomorrow.'] });
    await t.session.start();
    await tick(10);
    expect(t.session.state).toBe('listening');

    expect(t.session.submitUserText('  Where is my order?  ')).toBe(true);
    await tick(2000);

    expect(t.stt.connectCalls).toBe(0);
    expect(t.tts.requests).toHaveLength(0);
    expect(t.transport.sentAudio).toHaveLength(0);
    expect(t.llm.requests[0].messages.at(-1)).toEqual({ role: 'user', content: 'Where is my order?' });
    expect(transcripts(t.transport.events)).toEqual([
      ['assistant', 'Hi! How can I help?'],
      ['user', 'Where is my order?'],
      ['assistant', 'Your order ships tomorrow.'],
    ]);
    expect(t.session.history.map((h) => [h.role, h.content])).toEqual([
      ['assistant', 'Hi! How can I help?'],
      ['user', 'Where is my order?'],
      ['assistant', 'Your order ships tomorrow.'],
    ]);
    expect(t.session.turns.at(-1)?.kind).toBe('typed-reply');
    expect(t.states).toEqual(['listening', 'thinking', 'listening']);
  });

  it('ignores caller audio', async () => {
    const t = setup({ mode: 'chat', stt: { utterances: ['should not be heard'] }, llm: ['unused'] });
    await t.session.start();
    await t.caller.speak(800);
    await t.caller.silence(1500);
    expect(t.llm.requests).toHaveLength(0);
    expect(t.session.state).toBe('listening');
  });

  it('ends the call when the model calls endCall', async () => {
    const t = setup({ mode: 'chat', config: { tools: { endCall: { enabled: true, message: 'Goodbye!' } } }, llm: [{ toolCall: { name: 'endCall' } }] });
    await t.session.start();
    t.session.submitUserText('bye');
    await tick(5000);
    const summary = await t.session.ended;
    expect(summary.endReason).toBe(EndReason.AssistantEnded);
    expect(transcripts(t.transport.events).at(-1)).toEqual(['assistant', 'Goodbye!']);
    expect(t.transport.events).toContainEqual({ type: 'tool-call', name: 'endCall', args: {}, at: expect.any(Number) });
  });

  it('speaks the fallback as text when the model fails', async () => {
    const t = setup({ mode: 'chat', config: { fallback: { message: 'Sorry, something went wrong.' } }, llm: [{ text: 'x', error: 'before-first-token' }] });
    await t.session.start();
    t.session.submitUserText('hello');
    await tick(30_000);
    const summary = await t.session.ended;
    expect(summary.endReason).toBe(EndReason.ErrorLlm);
    expect(transcripts(t.transport.events).at(-1)).toEqual(['assistant', 'Sorry, something went wrong.']);
  });
});

describe('typed text during a voice call', () => {
  it('interrupts the agent like speech and answers the text', async () => {
    const t = setup({
      config: { firstMessage: { mode: 'assistant-speaks-first', text: 'Welcome to the clinic. I can book, move or cancel appointments for you today.' } },
      llm: ['Sure, Tuesday works.'],
    });
    await t.session.start();
    await t.caller.silenceUntil(() => t.session.state === 'speaking');
    await t.caller.silence(500);

    expect(t.session.submitUserText('Book me for Tuesday')).toBe(true);
    expect(t.transport.clears).toHaveLength(1);
    await t.caller.silenceUntil(() => t.session.turns.length === 2);

    const [greeting, reply] = t.session.turns;
    expect(greeting.interrupted).toBe(true);
    expect(reply.kind).toBe('typed-reply');
    expect(reply.heardText).toBe('Sure, Tuesday works.');
    expect(t.tts.requests.at(-1)?.text).toBe('Sure, Tuesday works.');
    // Typed turns are not voice turns: no voice-to-voice latency is recorded for them
    expect(reply.latency.voiceToVoiceMs).toBeUndefined();
  });

  it('rejects empty, oversized and early messages', async () => {
    const t = setup({ mode: 'chat', llm: ['ok'] });
    expect(t.session.submitUserText('too early')).toBe(false);
    await t.session.start();
    expect(t.session.submitUserText('   ')).toBe(false);
    expect(t.session.submitUserText('x'.repeat(MAX_USER_TEXT_CHARS + 1))).toBe(false);
    await t.session.end(EndReason.CustomerHungUp);
    expect(t.session.submitUserText('after the end')).toBe(false);
    expect(t.llm.requests).toHaveLength(0);
  });
});
