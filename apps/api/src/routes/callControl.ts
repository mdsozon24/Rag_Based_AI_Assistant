import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { newId } from '../auth/crypto.ts';
import { clientIp } from '../auth/authenticate.ts';
import type { AppContext } from '../context.ts';
import { ApiError } from '../http/errors.ts';
import { idParam, iso, parse } from '../http/validation.ts';
import { audit } from '../services/audit.ts';
import { loadTranscript, transcriptViews } from '../services/analysis/transcript.ts';
import { ANALYSIS_COLUMNS, analysisView, type AnalysisFullRow } from '../services/analysis/view.ts';
import { scope } from './org.ts';
import type { TransferFailureAction, TransferMode } from '../services/liveCalls.ts';

const messageSchema = z.object({ message: z.string().trim().min(1).max(10_000) }).strict();
const contextSchema = z.object({ context: z.string().trim().min(1).max(20_000) }).strict();
const muteSchema = z.object({ muted: z.boolean() }).strict();
const transferSchema = z.object({ destination: z.string().trim().min(1).max(500), mode: z.enum(['cold', 'warm']).default('cold'), summary: z.string().max(5000).optional(), failureAction: z.enum(['return-to-agent', 'take-message', 'end']).default('return-to-agent') }).strict();

interface CallRow { id: string; org_id: string; assistant_id: string | null; assistant_name: string; status: string; direction: string; customer_number: string | null; provider_call_id: string | null; end_reason: string | null; usage: unknown; created_at: Date; started_at: Date | null; ended_at: Date | null; }

async function callRow(tx: { query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }, orgId: string, id: string): Promise<CallRow> {
  const row = (await tx.query<CallRow>('SELECT id, org_id, assistant_id, assistant_name, status, direction, customer_number, provider_call_id, end_reason, usage, created_at, started_at, ended_at FROM call WHERE org_id = $1 AND id = $2', [orgId, id])).rows[0];
  if (!row) throw new ApiError('not_found', 'Call not found');
  return row;
}

export function registerCallControlRoutes(app: FastifyInstance, ctx: AppContext): void {
  async function command(request: any, action: string, input: unknown, run: (handle: NonNullable<ReturnType<typeof ctx.liveCalls.get>>) => Promise<void>) {
    const org = scope(request); const id = idParam(request.params, 'id', 'Call'); const body = input;
    const result = await org.run(async (tx) => { await callRow(tx, org.id, id); const handle = ctx.liveCalls.get(id); if (!handle) throw new ApiError('conflict', 'Call is not live', { reason: 'call_not_running' }); await run(handle); await tx.query('INSERT INTO call_event (id, org_id, call_id, type, payload) VALUES ($1,$2,$3,$4,$5)', [newId(), org.id, id, `control.${action}`, JSON.stringify(body ?? {})]); await audit(tx, { orgId: org.id, actor: org.actor, action: `call.${action}`, targetType: 'call', targetId: id, metadata: typeof body === 'object' && body ? body as Record<string, unknown> : {}, ip: clientIp(request) }); return { id, action }; });
    return result;
  }

  app.post('/v1/calls/:id/say', { config: { permission: 'calls:create' } }, async (request) => command(request, 'say', parse(messageSchema, request.body), (handle) => handle.say((request.body as { message: string }).message)));
  app.post('/v1/calls/:id/context', { config: { permission: 'calls:create' } }, async (request) => command(request, 'context', parse(contextSchema, request.body), (handle) => handle.injectContext((request.body as { context: string }).context)));
  app.post('/v1/calls/:id/mute', { config: { permission: 'calls:create' } }, async (request) => command(request, 'mute', parse(muteSchema, request.body), (handle) => handle.setMuted((request.body as { muted: boolean }).muted)));
  app.post('/v1/calls/:id/end', { config: { permission: 'calls:create' } }, async (request) => command(request, 'end', {}, (handle) => handle.end('api-ended')));
  app.post('/v1/calls/:id/transfer', { config: { permission: 'calls:create' } }, async (request) => { const body = parse(transferSchema, request.body); return command(request, 'transfer', body, (handle) => handle.transfer(body.destination, { mode: body.mode as TransferMode, summary: body.summary, failureAction: body.failureAction as TransferFailureAction })); });

  app.get('/v1/calls/:id', { config: { permission: 'calls:read' } }, async (request) => {
    const org = scope(request); const id = idParam(request.params, 'id', 'Call');
    return org.run(async (tx) => {
      const call = await callRow(tx, org.id, id);
      const events = (await tx.query<{ id: string; type: string; payload: Record<string, unknown>; created_at: Date }>('SELECT id, type, payload, created_at FROM call_event WHERE org_id=$1 AND call_id=$2 ORDER BY created_at, id', [org.id, id])).rows;
      const transcript = await loadTranscript(tx, org.id, id);
      const analysis = (await tx.query<AnalysisFullRow>(`SELECT ${ANALYSIS_COLUMNS} FROM call_analysis WHERE org_id=$1 AND call_id=$2`, [org.id, id])).rows[0];
      return { id: call.id, assistantId: call.assistant_id, assistantName: call.assistant_name, status: call.status, direction: call.direction, customerNumber: call.customer_number, providerCallId: call.provider_call_id, createdAt: iso(call.created_at), startedAt: iso(call.started_at), endedAt: iso(call.ended_at), endReason: call.end_reason, cost: call.usage ?? null, recordingUrl: null, timeline: events.map((event) => ({ id: event.id, type: event.type, payload: event.payload, createdAt: iso(event.created_at) })), transcript: transcriptViews(transcript, call.started_at), analysis: analysisView(analysis) };
    });
  });

  app.get('/v1/calls/:id/live', { websocket: true, config: { permission: 'calls:read' } }, (socket: WebSocket, request: any) => {
    const org = scope(request); const id = idParam(request.params, 'id', 'Call'); const handle = ctx.liveCalls.get(id);
    if (!handle) { socket.send(JSON.stringify({ code: 'call_not_live' })); socket.close(); return; }
    void org.run((tx) => callRow(tx, org.id, id)).catch(() => socket.close());
    const unsubscribe = handle.subscribe((event) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event)); });
    socket.on('close', unsubscribe);
  });
}