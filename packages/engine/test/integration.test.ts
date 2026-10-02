/**
 * End-to-end scripted conversation through the real CallSession with fake STT/LLM/TTS, over a
 * telephony-format transport (8 kHz mu-law both ways), so codec and resampling are exercised too.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { durationMs, MULAW_8K } from '../src/audio/format.ts';
import { EndReason } from '../src/engine/endReason.ts';
import { LATENCY_METRICS } from '../src/engine/metrics.ts';
import { setup, useFakeClock } from './helpers.ts';

beforeEach(() => useFakeClock());
afterEach(() => vi.useRealTimers());

describe('scripted phone conversation', () => {
  it('runs greeting, three turns with a barge-in, and an assistant hang-up', async () => {
    const t = setup({
      inputFormat: MULAW_8K,
      outputFormat: MULAW_8K,
      playbackLeadMs: 60,
      config: {
        language: 'en',
        systemPrompt: 'You are the booking line of a restaurant.',
        firstMessage: { mode: 'assistant-speaks-first', text: 'Thanks for calling Octo Bistro. How can I help?' },
        endpointing: { silenceMs: 500 },
        idle: { timeoutMs: 8000 },
        maxDurationMs: 5 * 60 * 1000,
      },
      stt: {
        utterances: ['I want to book a table', 'Actually make it tomorrow at seven', 'No that is everything thanks'],
        finalLatencyMs: 120,
      },
      llm: [
        'Of course. For how many people, and for which day would you like the booking? We have tables free all week, including the terrace.',
        'Done. A table for tomorrow at seven. Anything else?',
        { text: 'Great, see you tomorrow. Goodbye!', toolCall: { name: 'endCall', args: { reason: 'caller done' } } },
      ],
      llmDefaults: { firstTokenMs: 250, tokenMs: 30 },
      tts: { firstByteMs: 110, speed: 2 },
    });

    await t.session.start();
    // Caller listens to the greeting, then asks
    await t.caller.silenceUntil(() => t.session.state === 'listening');
    await t.caller.silence(300);
    await t.caller.speak(1200);
    // Agent starts the long answer; caller interrupts after ~1.2 s of it
    await t.caller.silenceUntil(() => t.session.state === 'speaking');
    await t.caller.silence(1200);
    await t.caller.speak(1500);
    await t.caller.silenceUntil(() => t.session.turns.length === 3 && t.session.state === 'listening');
    await t.caller.silence(400);
    await t.caller.speak(1000);
    await t.caller.silenceUntil(() => t.session.state === 'ended');
    const summary = await t.session.ended;

    // ---- end reason and state machine
    expect(summary.endReason).toBe(EndReason.AssistantEnded);
    expect(summary.callId).toBe('test-call');
    expect(summary.stateHistory.map((s) => s.to)).toEqual([
      'speaking', // greeting
      'listening',
      'thinking',
      'speaking',
      'listening', // barge-in
      'thinking',
      'speaking',
      'listening',
      'thinking',
      'speaking',
      'ended',
    ]);

    // ---- transcript: the interrupted answer is recorded only as far as it was heard
    const interrupted = summary.history[2];
    expect(summary.history.map((h) => [h.role, h.interrupted ? `${h.content}…` : h.content])).toEqual([
      ['assistant', 'Thanks for calling Octo Bistro. How can I help?'],
      ['user', 'I want to book a table'],
      ['assistant', `${interrupted.content}…`],
      ['user', 'Actually make it tomorrow at seven'],
      ['assistant', 'Done. A table for tomorrow at seven. Anything else?'],
      ['user', 'No that is everything thanks'],
      ['assistant', 'Great, see you tomorrow. Goodbye!'],
    ]);
    expect(interrupted.interrupted).toBe(true);
    expect(interrupted.content.startsWith('Of course.')).toBe(true);
    expect(interrupted.content.length).toBeLessThan(60);
    // The LLM saw the truncated answer, not the full generated text
    expect(t.llm.requests[1].messages[2]).toEqual({ role: 'assistant', content: interrupted.content });
    expect(t.llm.requests[0].systemPrompt).toBe('You are the booking line of a restaurant.');

    // ---- audio went out as 8 kHz mu-law (1 byte per sample) and was cleared once
    expect(t.transport.sentAudio.length).toBeGreaterThan(10);
    for (const chunk of t.transport.sentAudio) expect(chunk.durationMs).toBe(durationMs(MULAW_8K, chunk.bytes.length));
    expect(t.transport.clears).toHaveLength(1);

    // ---- latency fields on every reply turn
    const replies = summary.turns.filter((turn) => turn.kind === 'reply');
    expect(replies).toHaveLength(3);
    for (const turn of replies) {
      const l = turn.latency;
      expect(l.endpointingMs).toBeGreaterThanOrEqual(500);
      expect(l.endpointingMs).toBeLessThan(560);
      expect(l.sttFinalMs).toBe(120);
      expect(l.llmFirstTokenMs).toBe(250);
      expect(l.ttsFirstByteMs).toBe(110);
      expect(l.pipelineMs).toBeGreaterThanOrEqual(120 + 250 + 110);
      expect(l.voiceToVoiceMs).toBe(l.endpointingMs! + l.pipelineMs!);
    }
    expect(replies[0].interrupted).toBe(true);
    expect(replies[0].latency.bargeInStopMs).toBeLessThanOrEqual(200);
    expect(replies[1].latency.bargeInStopMs).toBeUndefined();

    // ---- p50/p95 summary covers the reply turns
    expect(Object.keys(summary.latency).sort()).toEqual([...LATENCY_METRICS].sort());
    expect(summary.latency.voiceToVoiceMs.count).toBe(3);
    expect(summary.latency.voiceToVoiceMs.p50).toBeGreaterThan(900);
    expect(summary.latency.voiceToVoiceMs.p95).toBeGreaterThanOrEqual(summary.latency.voiceToVoiceMs.p50!);
    expect(summary.latency.bargeInStopMs.count).toBe(1);

    // ---- control events the client receives
    const types = new Set(t.transport.events.map((e) => e.type));
    for (const type of ['state', 'user-speech', 'transcript', 'interrupted', 'turn', 'ended']) expect(types.has(type as never)).toBe(true);
    expect(t.transport.closed).toBe(true);
  });
});
