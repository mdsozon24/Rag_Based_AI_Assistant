/**
 * Server-sent events on a Fastify reply. The reply is hijacked, so the usual onSend hooks do not
 * run: request id and CORS headers are set here. A comment line every 15 s keeps proxies from
 * closing the stream during slow tool calls; `signal` aborts when the client goes away.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface SseStream {
  /** `event: <name>` + JSON data; omit the name for plain `data:` lines (OpenAI style). */
  send(event: string | null, data: unknown): void;
  /** A raw data line, e.g. "[DONE]". */
  raw(data: string): void;
  close(): void;
  readonly signal: AbortSignal;
}

export function openSse(request: FastifyRequest, reply: FastifyReply, options: { corsOrigin?: string | null } = {}): SseStream {
  const controller = new AbortController();
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-request-id': request.id,
    ...(options.corsOrigin ? { 'access-control-allow-origin': options.corsOrigin, 'access-control-expose-headers': 'x-request-id', vary: 'Origin' } : {}),
  });
  let closed = false;
  const heartbeat = setInterval(() => !closed && res.write(': ping\n\n'), 15_000);
  heartbeat.unref?.();
  res.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    if (!res.writableFinished) controller.abort();
  });
  return {
    signal: controller.signal,
    send(event, data) {
      if (closed) return;
      res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
    },
    raw(data) {
      if (!closed) res.write(`data: ${data}\n\n`);
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      res.end();
    },
  };
}
