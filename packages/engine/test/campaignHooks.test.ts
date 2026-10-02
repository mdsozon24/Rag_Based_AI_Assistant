/** Campaign calls in the engine: opt-out detection (phrase and tool) and outcome reporting. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OPT_OUT_MESSAGE, DEFAULT_OPT_OUT_PHRASES, type CampaignHooks } from '../src/engine/campaign.ts';
import { EndReason } from '../src/engine/endReason.ts';
import { setup, useFakeClock } from './helpers.ts';

beforeEach(() => useFakeClock());
afterEach(() => vi.useRealTimers());

function hooks(overrides: Partial<CampaignHooks> = {}) {
  const optOuts: { source: string; text: string; phrase?: string }[] = [];
  const outcomes: { label: string; notes?: string }[] = [];
  const value: CampaignHooks = {
    optOutPhrases: DEFAULT_OPT_OUT_PHRASES,
    optOutMessage: DEFAULT_OPT_OUT_MESSAGE,
    outcomeLabels: ['interested', 'not-interested', 'callback'],
    onOptOut: (info) => void optOuts.push(info),
    onOutcome: (outcome) => void outcomes.push(outcome),
    ...overrides,
  };
  return { hooks: value, optOuts, outcomes };
}

/** The caller speaks one utterance and the session runs until it ends (or `until` holds). */
async function say(t: ReturnType<typeof setup>, until: () => boolean) {
  await t.session.start();
  await t.caller.silence(600);
  await t.caller.speak(800);
  await t.caller.silenceUntil(until);
}

describe('opt-out by phrase', () => {
  it('records the opt-out, says goodbye without asking the model, and ends the call', async () => {
    const h = hooks();
    const t = setup({ campaign: h.hooks, stt: { utterances: ['Please stop calling me, thanks'] }, llm: ['I should never be asked'] });
    await say(t, () => t.session.state === 'ended');

    expect(h.optOuts).toEqual([{ source: 'phrase', text: 'Please stop calling me, thanks', phrase: 'stop calling' }]);
    expect(t.llm.requests).toHaveLength(0);
    expect(t.tts.requests.map((r) => r.text).join(' ')).toContain('We will not call you again');
    const summary = await t.session.ended;
    expect(summary.endReason).toBe(EndReason.OptOut);
    expect(summary.history.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Please stop calling me, thanks'],
      ['assistant', DEFAULT_OPT_OUT_MESSAGE],
    ]);
  });

  it('is saved before the goodbye is spoken and the call ends', async () => {
    const order: string[] = [];
    const h = hooks({ onOptOut: async () => { await new Promise((r) => setTimeout(r, 300)); order.push('saved'); } });
    const t = setup({ campaign: h.hooks, stt: { utterances: ['do not call me again'] } });
    t.session.onEvent((e) => e.type === 'ended' && order.push('ended'));
    t.tts.requests.push = ((...items) => (order.push('spoke'), Array.prototype.push.apply(t.tts.requests, items))) as typeof t.tts.requests.push;
    await say(t, () => t.session.state === 'ended');
    expect(order[0]).toBe('saved');
    expect(order.at(-1)).toBe('ended');
  });

  it('understands Bangla and ignores case and punctuation', async () => {
    const bangla = hooks();
    const a = setup({ campaign: bangla.hooks, stt: { utterances: ['দয়া করে আমাকে আর কল করবেন না।'] } });
    await say(a, () => a.session.state === 'ended');
    expect(bangla.optOuts[0].phrase).toBe('কল করবেন না');

    const english = hooks();
    const b = setup({ campaign: english.hooks, stt: { utterances: ["DON'T CALL ME!"] } });
    await say(b, () => b.session.state === 'ended');
    expect(english.optOuts[0].phrase).toBe("don't call");
  });

  it('honours campaign-specific phrases', async () => {
    const h = hooks({ optOutPhrases: [...DEFAULT_OPT_OUT_PHRASES, 'leave me alone'] });
    const t = setup({ campaign: h.hooks, stt: { utterances: ['just leave me alone'] } });
    await say(t, () => t.session.state === 'ended');
    expect(h.optOuts[0].phrase).toBe('leave me alone');
  });

  it('does not treat ordinary replies as opt-outs, and does nothing without a campaign', async () => {
    const h = hooks();
    const ordinary = setup({ campaign: h.hooks, stt: { utterances: ['Tell me more about the offer'] }, llm: ['Sure, here is the offer.'] });
    await say(ordinary, () => ordinary.session.turns.length === 1);
    expect(h.optOuts).toEqual([]);
    expect(ordinary.session.state).not.toBe('ended');

    const plain = setup({ stt: { utterances: ['please stop calling me'] }, llm: ['I understand.'] });
    await say(plain, () => plain.session.turns.length === 1);
    expect(plain.llm.requests).toHaveLength(1);
    expect(plain.session.state).not.toBe('ended');
  });

  it('still hangs up if recording the opt-out fails', async () => {
    const h = hooks({ onOptOut: () => Promise.reject(new Error('database down')) });
    const t = setup({ campaign: h.hooks, stt: { utterances: ['stop calling'] } });
    await say(t, () => t.session.state === 'ended');
    expect((await t.session.ended).endReason).toBe(EndReason.OptOut);
  });
});

describe('opt-out and outcome tools', () => {
  it('lets the assistant record an opt-out with the optOut tool, speaking only its own goodbye', async () => {
    const h = hooks();
    const t = setup({ campaign: h.hooks, stt: { utterances: ['I am not interested, take care'] }, llm: [{ text: 'Of course, sorry to bother you. Goodbye.', toolCall: { name: 'optOut' } }] });
    await say(t, () => t.session.state === 'ended');
    expect(h.optOuts).toEqual([{ source: 'tool', text: 'I am not interested, take care' }]);
    expect((await t.session.ended).endReason).toBe(EndReason.OptOut);
    expect(t.tts.requests.map((r) => r.text).join(' ')).not.toContain('We will not call you again');
    expect(t.llm.requests[0].tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['optOut', 'reportOutcome']));
  });

  it('records a configured outcome label and keeps talking', async () => {
    const h = hooks();
    const t = setup({ campaign: h.hooks, stt: { utterances: ['Yes, call me back tomorrow'] }, llm: [{ text: 'Great, I will note that.', toolCall: { name: 'reportOutcome', args: { label: 'callback', notes: 'Wants a call tomorrow' } } }] });
    const events: string[] = [];
    t.session.onEvent((e) => e.type === 'outcome' && events.push(`${e.label}:${e.notes}`));
    await say(t, () => t.session.turns.length === 1);
    expect(h.outcomes).toEqual([{ label: 'callback', notes: 'Wants a call tomorrow' }]);
    expect(events).toEqual(['callback:Wants a call tomorrow']);
    expect(t.session.state).not.toBe('ended');
  });

  it('ignores labels the campaign did not define, and offers no outcome tool without labels', async () => {
    const h = hooks();
    const t = setup({ campaign: h.hooks, stt: { utterances: ['maybe'] }, llm: [{ text: 'Okay.', toolCall: { name: 'reportOutcome', args: { label: 'made-up' } } }] });
    await say(t, () => t.session.turns.length === 1);
    expect(h.outcomes).toEqual([]);

    const none = hooks({ outcomeLabels: [] });
    const u = setup({ campaign: none.hooks, stt: { utterances: ['hello'] }, llm: ['Hi.'] });
    await say(u, () => u.session.turns.length === 1);
    expect(u.llm.requests[0].tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['optOut']));
    expect(u.llm.requests[0].tools.map((tool) => tool.name)).not.toContain('reportOutcome');
  });

  it('waits for a slow outcome hook before reporting the call ended', async () => {
    let saved = false;
    const h = hooks({ onOutcome: async () => { await new Promise((r) => setTimeout(r, 1500)); saved = true; } });
    const t = setup({ campaign: h.hooks, stt: { utterances: ['sounds good, bye'] }, llm: [{ text: 'Wonderful, goodbye.', toolCall: { name: 'reportOutcome', args: { label: 'interested' } } }] });
    await say(t, () => t.session.turns.length === 1);
    const ending = t.session.end(EndReason.CustomerHungUp);
    await vi.advanceTimersByTimeAsync(2000);
    await ending;
    expect(saved).toBe(true);
  });
});
