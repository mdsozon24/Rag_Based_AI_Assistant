/**
 * Network helpers for provider adapters.
 *
 * - HttpClient: the small request interface adapters use, so tests can inject canned responses.
 * - fetchHttpClient: global fetch, for first-party vendor APIs.
 * - guardedHttpClient / guardedLookup: for customer-supplied endpoints ("custom" providers).
 *   Only https/wss URLs are allowed, and every resolved address is checked at connect time, so
 *   private, loopback, link-local and cloud-metadata addresses are refused (SSRF protection,
 *   including DNS rebinding between the check and the connect).
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export interface HttpRequestInit {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  text(): Promise<string>;
}

export type HttpClient = (url: string, init: HttpRequestInit) => Promise<HttpResponse>;

export const fetchHttpClient: HttpClient = async (url, init) => {
  const response = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal });
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => (headers[key] = value));
  const body = response.body;
  return {
    status: response.status,
    ok: response.ok,
    headers,
    body: (body ?? (async function* () {})()) as AsyncIterable<Uint8Array>,
    text: () => response.text(),
  };
};

// ---------------------------------------------------------------- SSRF guard

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4],
] as const) {
  blocked.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blocked.addSubnet(address, prefix, 'ipv6');
}

export class EndpointNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EndpointNotAllowedError';
  }
}

/** True if the address is in a private, loopback, link-local, multicast or reserved range. */
export function isBlockedAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1], 'ipv4');
  const family = net.isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) return blocked.check(address, 'ipv6');
  return true;
}

export interface EndpointPolicy {
  /** Allow http/ws and private addresses. Development and tests only. */
  allowPrivateNetwork: boolean;
}

/** Validate a customer endpoint URL before use (scheme, credentials in URL, literal IPs). */
export function checkEndpointUrl(raw: string, schemes: readonly ('https' | 'wss')[], policy: EndpointPolicy): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EndpointNotAllowedError(`Invalid endpoint URL: ${raw}`);
  }
  const scheme = url.protocol.replace(':', '');
  const insecure = scheme === 'http' ? 'https' : scheme === 'ws' ? 'wss' : null;
  const allowedScheme = (schemes as readonly string[]).includes(scheme) || (policy.allowPrivateNetwork && insecure && (schemes as readonly string[]).includes(insecure));
  if (!allowedScheme) throw new EndpointNotAllowedError(`Endpoint must use ${schemes.join(' or ')}: ${url.origin}`);
  if (url.username || url.password) throw new EndpointNotAllowedError('Endpoint URL must not contain credentials; store them as a credential instead');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && !policy.allowPrivateNetwork && isBlockedAddress(host)) {
    throw new EndpointNotAllowedError(`Endpoint address ${host} is in a private or reserved range`);
  }
  return url;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void;

/** dns.lookup replacement that refuses blocked addresses; used at connect time by http(s) and ws. */
export function guardedLookup(policy: EndpointPolicy) {
  return (hostname: string, options: dns.LookupOptions | number | LookupCallback, callback?: LookupCallback): void => {
    const cb = (typeof options === 'function' ? options : callback) as LookupCallback;
    const opts: dns.LookupOptions = typeof options === 'object' && options ? options : {};
    dns.lookup(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return cb(err, '');
      const list = addresses as dns.LookupAddress[];
      const allowed = policy.allowPrivateNetwork ? list : list.filter((a) => !isBlockedAddress(a.address));
      if (allowed.length === 0 || allowed.length !== list.length) {
        const error = new EndpointNotAllowedError(`Endpoint ${hostname} resolves to a private or reserved address`) as NodeJS.ErrnoException;
        error.code = 'EENDPOINTBLOCKED';
        return cb(error, '');
      }
      if (opts.all) cb(null, allowed);
      else cb(null, allowed[0].address, allowed[0].family);
    });
  };
}

/** HttpClient for customer endpoints: https only (unless allowPrivateNetwork), addresses checked on connect. */
export function guardedHttpClient(policy: EndpointPolicy): HttpClient {
  const lookup = guardedLookup(policy);
  return (rawUrl, init) =>
    new Promise<HttpResponse>((resolve, reject) => {
      let url: URL;
      try {
        url = checkEndpointUrl(rawUrl, ['https'], policy);
      } catch (error) {
        return reject(error);
      }
      const transport = url.protocol === 'https:' ? https : http;

      const request = transport.request(
        url,
        { method: init.method, headers: init.headers, lookup: lookup as unknown as net.LookupFunction, signal: init.signal },
        (res) => {
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) if (typeof value === 'string') headers[key] = value;
          const status = res.statusCode ?? 0;
          resolve({
            status,
            ok: status >= 200 && status < 300,
            headers,
            body: res as AsyncIterable<Uint8Array>,
            text: async () => {
              const parts: Buffer[] = [];
              for await (const chunk of res) parts.push(chunk as Buffer);
              return Buffer.concat(parts).toString('utf8');
            },
          });
        }
      );
      request.on('error', reject);
      if (init.body) request.write(init.body);
      request.end();
    });
}

/** Fetch-shaped adapter for API callers that expect JSON from customer-configured endpoints. */
export function guardedFetch(policy: EndpointPolicy) {
  const client = guardedHttpClient(policy);
  return async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') throw new TypeError('Guarded endpoint requests only support GET and POST');
    const response = await client(url, {
      method,
      headers: init.headers ?? {},
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: init.signal ?? new AbortController().signal,
    });
    return { ok: response.ok, status: response.status, json: async () => JSON.parse(await response.text()) as unknown };
  };
}

/** Yield whole 16-bit samples from a byte stream (carries an odd trailing byte forward). */
export async function* alignPcm16(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let carry: Uint8Array | null = null;
  for await (const piece of source) {
    let data = piece instanceof Uint8Array ? piece : new Uint8Array(piece);
    if (carry) {
      const joined = new Uint8Array(carry.length + data.length);
      joined.set(carry, 0);
      joined.set(data, carry.length);
      data = joined;
      carry = null;
    }
    if (data.length % 2 === 1) {
      carry = data.slice(data.length - 1);
      data = data.subarray(0, data.length - 1);
    }
    if (data.length > 0) yield data;
  }
}

/** Parse a server-sent-events byte stream into `data:` payloads. */
export async function* sseData(source: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of source) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary: number;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const event = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) yield data;
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith('data:')) yield tail.slice(5).trim();
}
