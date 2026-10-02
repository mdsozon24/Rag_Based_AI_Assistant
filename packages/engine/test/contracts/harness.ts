/**
 * Test plumbing for provider contract tests: a fake HttpClient (no network) and local WebSocket
 * servers that speak each vendor's protocol from fixtures.
 */
import { afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import type { HttpClient, HttpRequestInit } from '../../src/providers/net.ts';

export interface FakeHttpReply {
  status: number;
  /** Body chunks; strings are UTF-8 encoded. */
  chunks: (string | Uint8Array)[];
  /** Delay before each chunk (ms, real time). */
  chunkDelayMs?: number;
}

export interface RecordedRequest {
  url: string;
  init: HttpRequestInit;
  json: Record<string, unknown>;
}

function abortError(): Error {
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

/** HttpClient that answers from `reply` and records requests. Honours the abort signal between chunks. */
export function fakeHttp(reply: (request: RecordedRequest) => FakeHttpReply): { http: HttpClient; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const http: HttpClient = async (url, init) => {
    if (init.signal.aborted) throw abortError();
    const recorded = { url, init, json: init.body ? JSON.parse(init.body) : {} };
    requests.push(recorded);
    const r = reply(recorded);
    const encoder = new TextEncoder();
    const chunks = r.chunks.map((c) => (typeof c === 'string' ? encoder.encode(c) : c));
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: {},
      body: (async function* () {
        for (const chunk of chunks) {
          if (r.chunkDelayMs) await new Promise((res) => setTimeout(res, r.chunkDelayMs));
          if (init.signal.aborted) throw abortError();
          yield chunk;
        }
      })(),
      text: async () => new TextDecoder().decode(Buffer.concat(chunks)),
    };
  };
  return { http, requests };
}

const servers: WebSocketServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

export interface LocalWsServer {
  url: string;
  sockets: WebSocket[];
  received: { data: string | Buffer; binary: boolean }[];
  /** Upgrade request headers of the last connection. */
  headers: Record<string, string | string[] | undefined>;
  path: string;
}

/**
 * Local WebSocket server. `verifyStatus` (if set) rejects the upgrade with that HTTP status
 * (e.g. 401), like an auth failure at the vendor.
 */
export async function localWsServer(
  onConnection: (socket: WebSocket, server: LocalWsServer) => void,
  options: { verifyStatus?: number } = {}
): Promise<LocalWsServer> {
  const state: LocalWsServer = { url: '', sockets: [], received: [], headers: {}, path: '' };
  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    ...(options.verifyStatus ? { verifyClient: (_info: unknown, cb: (ok: boolean, code?: number) => void) => cb(false, options.verifyStatus) } : {}),
  });
  servers.push(wss);
  wss.on('connection', (socket, req) => {
    state.sockets.push(socket);
    state.headers = req.headers;
    state.path = req.url ?? '';
    socket.on('message', (data, binary) => state.received.push({ data: binary ? (data as Buffer) : data.toString(), binary }));
    onConnection(socket, state);
  });
  await new Promise((r) => wss.once('listening', r));
  state.url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
  return state;
}

export async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}
