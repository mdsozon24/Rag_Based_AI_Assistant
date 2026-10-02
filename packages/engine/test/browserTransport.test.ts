import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { silentLogger } from '../src/logger.ts';
import { BrowserTransport, parseClientControl, type ClientControl } from '../src/transport/browser.ts';
import { localWsServer, until } from './contracts/harness.ts';

const clients: WebSocket[] = [];
afterEach(() => clients.splice(0).forEach((c) => c.terminate()));

async function connect(url: string) {
  const client = new WebSocket(url);
  clients.push(client);
  const received: (string | number[])[] = [];
  client.on('message', (data, isBinary) => received.push(isBinary ? [...(data as Buffer)] : data.toString()));
  await new Promise((r) => client.once('open', r));
  return { client, received };
}

/** A server whose sockets are handed to the test, plus a transport the test attaches them to. */
async function harness(options: { resumeGraceMs?: number; heartbeatMs?: number } = {}) {
  const sockets: WebSocket[] = [];
  const server = await localWsServer((socket) => sockets.push(socket));
  const control: ClientControl[] = [];
  const connection: boolean[] = [];
  const audio: number[][] = [];
  let hungUp = 0;
  const transport = new BrowserTransport({
    logger: silentLogger,
    resumeGraceMs: options.resumeGraceMs ?? 300,
    heartbeatMs: options.heartbeatMs ?? 0,
    onControl: (message) => control.push(message),
    onConnectionChange: (connected) => connection.push(connected),
  });
  transport.start({ onAudio: (chunk) => audio.push([...chunk]), onHangup: () => hungUp++ });
  const attachNext = async (ready: Record<string, unknown>) => {
    const peer = await connect(server.url);
    await until(() => sockets.length > 0);
    transport.attach(sockets.shift() as WebSocket, ready);
    return peer;
  };
  return { transport, control, connection, audio, attachNext, hungUp: () => hungUp };
}

describe('client control messages', () => {
  it('accepts only valid v1 messages', () => {
    expect(parseClientControl('{"type":"message","text":"  hi  "}')).toEqual({ type: 'message', text: 'hi' });
    expect(parseClientControl('{"type":"say","text":"hello"}')).toEqual({ type: 'say', text: 'hello' });
    expect(parseClientControl('{"type":"hangup"}')).toEqual({ type: 'hangup' });
    expect(parseClientControl('{"type":"message","text":""}')).toBeNull();
    expect(parseClientControl(JSON.stringify({ type: 'message', text: 'x'.repeat(2001) }))).toBeNull();
    expect(parseClientControl('{"type":"transfer","to":"+8801"}')).toBeNull();
    expect(parseClientControl('not json')).toBeNull();
  });
});

describe('BrowserTransport', () => {
  it('sends ready first, carries audio and control both ways', async () => {
    const t = await harness();
    const { client, received } = await t.attachNext({ type: 'ready', protocol: 1 });
    client.send(Uint8Array.from([1, 2, 3, 4]));
    client.send(JSON.stringify({ type: 'message', text: 'typed' }));
    client.send(JSON.stringify({ type: 'ping' }));
    await until(() => t.audio.length === 1 && t.control.length === 1 && received.length >= 2);
    expect(t.audio[0]).toEqual([1, 2, 3, 4]);
    expect(t.control).toEqual([{ type: 'message', text: 'typed' }]);

    t.transport.sendAudio(Uint8Array.from([9, 8]));
    t.transport.clearAudio();
    await until(() => received.length === 4);
    expect(received).toEqual(['{"type":"ready","protocol":1}', '{"type":"pong"}', [9, 8], '{"type":"clear"}']);

    client.send(JSON.stringify({ type: 'hangup' }));
    await until(() => t.hungUp() === 1);
  });

  it('keeps the call through a short drop and replays events missed meanwhile', async () => {
    const t = await harness({ resumeGraceMs: 1000 });
    const first = await t.attachNext({ type: 'ready', n: 1 });
    first.client.terminate();
    await until(() => t.connection.length === 2);
    t.transport.sendEvent({ type: 'transcript', role: 'assistant', text: 'while away', final: true });
    t.transport.sendAudio(Uint8Array.from([7])); // dropped: nobody is listening

    const second = await t.attachNext({ type: 'ready', n: 2 });
    await until(() => second.received.length === 2);
    expect(second.received).toEqual(['{"type":"ready","n":2}', '{"type":"transcript","role":"assistant","text":"while away","final":true}']);
    await new Promise((r) => setTimeout(r, 1200));
    expect(t.hungUp()).toBe(0);
    expect(t.connection).toEqual([true, false, true]);
  });

  it('hangs up when the client does not come back within the grace period', async () => {
    const t = await harness({ resumeGraceMs: 150 });
    const { client } = await t.attachNext({ type: 'ready' });
    client.terminate();
    await until(() => t.hungUp() === 1, 2000);
  });

  it('treats a normal close as a hang-up, without waiting', async () => {
    const t = await harness({ resumeGraceMs: 60_000 });
    const { client } = await t.attachNext({ type: 'ready' });
    client.close(1000);
    await until(() => t.hungUp() === 1);
  });

  it('replaces the old socket when the client resumes on a new one', async () => {
    const t = await harness({ resumeGraceMs: 1000 });
    const first = await t.attachNext({ type: 'ready', n: 1 });
    const closed = new Promise<number>((r) => first.client.once('close', (code) => r(code)));
    await t.attachNext({ type: 'ready', n: 2 });
    expect(await closed).toBe(4000);
    expect(t.hungUp()).toBe(0);
  });

  it('drops a client that stops answering heartbeats', async () => {
    const t = await harness({ resumeGraceMs: 100, heartbeatMs: 50 });
    const { client } = await t.attachNext({ type: 'ready' });
    // ws answers pings automatically; pausing the socket stops it reading them
    (client as unknown as { _socket: { pause(): void } })._socket.pause();
    await until(() => t.hungUp() === 1, 3000);
  });

  it('closes the client socket with 1000 when the call ends', async () => {
    const t = await harness();
    const { client } = await t.attachNext({ type: 'ready' });
    const closed = new Promise<number>((r) => client.once('close', (code) => r(code)));
    t.transport.close();
    expect(await closed).toBe(1000);
    expect(t.hungUp()).toBe(0);
  });
});
