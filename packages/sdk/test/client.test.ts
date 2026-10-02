/**
 * VoiceClient against a scripted fake socket and fake audio: protocol, events, controls, errors,
 * reconnect and liveness. Runs in Node (no DOM).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OctoVoiceError, VoiceClient, type AudioIO, type Message, type Role, type SocketLike, type VoiceClientOptions } from '../src/index.ts';
import { micError } from '../src/errors.ts';

class FakeSocket implements SocketLike {
  binaryType = 'blob';
  readyState = 0;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  readonly sent: (Record<string, any> | ArrayBuffer)[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  constructor(readonly url: string) {}
  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(typeof data === 'string' ? JSON.parse(data) : (data as ArrayBuffer));
  }
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.closedWith = { code, reason };
    this.readyState = 3;
  }
  // server side
  accept(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(value: Record<string, unknown> | ArrayBuffer): void {
    this.onmessage?.({ data: value instanceof ArrayBuffer ? value : JSON.stringify(value) });
  }
  drop(code: number, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  get json(): Record<string, any>[] {
    return this.sent.filter((m): m is Record<string, any> => !(m instanceof ArrayBuffer));
  }
}

class FakeAudio implements AudioIO {
  opened = false;
  closed: { drain?: boolean } | null = null;
  muted = false;
  played: number[] = [];
  clears = 0;
  openError: unknown = null;
  frame: ((pcm: ArrayBuffer) => void) | null = null;
  private level: ((level: number, source: Role) => void)[] = [];
  private playback: ((playing: boolean) => void)[] = [];
  async open() {
    if (this.openError) throw micError(this.openError);
    this.opened = true;
  }
  startCapture(onFrame: (pcm16: ArrayBuffer) => void) {
    this.frame = onFrame;
  }
  setMuted(muted: boolean) {
    this.muted = muted;
  }
  play(pcm16: ArrayBuffer) {
    this.played.push(pcm16.byteLength);
  }
  clear() {
    this.clears++;
  }
  async close(options: { drain?: boolean } = {}) {
    this.closed = options;
  }
  onLevel(listener: (level: number, source: Role) => void) {
    this.level.push(listener);
  }
  onPlayback(listener: (playing: boolean) => void) {
    this.playback.push(listener);
  }
  emitLevel(level: number, source: Role) {
    this.level.forEach((l) => l(level, source));
  }
  emitPlayback(playing: boolean) {
    this.playback.forEach((l) => l(playing));
  }
}

const CALL = { id: 'call-1', connectToken: 'connect-token-0123456789', wsUrl: 'wss://api.octo.test/v1/calls/call-1/connect' };
const READY = { type: 'ready', protocol: 1, callId: 'call-1', mode: 'voice', resumeToken: 'resume-1', resumeGraceMs: 2000 };

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 1));
  }
}

function setup(options: Partial<VoiceClientOptions> & { response?: () => Response | Promise<Response> } = {}) {
  const sockets: FakeSocket[] = [];
  const audio = new FakeAudio();
  const requests: { url: string; init: RequestInit }[] = [];
  const client = new VoiceClient({
    publicKey: 'pk_test_123',
    apiUrl: 'https://api.octo.test/',
    audio: () => audio,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return options.response ? options.response() : new Response(JSON.stringify(CALL), { status: 201 });
    }) as typeof fetch,
    reconnect: { initialDelayMs: 1 },
    ...options,
  });
  const events: [string, unknown][] = [];
  for (const name of ['call-start', 'call-end', 'speech-start', 'speech-end', 'message', 'error', 'status'] as const) {
    client.on(name, ((value: unknown) => events.push([name, value])) as never);
  }
  const levels: [number, Role][] = [];
  client.on('volume-level', (level, source) => levels.push([level, source]));
  /** Let the client open socket n, answer hello with ready. */
  const serve = async (n = 0, ready: Record<string, unknown> = READY) => {
    await until(() => sockets.length > n);
    sockets[n].accept();
    sockets[n].receive(ready);
    return sockets[n];
  };
  const of = (name: string) => events.filter(([e]) => e === name).map(([, v]) => v);
  return { client, sockets, audio, requests, events, levels, serve, of };
}

afterEach(() => vi.useRealTimers());

describe('starting a call', () => {
  it('creates the call with the public key, says hello, and goes live', async () => {
    const t = setup();
    const started = t.client.start('assistant-1', { variables: { name: 'Ada' }, overrides: { language: 'bn' } });
    const socket = await t.serve();
    await expect(started).resolves.toEqual({ id: 'call-1', mode: 'voice' });

    expect(t.requests[0].url).toBe('https://api.octo.test/v1/calls');
    expect((t.requests[0].init.headers as Record<string, string>).authorization).toBe('Bearer pk_test_123');
    expect(JSON.parse(t.requests[0].init.body as string)).toEqual({ assistantId: 'assistant-1', variables: { name: 'Ada' }, overrides: { language: 'bn' } });
    expect(socket.url).toBe(CALL.wsUrl);
    expect(socket.binaryType).toBe('arraybuffer');
    expect(socket.json[0]).toEqual({ type: 'hello', protocol: 1, token: CALL.connectToken, mode: 'voice' });
    expect(t.audio.opened).toBe(true);
    expect(t.client.status).toBe('active');
    expect(t.client.callId).toBe('call-1');
    expect(t.of('status')).toEqual(['connecting', 'active']);
    expect(t.of('call-start')).toEqual([{ id: 'call-1', mode: 'voice' }]);
  });

  it('connects a call created by the customer server without calling the API', async () => {
    const t = setup();
    const started = t.client.start({ call: CALL }, { mode: 'chat' });
    const socket = await t.serve(0, { ...READY, mode: 'chat' });
    await started;
    expect(t.requests).toHaveLength(0);
    expect(socket.json[0]).toMatchObject({ type: 'hello', token: CALL.connectToken, mode: 'chat' });
    // Chat mode never touches the microphone
    expect(t.audio.opened).toBe(false);
  });

  it('refuses private keys outright', () => {
    expect(() => new VoiceClient({ publicKey: 'sk_live_secret', apiUrl: 'https://x' })).toThrow(/Private keys/);
  });

  it('needs no key for a server-created call, and a public key to start one by assistant id', async () => {
    const t = setup({ publicKey: undefined });
    const started = t.client.start({ call: CALL }, { mode: 'chat' });
    await t.serve(0, { ...READY, mode: 'chat' });
    await expect(started).resolves.toEqual({ id: 'call-1', mode: 'chat' });
    await t.client.stop();

    const byId = await t.client.start('assistant-1', { mode: 'chat' }).catch((e) => e);
    expect(byId).toBeInstanceOf(OctoVoiceError);
    expect(byId.code).toBe('invalid-key');
    expect(t.requests).toHaveLength(0);
  });

  it('reports a blocked microphone before creating a call', async () => {
    const t = setup();
    t.audio.openError = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    const error = await t.client.start('assistant-1').catch((e) => e);
    expect(error).toBeInstanceOf(OctoVoiceError);
    expect(error.code).toBe('mic-permission-denied');
    expect(error.message).toMatch(/Allow the microphone/);
    expect(t.requests).toHaveLength(0);
    expect(t.of('error')).toEqual([error]);
    expect(t.client.status).toBe('ended');
  });

  it.each([
    [403, { code: 'origin_not_allowed', message: 'x' }, 'origin-not-allowed'],
    [403, { code: 'forbidden', message: 'This public key may not be used for this assistant' }, 'assistant-not-allowed'],
    [403, { code: 'forbidden', message: 'Public browser keys cannot override these fields' }, 'override-not-allowed'],
    [401, { code: 'invalid_api_key', message: 'x' }, 'invalid-key'],
    [429, { code: 'rate_limited', message: 'x' }, 'rate-limited'],
    [500, { code: 'internal_error', message: 'boom' }, 'server-error'],
  ])('maps HTTP %i %j to %s', async (status, body, code) => {
    const t = setup({ response: () => new Response(JSON.stringify(body), { status, headers: { 'x-request-id': 'req-1' } }) });
    const error = await t.client.start('assistant-1').catch((e) => e);
    expect(error.code).toBe(code);
    expect(error.details).toMatchObject({ status, requestId: 'req-1' });
    expect(t.sockets).toHaveLength(0);
  });

  it('reports network failures (offline, CORS) as network errors', async () => {
    const t = setup({ response: () => Promise.reject(new TypeError('Failed to fetch')) });
    expect((await t.client.start('assistant-1').catch((e) => e)).code).toBe('network');
  });

  it.each([
    [4403, 'origin_not_allowed', 'origin-not-allowed'],
    [4401, 'token_expired', 'call-expired'],
    [4429, 'concurrency_limit', 'concurrency-limit'],
    [1006, '', 'network'],
  ])('maps a socket closed with %i %s before ready to %s', async (closeCode, reason, code) => {
    const t = setup();
    const started = t.client.start('assistant-1');
    await until(() => t.sockets.length === 1);
    t.sockets[0].accept();
    t.sockets[0].drop(closeCode, reason);
    expect((await started.catch((e) => e)).code).toBe(code);
    expect(t.audio.closed).toEqual({ drain: false });
  });

  it('refuses a second start while a call is live', async () => {
    const t = setup();
    const started = t.client.start('assistant-1');
    await t.serve();
    await started;
    await expect(t.client.start('assistant-1')).rejects.toThrow(/already in progress/);
  });
});

describe('during a call', () => {
  async function live(options: Parameters<typeof setup>[0] = {}) {
    const t = setup(options);
    const started = t.client.start('assistant-1');
    const socket = await t.serve();
    await started;
    return { ...t, socket };
  }

  it('streams microphone frames and plays agent audio', async () => {
    const t = await live();
    t.audio.frame!(new ArrayBuffer(640));
    expect(t.socket.sent.at(-1)).toBeInstanceOf(ArrayBuffer);
    t.socket.receive(new ArrayBuffer(960));
    expect(t.audio.played).toEqual([960]);
    t.socket.receive({ type: 'clear' });
    expect(t.audio.clears).toBe(1);
  });

  it('turns server events into message, speech and volume events', async () => {
    const t = await live();
    t.socket.receive({ type: 'user-speech', speaking: true, at: 1 });
    t.socket.receive({ type: 'transcript', role: 'user', text: 'আমার অ্যাপয়েন্টমেন্ট', final: false });
    t.socket.receive({ type: 'user-speech', speaking: false, at: 2 });
    t.socket.receive({ type: 'transcript', role: 'user', text: 'আমার অ্যাপয়েন্টমেন্ট দরকার', final: true });
    t.audio.emitPlayback(true);
    t.socket.receive({ type: 'transcript', role: 'assistant', text: 'Sure.', final: true, interrupted: true });
    t.socket.receive({ type: 'interrupted', at: 3, heardText: 'Sure' });
    t.socket.receive({ type: 'tool-call', name: 'endCall', args: { reason: 'done' } });
    t.socket.receive({ type: 'transfer', destination: { name: 'Sales', target: '+8801700000000' } });
    t.socket.receive({ type: 'state', state: 'listening', at: 4 });
    t.audio.emitPlayback(false);
    t.audio.emitLevel(0.5, 'user');

    expect(t.of('message') as Message[]).toEqual([
      { type: 'transcript', role: 'user', text: 'আমার অ্যাপয়েন্টমেন্ট', final: false },
      { type: 'transcript', role: 'user', text: 'আমার অ্যাপয়েন্টমেন্ট দরকার', final: true },
      { type: 'transcript', role: 'assistant', text: 'Sure.', final: true, interrupted: true },
      { type: 'interrupted', heardText: 'Sure' },
      { type: 'tool-call', name: 'endCall', args: { reason: 'done' } },
      { type: 'transfer', destination: { name: 'Sales', target: '+8801700000000' } },
    ]);
    expect(t.events.filter(([e]) => e.startsWith('speech-'))).toEqual([
      ['speech-start', { role: 'user' }],
      ['speech-end', { role: 'user' }],
      ['speech-start', { role: 'assistant' }],
      ['speech-end', { role: 'assistant' }],
    ]);
    expect(t.levels).toEqual([[0.5, 'user']]);
  });

  it('sends typed messages and say requests, and mutes the microphone', async () => {
    const t = await live();
    t.client.send('  Book Tuesday  ');
    t.client.say('One moment');
    t.client.setMuted(true);
    expect(t.socket.json.slice(-2)).toEqual([
      { type: 'message', text: 'Book Tuesday' },
      { type: 'say', text: 'One moment' },
    ]);
    expect(t.audio.muted).toBe(true);
    expect(t.client.isMuted).toBe(true);
    expect(() => t.client.send('   ')).toThrow(/1 to 2000/);
    expect(() => t.client.send('x'.repeat(2001))).toThrow(OctoVoiceError);
  });

  it('stop() hangs up and ends at once, without draining audio', async () => {
    const t = await live();
    await t.client.stop();
    expect(t.socket.json.at(-1)).toEqual({ type: 'hangup' });
    expect(t.socket.closedWith?.code).toBe(1000);
    expect(t.audio.closed).toEqual({ drain: false });
    expect(t.of('call-end')).toEqual([{ reason: 'client-ended' }]);
    expect(t.client.status).toBe('ended');
    expect(() => t.client.send('hello?')).toThrow(/no active call/);
  });

  it('ends with the server reason and lets the goodbye play out', async () => {
    const t = await live();
    t.socket.receive({ type: 'ended', reason: 'assistant-ended', summary: {} });
    t.socket.drop(1000, 'call ended');
    await until(() => t.of('call-end').length === 1);
    expect(t.of('call-end')).toEqual([{ reason: 'assistant-ended' }]);
    expect(t.audio.closed).toEqual({ drain: true });
  });

  it('surfaces server error events without ending the call', async () => {
    const t = await live();
    t.socket.receive({ type: 'error', stage: 'internal', message: 'Too many messages; retry after 30s' });
    expect((t.of('error')[0] as OctoVoiceError).message).toMatch(/Too many messages/);
    expect(t.client.status).toBe('active');
  });
});

describe('reconnect', () => {
  async function live() {
    const t = setup();
    const started = t.client.start('assistant-1');
    await t.serve();
    await started;
    return t;
  }

  it('resumes after a network drop with the resume token, without ending the call', async () => {
    const t = await live();
    t.sockets[0].drop(1006);
    expect(t.client.status).toBe('reconnecting');
    const resumed = await t.serve(1, { ...READY, resumeToken: 'resume-2' });
    expect(resumed.json[0]).toEqual({ type: 'resume', protocol: 1, resumeToken: 'resume-1' });
    await until(() => t.client.status === 'active');
    expect(t.of('call-end')).toEqual([]);
    expect(t.of('status')).toEqual(['connecting', 'active', 'reconnecting', 'active']);

    // The next drop uses the rotated token
    t.sockets[1].drop(1006);
    const again = await t.serve(2);
    expect(again.json[0].resumeToken).toBe('resume-2');
  });

  it('keeps trying while the network is down, then resumes', async () => {
    const t = await live();
    t.sockets[0].drop(1006);
    await until(() => t.sockets.length === 2);
    t.sockets[1].drop(1006); // still offline
    await t.serve(2);
    await until(() => t.client.status === 'active');
  });

  it('ends with connection-lost when the server says the call cannot be resumed', async () => {
    const t = await live();
    t.sockets[0].drop(1006);
    await until(() => t.sockets.length === 2);
    t.sockets[1].accept();
    t.sockets[1].drop(4409, 'call_not_resumable');
    await until(() => t.of('call-end').length === 1);
    expect((t.of('call-end')[0] as { reason: string; error: OctoVoiceError }).error.code).toBe('connection-lost');
  });

  it('gives up when the grace period is over', async () => {
    const t = setup();
    const started = t.client.start('assistant-1');
    await t.serve(0, { ...READY, resumeGraceMs: 40 });
    await started;
    t.sockets[0].drop(1006);
    // Every attempt fails as if offline
    const interval = setInterval(() => t.sockets.forEach((s) => s.readyState !== 3 && s.drop(1006)), 2);
    await until(() => t.of('call-end').length === 1);
    clearInterval(interval);
    expect((t.of('call-end')[0] as { error: OctoVoiceError }).error.code).toBe('connection-lost');
  });

  it('does not reconnect when the server closes on purpose', async () => {
    const t = await live();
    t.sockets[0].drop(4403, 'origin_not_allowed');
    await until(() => t.of('call-end').length === 1);
    expect(t.sockets).toHaveLength(1);
  });

  it('treats a silent connection as dropped (liveness) and resumes', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-01T09:00:00Z'), toFake: ['setInterval', 'clearInterval', 'Date'] });
    const t = await live();
    vi.advanceTimersByTime(5000);
    expect(t.sockets[0].json.at(-1)).toEqual({ type: 'ping' });
    t.sockets[0].receive({ type: 'pong' });
    vi.advanceTimersByTime(5000);
    expect(t.client.status).toBe('active');
    // No traffic at all for more than 10 s
    vi.advanceTimersByTime(11_000);
    expect(t.client.status).toBe('reconnecting');
    expect(t.sockets[0].closedWith?.code).toBe(4999);
    vi.useRealTimers();
    await t.serve(1);
    await until(() => t.client.status === 'active');
  });
});
