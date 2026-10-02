import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EndReason } from '../src/engine/endReason.ts';
import type { SessionEvent } from '../src/engine/events.ts';
import { setup, useFakeClock } from './helpers.ts';

beforeEach(() => useFakeClock());
afterEach(() => vi.useRealTimers());

const LONG_REPLY =
  'Sure, I can help with that. First we will check your account details. Then I will look at the recent orders. ' +
  'After that we can talk about the delivery options that are available in your area this week.';

describe('first message', () => {
  it('speaks first when configured, then listens', async () => {
    const t = setup({ config: { firstMessage: { mode: 'assistant-speaks-first', text: 'Hello! How can I help?' } } });
    await t.session.start();
    await t.caller.silenceUntil(() => t.session.state === 'listening');
    expect(t.states).toEqual(['speaking', 'listening']);
    expect(t.tts.requests.map((r) => r.text)).toEqual(['Hello!', 'How can I help?']);
    expect(t.session.history).toEqual([expect.objectContaining({ role: 'assistant', content: 'Hello! How can I help?', kind: 'first-message' })]);
    expect(t.transport.totalSentMs()).toBeCloseTo(t.tts.durationFor('Hello!') + t.tts.durationFor('How can I help?'), 0);
  });

  it('waits for the user when configured', async () => {
    const t = setup({ stt: { utterances: ['hi'] }, llm: ['Hello.'] });
    await t.session.start();
    expect(t.session.state).toBe('listening');
    await t.caller.silence(2000);
    expect(t.transport.sentAudio).toHaveLength(0);
    await t.caller.speak(400);
    await t.caller.silenceUntil(() => t.session.history.length === 2);
    expect(t.session.history.map((h) => [h.role, h.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'Hello.'],
    ]);
  });
});

describe('turn taking and streaming', () => {
  it('runs listening -> thinking -> speaking -> listening with streaming at each stage', async () => {
    const t = setup({
      config: { endpointing: { silenceMs: 500 } },
      stt: { utterances: ['What can you do?'], finalLatencyMs: 150 },
      llm: [LONG_REPLY],
      llmDefaults: { firstTokenMs: 300, tokenMs: 40 },
      tts: { firstByteMs: 120 },
    });
    await t.session.start();
    await t.caller.silence(600);
    await t.caller.speak(800);
    await t.caller.silenceUntil(() => t.session.state === 'thinking');
    await t.caller.silenceUntil(() => t.session.turns.length === 1);

    expect(t.states).toEqual(['listening', 'thinking', 'speaking', 'listening']);
    const [turn] = t.session.turns;
    const ts = turn.timestamps;
    expect(turn.userText).toBe('What can you do?');
    expect(turn.heardText).toBe(LONG_REPLY);
    expect(turn.interrupted).toBe(false);

    // Endpoint after the configured silence, STT final after commit, LLM, then TTS
    expect(turn.latency.endpointingMs).toBeGreaterThanOrEqual(500);
    expect(turn.latency.endpointingMs).toBeLessThanOrEqual(520);
    expect(turn.latency.sttFinalMs).toBe(150);
    expect(turn.latency.llmFirstTokenMs).toBe(300);
    expect(turn.latency.ttsFirstByteMs).toBe(120);
    expect(turn.latency.voiceToVoiceMs).toBe(turn.latency.endpointingMs! + 150 + (ts.ttsRequestAt! - ts.sttFinalAt!) + 120);

    // TTS started on the first clause, long before the LLM finished its reply
    const tokens = LONG_REPLY.split(' ').length;
    const llmDoneAt = ts.llmRequestAt! + 300 + (tokens - 1) * 40;
    expect(ts.ttsRequestAt!).toBeLessThan(llmDoneAt - 1000);
    expect(ts.agentAudioStartAt!).toBeLessThan(llmDoneAt);
    expect(t.tts.requests[0].text).toBe('Sure, I can help with that.');
    expect(t.tts.requests.length).toBeGreaterThan(2);

    // LLM received the user message; the transcript reached the transport
    expect(t.llm.requests[0].messages).toEqual([{ role: 'user', content: 'What can you do?' }]);
    expect(t.transport.events).toContainEqual({ type: 'transcript', role: 'user', text: 'What can you do?', final: true, startedAt: expect.any(Number), endedAt: expect.any(Number) });
    // Final lines say when they were spoken: the caller from speech onset to end, the agent from first audio to the end of play-out
    const finals = t.transport.events.filter((e) => e.type === 'transcript' && e.final) as { role: string; startedAt: number; endedAt: number }[];
    expect(finals.map((e) => e.role)).toEqual(expect.arrayContaining(['user', 'assistant']));
    for (const line of finals) expect(line.endedAt).toBeGreaterThanOrEqual(line.startedAt);
    const user = finals.find((e) => e.role === 'user')!;
    const assistant = finals.filter((e) => e.role === 'assistant').at(-1)!;
    expect(assistant.startedAt).toBeGreaterThan(user.endedAt);
  });

  it('goes back to listening on an empty transcript (noise) without calling the LLM', async () => {
    const t = setup({ stt: { utterances: [''] } });
    await t.session.start();
    await t.caller.speak(300);
    await t.caller.silenceUntil(() => t.states.includes('thinking'));
    await t.caller.silenceUntil(() => t.session.state === 'listening');
    expect(t.llm.requests).toHaveLength(0);
    expect(t.session.history).toEqual([]);
  });

  it('merges speech when the user keeps talking after the endpoint', async () => {
    const t = setup({
      config: { endpointing: { silenceMs: 400 } },
      stt: { utterances: ['I would like to', 'book a table for two'] },
      llm: ['Sure, for what time?'],
      llmDefaults: { firstTokenMs: 900 },
    });
    await t.session.start();
    await t.caller.speak(600);
    await t.caller.silence(500); // endpoint fires, LLM is thinking
    expect(t.session.state).toBe('thinking');
    await t.caller.speak(700); // user continues before the agent says anything
    expect(t.session.state).toBe('listening');
    await t.caller.silenceUntil(() => t.session.turns.length === 1);
    expect(t.session.turns[0].userText).toBe('I would like to book a table for two');
    expect(t.llm.requests.at(-1)!.messages).toEqual([{ role: 'user', content: 'I would like to book a table for two' }]);
    expect(t.session.history.map((h) => h.content)).toEqual(['I would like to book a table for two', 'Sure, for what time?']);
  });

  it('uses the last partial transcript when the STT final does not arrive', async () => {
    const t = setup({ stt: { utterances: ['hello there friend'], dropFinals: true }, llm: ['Hi!'], config: { endpointing: { sttFinalTimeoutMs: 800 } } });
    await t.session.start();
    await t.caller.speak(600);
    await t.caller.silenceUntil(() => t.session.turns.length === 1);
    expect(t.session.turns[0].userText).toBe('hello there');
    expect(t.session.turns[0].latency.sttFinalMs).toBe(800);
  });
});

describe('barge-in', () => {
  it('stops playback within 200 ms, cancels LLM/TTS and keeps only the heard text', async () => {
    const t = setup({
      stt: { utterances: ['Tell me about delivery', 'Stop, just tell me the price'] },
      llm: [LONG_REPLY, 'It costs five dollars.'],
      llmDefaults: { firstTokenMs: 200, tokenMs: 60 },
      tts: { speed: 1.5 },
    });
    const events: SessionEvent[] = [];
    t.session.onEvent((e) => events.push(e));
    await t.session.start();
    await t.caller.speak(600);
    await t.caller.silenceUntil(() => t.session.state === 'speaking');
    await t.caller.silence(1500); // agent talks for a while
    const requestsBefore = t.tts.requests.length;

    const bargeInAt = Date.now();
    await t.caller.speak(200);
    expect(t.session.state).toBe('listening');
    expect(t.transport.clears).toHaveLength(1);
    expect(t.transport.clears[0] - bargeInAt).toBeLessThanOrEqual(200);

    const [interrupted] = t.session.turns;
    expect(interrupted.interrupted).toBe(true);
    expect(interrupted.latency.bargeInStopMs!).toBeLessThanOrEqual(200);
    expect(interrupted.heardText.length).toBeGreaterThan(0);
    expect(interrupted.heardText.length).toBeLessThan(LONG_REPLY.length);
    expect(LONG_REPLY.startsWith(interrupted.heardText)).toBe(true);
    // ~1.5 s heard at 50 ms/char ≈ 30 chars, rounded down to a word
    expect(interrupted.heardText.length).toBeGreaterThan(20);
    expect(interrupted.heardText.length).toBeLessThan(45);

    // In-flight LLM/TTS work was cancelled, nothing more is sent
    expect(t.llm.aborts + t.tts.aborts).toBeGreaterThan(0);
    const sentAfterClear = t.transport.sentAudio.filter((a) => a.at > t.transport.clears[0]);
    expect(sentAfterClear).toHaveLength(0);
    expect(t.tts.requests.length).toBe(requestsBefore);
    expect(events).toContainEqual(expect.objectContaining({ type: 'interrupted', heardText: interrupted.heardText }));

    // History holds only what was heard, and the next LLM call sees that
    expect(t.session.history[1]).toMatchObject({ role: 'assistant', content: interrupted.heardText, interrupted: true });
    await t.caller.speak(600);
    await t.caller.silenceUntil(() => t.session.turns.length === 2);
    expect(t.llm.requests[1].messages).toEqual([
      { role: 'user', content: 'Tell me about delivery' },
      { role: 'assistant', content: interrupted.heardText },
      { role: 'user', content: 'Stop, just tell me the price' },
    ]);
    expect(t.session.turns[1].heardText).toBe('It costs five dollars.');
  });

  it('does not barge in on a short noise burst while the agent talks', async () => {
    const t = setup({ stt: { utterances: ['hi'] }, llm: [LONG_REPLY], tts: { speed: 1.5 } });
    await t.session.start();
    await t.caller.speak(500);
    await t.caller.silenceUntil(() => t.session.state === 'speaking');
    await t.caller.speak(60); // cough
    await t.caller.silence(200);
    expect(t.session.state).toBe('speaking');
    expect(t.transport.clears).toHaveLength(0);
  });

  it('can be disabled per assistant', async () => {
    const t = setup({ config: { interruption: { enabled: false } }, stt: { utterances: ['hi'] }, llm: ['Hello there, this is a long enough answer to talk over.'], tts: { speed: 1.5 } });
    await t.session.start();
    await t.caller.speak(500);
    await t.caller.silenceUntil(() => t.session.state === 'speaking');
    await t.caller.speak(500);
    expect(t.transport.clears).toHaveLength(0);
    await t.caller.silenceUntil(() => t.session.turns.length === 1);
    expect(t.session.turns[0].interrupted).toBe(false);
  });

  it('interrupts the first message too', async () => {
    const t = setup({ config: { firstMessage: { mode: 'assistant-speaks-first', text: 'Welcome to our service. We have many options for you today.' } }, stt: { utterances: ['agent please'] }, llm: ['Connecting you.'] });
    await t.session.start();
    await t.caller.silence(800);
    await t.caller.speak(400);
    expect(t.transport.clears).toHaveLength(1);
    expect(t.session.history[0]).toMatchObject({ role: 'assistant', interrupted: true, kind: 'first-message' });
    await t.caller.silenceUntil(() => t.session.turns.length === 2);
    expect(t.session.turns[1].userText).toBe('agent please');
  });
});

describe('silence handling and limits', () => {
  it('reminds the caller after the idle timeout and ends after N reminders', async () => {
    const t = setup({ config: { idle: { timeoutMs: 3000, message: 'Are you still there?', maxPrompts: 2 } } });
    await t.session.start();
    const startedAt = Date.now();
    await t.caller.silenceUntil(() => t.session.state === 'ended', 60000);
    const summary = await t.session.ended;
    expect(summary.endReason).toBe(EndReason.SilenceTimeout);
    expect(t.tts.requests.map((r) => r.text)).toEqual(['Are you still there?', 'Are you still there?']);
    expect(summary.turns.map((turn) => turn.kind)).toEqual(['idle-prompt', 'idle-prompt']);
    // 3 timeouts plus two spoken reminders
    const reminderMs = t.tts.durationFor('Are you still there?');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(9000 + 2 * reminderMs);
    expect(Date.now() - startedAt).toBeLessThan(9000 + 2 * reminderMs + 1000);
  });

  it('resets the reminder count when the caller speaks', async () => {
    const t = setup({ config: { idle: { timeoutMs: 2000, maxPrompts: 1 } }, stt: { utterances: ['yes I am here'] }, llm: ['Great.'] });
    await t.session.start();
    await t.caller.silenceUntil(() => t.session.turns.length === 1, 10000); // first reminder
    await t.caller.speak(500);
    await t.caller.silenceUntil(() => t.session.turns.length === 2);
    await t.caller.silenceUntil(() => t.session.turns.length === 3, 10000); // reminder again, not the end
    expect(t.session.turns[2].kind).toBe('idle-prompt');
    expect(t.session.state).not.toBe('ended');
  });

  it('ends at the max duration, speaking the configured message', async () => {
    const t = setup({ config: { maxDurationMs: 5000, maxDurationMessage: 'Our time is up, goodbye.' }, stt: { utterances: ['hi'] }, llm: [LONG_REPLY], tts: { speed: 1.5 } });
    await t.session.start();
    await t.caller.speak(400);
    await t.caller.silenceUntil(() => t.session.state === 'ended', 20000);
    const summary = await t.session.ended;
    expect(summary.endReason).toBe(EndReason.MaxDuration);
    expect(summary.history.at(-1)).toMatchObject({ role: 'assistant', content: 'Our time is up, goodbye.', kind: 'goodbye' });
    // The long reply was cut off at 5 s and recorded as heard
    expect(summary.history.find((h) => h.interrupted)).toBeDefined();
    expect(t.transport.clears).toHaveLength(1);
  });

  it('records customer hang-up, keeping the part of the reply that was heard', async () => {
    const t = setup({ stt: { utterances: ['hi'] }, llm: [LONG_REPLY], tts: { speed: 1.5 } });
    await t.session.start();
    await t.caller.speak(400);
    await t.caller.silenceUntil(() => t.session.state === 'speaking');
    await t.caller.silence(1000);
    t.transport.hangup();
    const summary = await t.session.ended;
    expect(summary.endReason).toBe(EndReason.CustomerHungUp);
    expect(summary.history[1]).toMatchObject({ role: 'assistant', interrupted: true });
    expect(t.stt.current!.closed).toBe(true);
    expect(summary.stateHistory.at(-1)).toMatchObject({ to: 'ended', reason: 'customer-hung-up' });
  });
});

describe('tools', () => {
  it('ends the call after the goodbye when the model calls endCall', async () => {
    const t = setup({ stt: { utterances: ['that is all, bye'] }, llm: [{ text: 'Thanks for calling, goodbye!', toolCall: { name: 'endCall' } }] });
    await t.session.start();
    await t.caller.speak(500);
    await t.caller.silenceUntil(() => t.session.state === 'ended');
    const summary = await t.session.ended;
    expect(summary.endReason).toBe(EndReason.AssistantEnded);
    expect(summary.history.at(-1)!.content).toBe('Thanks for calling, goodbye!');
    // Ended only after the goodbye was fully played
    expect(summary.endedAt).toBeGreaterThanOrEqual(summary.turns[0].timestamps.agentAudioEndAt!);
    expect(t.llm.requests[0].tools.map((tool) => tool.name)).toEqual(['endCall']);
  });

  it('transfers when the model calls transferCall', async () => {
    const t = setup({
      config: { tools: { transferCall: { enabled: true, destinations: [{ name: 'sales', target: '+15550001111', description: 'Sales team', message: 'Transferring you to sales.' }] } } },
      stt: { utterances: ['I want to buy'] },
      llm: [{ toolCall: { name: 'transferCall', args: { destination: 'sales' } } }],
    });
    await t.session.start();
    await t.caller.speak(500);
    await t.caller.silenceUntil(() => t.session.state === 'ended');
    const summary = await t.session.ended;
    expect(summary.endReason).toBe(EndReason.Transferred);
    expect(summary.transferredTo).toBe('sales');
    expect(t.transport.transfers.map((d) => d.target)).toEqual(['+15550001111']);
    expect(t.states).toContain('transferring');
    expect(t.tts.requests.map((r) => r.text)).toEqual(['Transferring you to sales.']);
  });
});

describe('provider failures', () => {
  it('retries the LLM once and continues the call', async () => {
    const t = setup({ stt: { utterances: ['hello'] }, llm: [{ text: 'Hi there.', error: 'before-first-token', errorAttempts: 1 }] });
    await t.session.start();
    await t.caller.speak(400);
    await t.caller.silenceUntil(() => t.session.turns.length === 1);
    expect(t.llm.requests).toHaveLength(2);
    expect(t.session.turns[0].heardText).toBe('Hi there.');
    expect(t.session.state).toBe('listening');
  });

  it('speaks the fallback message and ends with error-llm when the LLM keeps failing', async () => {
    const t = setup({
      config: { fallback: { prefetchAudio: true, message: 'Sorry, something went wrong.' } },
      stt: { utterances: ['hello'] },
      llm: [{ error: 'before-first-token' }],
    });
    await t.session.start();
    await t.caller.speak(400);
    await t.caller.silenceUntil(() => t.session.state === 'ended');
    const summary = await t.session.ended;
    expect(summary.endReason).toBe(EndReason.ErrorLlm);
    expect(summary.error).toMatchObject({ stage: 'llm' });
    expect(t.llm.requests).toHaveLength(2); // first attempt + one retry
    expect(summary.history.at(-1)).toMatchObject({ role: 'assistant', content: 'Sorry, something went wrong.', kind: 'fallback' });
    expect(t.transport.events.some((e) => e.type === 'error' && e.stage === 'llm')).toBe(true);
  });

  it('falls back after a mid-stream LLM failure without repeating what was said', async () => {
    const t = setup({
      config: { fallback: { message: 'Sorry, something went wrong.' } },
      stt: { utterances: ['hello'] },
      llm: [{ text: 'One two three four five six seven eight nine ten.', error: 'mid-stream' }],
    });
    await t.session.start();
    await t.caller.speak(400);
    await t.caller.silenceUntil(() => t.session.state === 'ended');
    const summary = await t.session.ended;
    expect(summary.endReason).toBe(EndReason.ErrorLlm);
    expect(t.llm.requests).toHaveLength(1);
  });

  it('plays prefetched fallback audio when TTS fails mid-call', async () => {
    const t = setup({
      config: { fallback: { prefetchAudio: true, message: 'Sorry, we have a problem.' } },
      stt: { utterances: ['hello'] },
      llm: ['This reply will fail to synthesize.'],
      tts: { failWhenTextIncludes: 'fail to synthesize' },
    });
    await t.session.start();
    await t.caller.silence(500); // fallback audio is prefetched once listening
    await t.caller.speak(400);
    await t.caller.silenceUntil(() => t.session.state === 'ended');
    const summary = await t.session.ended;
    expect(summary.endReason).toBe(EndReason.ErrorTts);
    expect(t.tts.requests.filter((r) => r.text.includes('fail to synthesize'))).toHaveLength(2); // + one retry
    expect(summary.history.at(-1)).toMatchObject({ content: 'Sorry, we have a problem.', kind: 'fallback' });
    expect(t.transport.totalSentMs()).toBeGreaterThan(0);
  });

  it('ends promptly with error-tts when TTS fails and no fallback audio exists', async () => {
    const t = setup({ stt: { utterances: ['hello'] }, llm: ['Hi.'], tts: { failRequests: 99 } });
    await t.session.start();
    await t.caller.speak(400);
    const waited = await t.caller.silenceUntil(() => t.session.state === 'ended', 10000);
    expect(waited).toBeLessThan(3000);
    expect((await t.session.ended).endReason).toBe(EndReason.ErrorTts);
  });

  it('times out a hanging LLM, retries, then fails over', async () => {
    const t = setup({ config: { model: { firstTokenTimeoutMs: 1000 }, fallback: { message: 'Sorry.' } }, stt: { utterances: ['hello'] }, llm: [{ text: 'late', firstTokenMs: 60000 }] });
    await t.session.start();
    await t.caller.speak(400);
    const waited = await t.caller.silenceUntil(() => t.session.state === 'ended', 10000);
    expect(waited).toBeLessThan(4000);
    const summary = await t.session.ended;
    expect(summary.endReason).toBe(EndReason.ErrorLlm);
    expect(summary.error!.message).toMatch(/timed out/);
    expect(t.llm.requests).toHaveLength(2);
  });

  it('retries the STT connection once at call start', async () => {
    const t = setup({ stt: { failConnects: 1 } });
    await t.session.start();
    expect(t.stt.connectCalls).toBe(2);
    expect(t.session.state).toBe('listening');
  });

  it('speaks the fallback and ends with error-stt when STT cannot connect', async () => {
    const t = setup({ config: { fallback: { message: 'Sorry, please call back later.' } }, stt: { failConnects: 2 } });
    await t.session.start();
    await t.caller.silenceUntil(() => t.session.state === 'ended');
    const summary = await t.session.ended;
    expect(summary.endReason).toBe(EndReason.ErrorStt);
    expect(t.tts.requests.map((r) => r.text)).toEqual(['Sorry, please call back later.']);
  });

  it('reconnects STT once when the stream drops, and fails over on the second drop', async () => {
    const t = setup({ stt: { utterances: ['first question', 'second question'] }, llm: ['Answer one.', 'Answer two.'] });
    await t.session.start();
    t.stt.current!.fail();
    await t.caller.silence(100);
    expect(t.stt.connectCalls).toBe(2);
    await t.caller.speak(400);
    await t.caller.silenceUntil(() => t.session.turns.length === 1);
    expect(t.session.turns[0].userText).toBe('first question');
    t.stt.current!.fail();
    await t.caller.silenceUntil(() => t.session.state === 'ended');
    expect((await t.session.ended).endReason).toBe(EndReason.ErrorStt);
  });

  it('can transfer instead of ending on failure', async () => {
    const t = setup({
      config: {
        tools: { transferCall: { enabled: true, destinations: [{ name: 'support', target: '+15550002222' }] } },
        fallback: { action: 'transfer', transferTo: 'support', message: 'Let me connect you to a person.' },
      },
      stt: { utterances: ['hello'] },
      llm: [{ error: 'before-first-token' }],
    });
    await t.session.start();
    await t.caller.speak(400);
    await t.caller.silenceUntil(() => t.session.state === 'ended');
    const summary = await t.session.ended;
    expect(summary.endReason).toBe(EndReason.ErrorLlm);
    expect(summary.transferredTo).toBe('support');
    expect(t.transport.transfers).toHaveLength(1);
  });
});
