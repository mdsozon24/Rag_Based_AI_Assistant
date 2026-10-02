/**
 * Custom-endpoint safety (SSRF guard) and the WebSocket transport.
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { silentLogger } from '../src/logger.ts';
import { CustomTranscriber } from '../src/providers/adapters/customTranscriber.ts';
import { CustomVoice } from '../src/providers/adapters/voices.ts';
import { checkEndpointUrl, guardedFetch, guardedHttpClient, guardedLookup, isBlockedAddress, sseData } from '../src/providers/net.ts';
import { WebSocketTransport } from '../src/transport/webSocket.ts';
import { localWsServer, until } from './contracts/harness.ts';

const ctx = () => ({ callId: 'c', logger: silentLogger, signal: new AbortController().signal });

describe('SSRF guard', () => {
  it.each([
    ['127.0.0.1', true],
    ['10.20.30.40', true],
    ['172.16.5.4', true],
    ['192.168.1.1', true],
    ['169.254.169.254', true], // cloud metadata
    ['100.64.0.1', true],
    ['0.0.0.0', true],
    ['::1', true],
    ['fd12:3456::1', true],
    ['fe80::1', true],
    ['::ffff:192.168.1.1', true],
    ['8.8.8.8', false],
    ['104.18.32.7', false],
    ['2606:4700::6810:84e5', false],
    ['not-an-ip', true],
  ])('isBlockedAddress(%s) = %s', (address, blocked) => {
    expect(isBlockedAddress(address)).toBe(blocked);
  });

  it('requires TLS, refuses credentials in the URL and literal private addresses', () => {
    const strict = { allowPrivateNetwork: false };
    expect(checkEndpointUrl('https://api.example.com/x', ['https'], strict).hostname).toBe('api.example.com');
    expect(() => checkEndpointUrl('http://api.example.com', ['https'], strict)).toThrow(/must use https/);
    expect(() => checkEndpointUrl('ws://api.example.com', ['wss'], strict)).toThrow(/must use wss/);
    expect(() => checkEndpointUrl('https://user:pw@api.example.com', ['https'], strict)).toThrow(/must not contain credentials/);
    expect(() => checkEndpointUrl('https://[::1]:8443/', ['https'], strict)).toThrow(/private or reserved/);
    expect(() => checkEndpointUrl('not a url', ['https'], strict)).toThrow(/Invalid endpoint URL/);
    // Development override
    expect(checkEndpointUrl('http://127.0.0.1:3000', ['https'], { allowPrivateNetwork: true }).port).toBe('3000');
  });

  it('refuses hostnames that resolve to private addresses at connect time (DNS rebinding safe)', async () => {
    const lookup = guardedLookup({ allowPrivateNetwork: false });
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => lookup('localhost', {}, (err) => resolve(err)));
    expect(error?.code).toBe('EENDPOINTBLOCKED');
  });

  it('a custom voice cannot reach a local service unless private networks are allowed', async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.alloc(480));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      // Through a hostname, so the connect-time check is what blocks it
      const blocked = new CustomVoice({ url: `https://localhost:${port}/speak`, policy: { allowPrivateNetwork: false } });
      const run = async (voice: CustomVoice) => {
        let bytes = 0;
        for await (const chunk of voice.stream({ text: 'hi', language: 'en' }, ctx())) bytes += chunk.length;
        return bytes;
      };
      await expect(run(blocked)).rejects.toMatchObject({ stage: 'tts', retryable: false });

      const allowed = new CustomVoice({ url: `http://localhost:${port}/speak`, policy: { allowPrivateNetwork: true } });
      expect(await run(allowed)).toBe(480);
    } finally {
      server.close();
    }
  });

  it('a custom transcriber refuses ws:// and private hosts by default', () => {
    expect(() => new CustomTranscriber({ url: 'ws://stt.example.com', policy: { allowPrivateNetwork: false } })).toThrow(/must use wss/);
    expect(() => new CustomTranscriber({ url: 'wss://10.0.0.5/stt', policy: { allowPrivateNetwork: false } })).toThrow(/private or reserved/);
  });

  it('guardedHttpClient refuses literal private IPs before connecting', async () => {
    const client = guardedHttpClient({ allowPrivateNetwork: false });
    await expect(client('https://192.168.0.10/x', { method: 'POST', headers: {}, signal: new AbortController().signal })).rejects.toThrow(/private or reserved/);
  });

  it('guardedFetch refuses private customer endpoints before connecting', async () => {
    const request = guardedFetch({ allowPrivateNetwork: false });
    await expect(request('https://127.0.0.1/route', { method: 'POST' })).rejects.toThrow(/private or reserved/);
  });

  it('parses server-sent events split across chunks', async () => {
    const parts = ['data: {"a":1}\n', '\ndata: {"b"', ':2}\n\ndata: [DONE]\n\n'];
    const out: string[] = [];
    for await (const d of sseData((async function* () {
      for (const p of parts) yield new TextEncoder().encode(p);
    })()))
      out.push(d);
    expect(out).toEqual(['{"a":1}', '{"b":2}', '[DONE]']);
  });
});

describe('WebSocket transport', () => {
  const clients: WebSocket[] = [];
  afterEach(() => clients.splice(0).forEach((c) => c.close()));

  it('carries binary audio both ways, control messages and hang-up', async () => {
    let transport: WebSocketTransport | undefined;
    const audioIn: number[][] = [];
    let hungUp = false;
    const server = await localWsServer((socket) => {
      transport = new WebSocketTransport(socket, silentLogger);
      transport.start({ onAudio: (chunk) => audioIn.push([...chunk]), onHangup: () => (hungUp = true) });
    });
    const client = new WebSocket(server.url);
    clients.push(client);
    const fromServer: (string | number[])[] = [];
    client.on('message', (data, isBinary) => fromServer.push(isBinary ? [...(data as Buffer)] : data.toString()));
    await new Promise((r) => client.once('open', r));
    await until(() => transport !== undefined);

    client.send(Uint8Array.from([1, 2, 3, 4]));
    await until(() => audioIn.length === 1);
    expect(audioIn[0]).toEqual([1, 2, 3, 4]);

    transport!.sendAudio(Uint8Array.from([9, 8]));
    transport!.clearAudio();
    transport!.sendEvent({ type: 'state', state: 'listening', at: 1 });
    await until(() => fromServer.length === 3);
    expect(fromServer).toEqual([[9, 8], '{"type":"clear"}', '{"type":"state","state":"listening","at":1}']);

    client.send(JSON.stringify({ type: 'hangup' }));
    await until(() => hungUp);
  });
});
