import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { newId } from '../auth/crypto.ts';
import { clientIp } from '../auth/authenticate.ts';
import type { AppContext } from '../context.ts';
import { ApiError } from '../http/errors.ts';
import { cursorClause, idParam, iso, pageRequest, parse, toPage } from '../http/validation.ts';
import { countryFromE164, e164Schema } from '../../../../packages/engine/src/telephony/numbers.ts';
import { audit } from '../services/audit.ts';
import { getAssistant, getVersion } from '../services/assistants.ts';
import { scope } from './org.ts';

interface PhoneRow {
  id: string; cursor_ts: string; org_id: string; provider: 'twilio' | 'telnyx' | 'vonage' | 'sip'; provider_number_id: string;
  e164: string; country: string; capabilities: string[]; assistant_id: string | null; squad_id: string | null;
  fallback_destination: string | null; credential_id: string | null; routing_url: string | null; routing_timeout_ms: number;
  status: 'active' | 'released'; created_at: Date; updated_at: Date;
}
const COLUMNS = 'id, created_at::text AS cursor_ts, org_id, provider, provider_number_id, e164, country, capabilities, assistant_id, squad_id, fallback_destination, credential_id, routing_url, routing_timeout_ms, status, created_at, updated_at';
const providerSchema = z.enum(['twilio', 'telnyx', 'vonage', 'sip']);
export function inboundWebhookEnabled(provider: string, environment: string, twilioSecret?: string): boolean {
  return environment !== 'production' || (provider === 'twilio' && Boolean(twilioSecret));
}
const numberFields = z.object({
  provider: providerSchema,
  e164: e164Schema,
  providerNumberId: z.string().min(1).max(200).optional(),
  credentialId: z.string().uuid().optional(),
  assistantId: z.string().uuid().optional(),
  squadId: z.string().uuid().optional(),
  fallbackDestination: e164Schema.optional(),
  routingUrl: z.string().url().optional(),
  routingTimeoutMs: z.number().int().min(100).max(10_000).default(1500),
  capabilities: z.array(z.enum(['voice', 'sms'])).max(2).default(['voice']),
}).strict();
const updateSchema = numberFields.partial();

const view = (row: PhoneRow) => ({ id: row.id, provider: row.provider, providerNumberId: row.provider_number_id, e164: row.e164, country: row.country, capabilities: row.capabilities, assistantId: row.assistant_id, squadId: row.squad_id, fallbackDestination: row.fallback_destination, credentialId: row.credential_id, routingUrl: row.routing_url, routingTimeoutMs: row.routing_timeout_ms, status: row.status, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });

async function activeCalls(tx: { query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }, orgId: string): Promise<number> {
  return (await tx.query<{ count: string }>(`SELECT count(*)::text AS count FROM call WHERE org_id = $1 AND status IN ('queued', 'ringing', 'in-progress')`, [orgId])).rows[0] ? Number((await tx.query<{ count: string }>(`SELECT count(*)::text AS count FROM call WHERE org_id = $1 AND status IN ('queued', 'ringing', 'in-progress')`, [orgId])).rows[0].count) : 0;
}

export function registerPhoneNumberRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/v1/phone-numbers/import', { config: { permission: 'assistants:manage' } }, async (request, reply) => {
    const org = scope(request); const body = parse(numberFields, request.body); const adapter = ctx.telephony.adapters[body.provider];
    const imported = await adapter.importNumber(body.e164, {}); const id = newId();
    const row = await org.run(async (tx) => {
      await tx.query(`INSERT INTO phone_number (id, org_id, provider, provider_number_id, e164, country, capabilities, assistant_id, squad_id, fallback_destination, credential_id, routing_url, routing_timeout_ms) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [id, org.id, body.provider, body.providerNumberId ?? imported.providerNumberId, body.e164, countryFromE164(body.e164), body.capabilities.length ? body.capabilities : imported.capabilities, body.assistantId ?? null, body.squadId ?? null, body.fallbackDestination ?? null, body.credentialId ?? null, body.routingUrl ?? null, body.routingTimeoutMs]);
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'phone_number.imported', targetType: 'phone_number', targetId: id, metadata: { e164: body.e164, provider: body.provider }, ip: clientIp(request) });
      return (await tx.query<PhoneRow>(`SELECT ${COLUMNS} FROM phone_number WHERE org_id=$1 AND id=$2`, [org.id, id])).rows[0];
    });
    return reply.code(201).send(view(row));
  });

  app.post('/v1/phone-numbers/buy', { config: { permission: 'assistants:manage' } }, async (request, reply) => {
    const org = scope(request); const body = parse(z.object({ provider: providerSchema, country: z.string().regex(/^[A-Z]{2}$/), assistantId: z.string().uuid().optional(), squadId: z.string().uuid().optional(), fallbackDestination: e164Schema.optional() }).strict(), request.body); const bought = await ctx.telephony.adapters[body.provider].buyNumber(body.country, {}); const id = newId();
    const row = await org.run(async (tx) => { await tx.query(`INSERT INTO phone_number (id, org_id, provider, provider_number_id, e164, country, capabilities, assistant_id, squad_id, fallback_destination) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, org.id, body.provider, bought.providerNumberId, bought.e164, body.country, bought.capabilities, body.assistantId ?? null, body.squadId ?? null, body.fallbackDestination ?? null]); return (await tx.query<PhoneRow>(`SELECT ${COLUMNS} FROM phone_number WHERE org_id=$1 AND id=$2`, [org.id, id])).rows[0]; });
    return reply.code(201).send(view(row));
  });

  app.get('/v1/phone-numbers', { config: { permission: 'assistants:read' } }, async (request) => { const org = scope(request); const page = pageRequest(request.query); const cursor = cursorClause(page, 3); const rows = await org.run(async (tx) => (await tx.query<PhoneRow>(`SELECT ${COLUMNS} FROM phone_number WHERE org_id=$1${cursor.sql} ORDER BY created_at DESC,id DESC LIMIT $2`, [org.id, page.limit + 1, ...cursor.params])).rows); return toPage(rows, page.limit, view); });
  app.get('/v1/phone-numbers/:id', { config: { permission: 'assistants:read' } }, async (request) => { const org = scope(request); const id = idParam(request.params, 'id', 'Phone number'); const row = await org.run(async (tx) => (await tx.query<PhoneRow>(`SELECT ${COLUMNS} FROM phone_number WHERE org_id=$1 AND id=$2`, [org.id, id])).rows[0]); if (!row) throw new ApiError('not_found', 'Phone number not found'); return view(row); });
  app.patch('/v1/phone-numbers/:id', { config: { permission: 'assistants:manage' } }, async (request) => { const org = scope(request); const id = idParam(request.params, 'id', 'Phone number'); const patch = parse(updateSchema, request.body); const row = await org.run(async (tx) => { const current = (await tx.query<PhoneRow>(`SELECT ${COLUMNS} FROM phone_number WHERE org_id=$1 AND id=$2 FOR UPDATE`, [org.id, id])).rows[0]; if (!current) throw new ApiError('not_found', 'Phone number not found'); await tx.query(`UPDATE phone_number SET assistant_id=$3, squad_id=$4, fallback_destination=$5, routing_url=$6, routing_timeout_ms=$7, capabilities=$8, updated_at=now() WHERE org_id=$1 AND id=$2`, [org.id, id, patch.assistantId ?? current.assistant_id, patch.squadId ?? current.squad_id, patch.fallbackDestination ?? current.fallback_destination, patch.routingUrl ?? current.routing_url, patch.routingTimeoutMs ?? current.routing_timeout_ms, patch.capabilities ?? current.capabilities]); return (await tx.query<PhoneRow>(`SELECT ${COLUMNS} FROM phone_number WHERE org_id=$1 AND id=$2`, [org.id, id])).rows[0]; }); return view(row); });
  app.delete('/v1/phone-numbers/:id', { config: { permission: 'assistants:manage' } }, async (request, reply) => { const org = scope(request); const id = idParam(request.params, 'id', 'Phone number'); await org.run(async (tx) => { const result = await tx.query('UPDATE phone_number SET status=\'released\', updated_at=now() WHERE org_id=$1 AND id=$2 AND status=\'active\'', [org.id, id]); if (!result.rowCount) throw new ApiError('not_found', 'Phone number not found'); }); return reply.code(204).send(); });
}

export function registerTelephonyRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/v1/telephony/:provider/webhook', { config: { auth: 'none' } }, async (request, reply) => {
    const provider = providerSchema.parse((request.params as { provider: string }).provider); const adapter = ctx.telephony.adapters[provider]; const body = (request.body ?? {}) as Record<string, unknown>; const to = String(body.To ?? body.to ?? ''); const from = String(body.From ?? body.from ?? '');
    if (!inboundWebhookEnabled(provider, ctx.config.env, ctx.config.twilioWebhookSecret)) throw new ApiError('not_found', 'Route not found');
    if (!e164Schema.safeParse(to).success || !e164Schema.safeParse(from).success) throw new ApiError('validation_error', 'Invalid phone number', { issues: [{ path: 'To/From', message: 'Both numbers must be E.164, including +880 Bangladesh numbers' }] });
    const valid = adapter.verifyWebhookSignature(`${ctx.config.publicUrl}${request.url}`, Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, String(value)])), body, ctx.config.twilioWebhookSecret ?? '');
    if (!valid) throw new ApiError('unauthorized', 'Invalid telephony webhook signature');
    const lookup = await ctx.db.query<PhoneRow>(`SELECT ${COLUMNS} FROM phone_number WHERE e164=$1 AND provider=$2 AND status='active'`, [to, provider]); const phone = lookup.rows[0]; if (!phone) throw new ApiError('not_found', 'Phone number not found');
    const result = await ctx.tenants.withOrg(phone.org_id, async (tx) => {
      const current = await activeCalls(tx, phone.org_id); if (current >= ctx.telephony.maxConcurrentCalls) throw new ApiError('conflict', 'Organization concurrency limit reached', { reason: 'concurrency_limit' });
      let assistantId = phone.assistant_id; let hookVariables = (body.variables ?? {}) as Record<string, string>;
      if (!assistantId && phone.squad_id) {
        const entry = (await tx.query<{ assistant_id: string | null; inline_config: Record<string, unknown> | null }>('SELECT assistant_id, inline_config FROM squad_member WHERE org_id=$1 AND squad_id=$2 ORDER BY position LIMIT 1', [phone.org_id, phone.squad_id])).rows[0];
        assistantId = entry?.assistant_id ?? null;
        if (!assistantId && entry?.inline_config) throw new ApiError('conflict', 'Inline squad entry needs a live squad runtime');
      }
      if (phone.routing_url) {
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), phone.routing_timeout_ms);
        try {
          const hook = await ctx.fetch(phone.routing_url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-octo-call-id': String(body.CallSid ?? '') }, body: JSON.stringify({ from, to, providerCallId: body.CallSid ?? null }), signal: controller.signal });
          if (hook.ok) { const decision = await hook.json() as { assistantId?: string; variables?: Record<string, string> }; assistantId = decision.assistantId ?? assistantId; hookVariables = decision.variables ?? hookVariables; }
        } catch { /* The configured number assignment is the documented fallback. */ }
        finally { clearTimeout(timer); }
      }
      if (!assistantId) throw new ApiError('conflict', 'Phone number has no assistant assignment'); const assistant = await getAssistant(tx, phone.org_id, assistantId); if (!assistant.published_version) throw new ApiError('conflict', 'Assigned assistant has no published version'); const version = await getVersion(tx, phone.org_id, assistantId, assistant.published_version); const callId = newId(); const providerCallId = String(body.CallSid ?? body.callSid ?? callId);
      await tx.query(`INSERT INTO call (id,org_id,type,test,assistant_id,assistant_version_id,squad_id,config_source,assistant_name,config,config_schema,variable_values,status,created_by_type,provider_call_id,customer_number,direction,phone_number_id) VALUES ($1,$2,$3,false,$4,$5,$6,'published',$7,$8,1,$9,'ringing','system',$10,$11,'inbound',$12)`, [callId, phone.org_id, provider === 'sip' ? 'sip' : 'inbound', assistantId, version.id, phone.squad_id, assistant.name, JSON.stringify(version.config), JSON.stringify(hookVariables), providerCallId, from, phone.id]);
      ctx.metrics.callsStarted.inc({ type: provider === 'sip' ? 'sip' : 'inbound', direction: 'inbound' });
      return { callId, streamUrl: `${ctx.config.publicUrl.replace(/^http/, 'ws')}/v1/telephony/${provider}/media/${callId}` };
    });
    reply.type('text/xml').send(adapter.inboundResponse(result.streamUrl));
  });

  app.post('/v1/telephony/outbound', { config: { permission: 'calls:create' } }, async (request, reply) => {
    const org = scope(request); const body = parse(z.object({ phoneNumberId: z.string().uuid(), customerNumber: e164Schema, assistantId: z.string().uuid().optional(), squadId: z.string().uuid().optional(), variables: z.record(z.string()).default({}), voicemailMessage: z.string().max(1000).optional() }).strict(), request.body); const row = await org.run(async (tx) => (await tx.query<PhoneRow>(`SELECT ${COLUMNS} FROM phone_number WHERE org_id=$1 AND id=$2 AND status='active'`, [org.id, body.phoneNumberId])).rows[0]); if (!row) throw new ApiError('not_found', 'Phone number not found');
    const current = await org.run((tx) => activeCalls(tx, org.id)); if (current >= ctx.telephony.maxConcurrentCalls) throw new ApiError('conflict', 'Organization concurrency limit reached', { reason: 'concurrency_limit' }); const targetAssistantId = body.assistantId ?? (await org.run(async (tx) => (await tx.query<{ assistant_id: string | null }>('SELECT assistant_id FROM squad_member WHERE org_id=$1 AND squad_id=$2 ORDER BY position LIMIT 1', [org.id, body.squadId ?? row.squad_id])).rows[0]?.assistant_id)); if (!targetAssistantId) throw new ApiError('conflict', 'Outbound squad needs a saved first assistant member'); const assistant = await org.run((tx) => getAssistant(tx, org.id, targetAssistantId)); if (!assistant.published_version) throw new ApiError('conflict', 'Assistant has no published version'); const version = await org.run((tx) => getVersion(tx, org.id, targetAssistantId, assistant.published_version as number)); const callId = newId(); const streamUrl = `${ctx.config.publicUrl.replace(/^http/, 'ws')}/v1/telephony/${row.provider}/media/${callId}`; const outbound = await ctx.telephony.adapters[row.provider].startOutbound({ to: body.customerNumber, from: { id: row.id, provider: row.provider, providerNumberId: row.provider_number_id, e164: row.e164, capabilities: row.capabilities }, streamUrl, voicemailDetection: true }, {});
    await org.run((tx) => tx.query(`INSERT INTO call (id,org_id,type,test,assistant_id,assistant_version_id,squad_id,config_source,assistant_name,config,config_schema,variable_values,status,created_by_type,provider_call_id,customer_number,direction,phone_number_id) VALUES ($1,$2,'outbound',false,$3,$4,$5,'published',$6,$7,1,$8,'ringing',$9,$10,$11,'outbound',$12)`, [callId, org.id, targetAssistantId, version.id, body.squadId ?? row.squad_id, assistant.name, JSON.stringify(version.config), JSON.stringify(body.variables), org.actor.type, outbound.providerCallId, body.customerNumber, row.id]));
    ctx.metrics.callsStarted.inc({ type: 'outbound', direction: 'outbound' });
    return reply.code(201).send({ id: callId, providerCallId: outbound.providerCallId, status: outbound.status, voicemailDetected: outbound.status === 'ended', voicemailMessage: outbound.status === 'ended' ? body.voicemailMessage ?? null : null });
  });
}