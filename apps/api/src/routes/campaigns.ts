/**
 * Campaigns API: campaigns, contact uploads, controls, results, the do-not-call list, and the
 * provider's call-progress callback. Endpoint reference: docs/API.md ("Campaigns").
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clientIp } from '../auth/authenticate.ts';
import type { AppContext } from '../context.ts';
import { ApiError } from '../http/errors.ts';
import { cursorClause, idParam, iso, pageRequest, parse, toPage } from '../http/validation.ts';
import { audit } from '../services/audit.ts';
import { applyProviderEvent } from '../services/campaigns/attempts.ts';
import { campaignPatchSchema, campaignSchema, campaignView, controlCampaign, createCampaign, deleteCampaign, getCampaign, updateCampaign, CAMPAIGN_SELECT, type CampaignRow, type Control } from '../services/campaigns/campaigns.ts';
import { normalizeNumber } from '../services/campaigns/contacts.ts';
import { addToDnc, removeFromDnc } from '../services/campaigns/dnc.ts';
import { importContacts, importSchema } from '../services/campaigns/importer.ts';
import { parseProviderEvent } from '../services/campaigns/outcome.ts';
import { providerUsable } from '../services/campaigns/providers.ts';
import { campaignStats, CONTACT_COLUMNS, contactView, exportCsv, type ContactRowFull } from '../services/campaigns/results.ts';
import { scope } from './org.ts';

const providerSchema = z.enum(['twilio', 'telnyx', 'vonage', 'sip']);
const CONTACT_STATUS = z.enum(['pending', 'calling', 'completed', 'failed', 'do_not_call', 'cancelled', 'expired']);
const CAMPAIGN_STATUS = z.enum(['draft', 'running', 'paused', 'completed', 'cancelled']);
/** CSV text in JSON: a few thousand contacts is well under 1 MB, but allow wide variable columns. */
const UPLOAD_BODY_LIMIT = 9 * 1024 * 1024;

interface DncRow {
  id: string;
  cursor_ts: string;
  e164: string;
  source: string;
  reason: string | null;
  campaign_id: string | null;
  call_id: string | null;
  created_at: Date;
}

const dncView = (row: DncRow) => ({ number: row.e164, source: row.source, reason: row.reason, campaignId: row.campaign_id, callId: row.call_id, createdAt: iso(row.created_at) });

export function registerCampaignRoutes(app: FastifyInstance, ctx: AppContext): void {
  const cap = ctx.config.campaigns.hardCap;
  const view = (row: CampaignRow) => campaignView(row, cap);

  // ---------------------------------------------------------------- campaigns

  app.post('/v1/campaigns', { config: { permission: 'campaigns:manage', idempotent: true } }, async (request, reply) => {
    const org = scope(request);
    const input = parse(campaignSchema, request.body);
    const row = await org.run(async (tx) => {
      const created = await createCampaign(tx, org.id, org.actor, input, cap);
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'campaign.created', targetType: 'campaign', targetId: created.id, metadata: { name: created.name }, ip: clientIp(request) });
      return created;
    });
    return reply.code(201).send(view(row));
  });

  app.get('/v1/campaigns', { config: { permission: 'campaigns:read' } }, async (request) => {
    const org = scope(request);
    const page = pageRequest(request.query);
    const { status } = parse(z.object({ status: CAMPAIGN_STATUS.optional() }), request.query);
    const cursor = cursorClause(page, status ? 4 : 3, 'c');
    const rows = await org.run(async (tx) =>
      (await tx.query<CampaignRow>(`${CAMPAIGN_SELECT} WHERE c.org_id = $1${status ? ' AND c.status = $3' : ''}${cursor.sql} ORDER BY c.created_at DESC, c.id DESC LIMIT $2`, [org.id, page.limit + 1, ...(status ? [status] : []), ...cursor.params])).rows
    );
    return toPage(rows, page.limit, view);
  });

  app.get('/v1/campaigns/:id', { config: { permission: 'campaigns:read' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Campaign');
    return view(await org.run((tx) => getCampaign(tx, org.id, id)));
  });

  app.patch('/v1/campaigns/:id', { config: { permission: 'campaigns:manage' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Campaign');
    const patch = parse(campaignPatchSchema, request.body);
    const row = await org.run(async (tx) => {
      const updated = await updateCampaign(tx, org.id, id, patch, cap);
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'campaign.updated', targetType: 'campaign', targetId: id, metadata: { fields: Object.keys(patch) }, ip: clientIp(request) });
      return updated;
    });
    return view(row);
  });

  app.delete('/v1/campaigns/:id', { config: { permission: 'campaigns:manage' } }, async (request, reply) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Campaign');
    await org.run(async (tx) => {
      await deleteCampaign(tx, org.id, id);
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'campaign.deleted', targetType: 'campaign', targetId: id, ip: clientIp(request) });
    });
    return reply.code(204).send();
  });

  for (const control of ['start', 'pause', 'resume', 'cancel'] as const satisfies readonly Control[]) {
    app.post(`/v1/campaigns/:id/${control}`, { config: { permission: 'campaigns:manage' } }, async (request) => {
      const org = scope(request);
      const id = idParam(request.params, 'id', 'Campaign');
      const row = await org.run(async (tx) => {
        const updated = await controlCampaign(tx, org.id, id, control, ctx.campaigns.now());
        await audit(tx, { orgId: org.id, actor: org.actor, action: `campaign.${control}`, targetType: 'campaign', targetId: id, ip: clientIp(request) });
        return updated;
      });
      return view(row);
    });
  }

  // ---------------------------------------------------------------- contacts

  app.post('/v1/campaigns/:id/contacts', { bodyLimit: UPLOAD_BODY_LIMIT, config: { permission: 'campaigns:manage' } }, async (request, reply) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Campaign');
    const body = parse(importSchema, request.body);
    const report = await org.run(async (tx) => {
      const campaign = await getCampaign(tx, org.id, id, { lock: true });
      const result = await importContacts(tx, org.id, campaign, body, { maxUploadRows: ctx.config.campaigns.maxUploadRows, maxContacts: ctx.config.campaigns.maxContacts });
      if (!body.dryRun) await audit(tx, { orgId: org.id, actor: org.actor, action: 'campaign.contacts_imported', targetType: 'campaign', targetId: id, metadata: { imported: result.imported, rejected: result.rejectedCount }, ip: clientIp(request) });
      return result;
    });
    return reply.code(body.dryRun ? 200 : 201).send(report);
  });

  app.get('/v1/campaigns/:id/contacts', { config: { permission: 'campaigns:read' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Campaign');
    const page = pageRequest(request.query);
    const { status } = parse(z.object({ status: CONTACT_STATUS.optional() }), request.query);
    const cursor = cursorClause(page, status ? 5 : 4);
    const rows = await org.run(async (tx) => {
      await getCampaign(tx, org.id, id);
      return (await tx.query<ContactRowFull>(`SELECT ${CONTACT_COLUMNS} FROM campaign_contact WHERE org_id = $1 AND campaign_id = $2${status ? ' AND status = $4' : ''}${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT $3`, [org.id, id, page.limit + 1, ...(status ? [status] : []), ...cursor.params])).rows;
    });
    return toPage(rows, page.limit, contactView);
  });

  // ---------------------------------------------------------------- results

  app.get('/v1/campaigns/:id/stats', { config: { permission: 'campaigns:read' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Campaign');
    return org.run(async (tx) => {
      const campaign = await getCampaign(tx, org.id, id);
      return campaignStats(tx, org.id, id, campaign.success_labels, campaign.status);
    });
  });

  app.get('/v1/campaigns/:id/export.csv', { config: { permission: 'campaigns:read' } }, async (request, reply) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Campaign');
    const csv = await org.run(async (tx) => {
      await getCampaign(tx, org.id, id);
      return exportCsv(tx, org.id, id, ctx.config.campaigns.maxContacts);
    });
    return reply.type('text/csv; charset=utf-8').header('content-disposition', `attachment; filename="campaign-${id}.csv"`).send(csv);
  });

  // ---------------------------------------------------------------- do-not-call list

  app.get('/v1/do-not-call', { config: { permission: 'campaigns:read' } }, async (request) => {
    const org = scope(request);
    const page = pageRequest(request.query);
    const cursor = cursorClause(page, 3);
    const rows = await org.run(async (tx) =>
      (await tx.query<DncRow>(`SELECT id, created_at::text AS cursor_ts, e164, source, reason, campaign_id, call_id, created_at FROM do_not_call WHERE org_id = $1${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT $2`, [org.id, page.limit + 1, ...cursor.params])).rows
    );
    return toPage(rows, page.limit, dncView);
  });

  app.post('/v1/do-not-call', { config: { permission: 'campaigns:manage' } }, async (request) => {
    const org = scope(request);
    const body = parse(
      z.object({ numbers: z.array(z.string().max(40)).min(1).max(1000), reason: z.string().trim().max(500).optional(), defaultCountry: z.string().regex(/^[A-Z]{2}$/).optional() }).strict(),
      request.body
    );
    const valid = new Set<string>();
    const invalid: { value: string; reason: string }[] = [];
    for (const raw of body.numbers) {
      const normalized = normalizeNumber(raw, body.defaultCountry);
      if ('error' in normalized) invalid.push({ value: raw, reason: normalized.error });
      else valid.add(normalized.number);
    }
    const result = await org.run(async (tx) => {
      let added = 0;
      for (const number of valid) if (await addToDnc(tx, org.id, number, { source: 'manual', reason: body.reason ?? null, actor: org.actor })) added++;
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'do_not_call.added', metadata: { added, alreadyListed: valid.size - added }, ip: clientIp(request) });
      return { added, alreadyListed: valid.size - added };
    });
    return { ...result, invalid };
  });

  app.delete('/v1/do-not-call/:number', { config: { permission: 'dnc:remove' } }, async (request, reply) => {
    const org = scope(request);
    const raw = (request.params as { number?: string }).number ?? '';
    const normalized = normalizeNumber(raw);
    if ('error' in normalized) throw new ApiError('not_found', 'Number not found on the do-not-call list');
    await org.run(async (tx) => {
      if (!(await removeFromDnc(tx, org.id, normalized.number))) throw new ApiError('not_found', 'Number not found on the do-not-call list');
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'do_not_call.removed', metadata: { number: normalized.number }, ip: clientIp(request) });
    });
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- provider call progress

  // The org comes from the attempt the callback names; the provider signature proves it is genuine.
  app.post('/v1/telephony/:provider/status/:attemptId', { config: { auth: 'none' } }, async (request) => {
    const provider = providerSchema.safeParse((request.params as { provider: string }).provider);
    if (!provider.success) throw new ApiError('not_found', 'Unknown provider');
    // Never trust a signature check that cannot fail: a stand-in adapter, or Twilio with no secret
    // (an HMAC with an empty key is one anyone can compute)
    if (!providerUsable(ctx.config.env, provider.data)) throw new ApiError('not_configured', `${provider.data} call-progress callbacks are disabled in production until its adapter verifies signatures`);
    if (provider.data === 'twilio' && !ctx.config.twilioWebhookSecret) throw new ApiError('not_configured', 'TWILIO_WEBHOOK_SECRET is not set, so Twilio callbacks cannot be verified');
    const adapter = ctx.telephony.adapters[provider.data];
    const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, String(value)]));
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!adapter.verifyWebhookSignature(`${ctx.config.publicUrl}${request.url}`, headers, body, ctx.config.twilioWebhookSecret ?? '')) {
      throw new ApiError('unauthorized', 'Invalid telephony webhook signature');
    }
    const attemptId = idParam(request.params, 'attemptId', 'Attempt');
    const event = parseProviderEvent(body);
    if (!event) throw new ApiError('validation_error', 'Not a call progress event', { issues: [{ path: 'CallSid/CallStatus', message: 'Send a CallSid and a known CallStatus' }] });
    const owner = (
      await ctx.db.query<{ org_id: string; provider: string | null }>('SELECT a.org_id, p.provider FROM campaign_attempt a LEFT JOIN phone_number p ON p.id = a.phone_number_id AND p.org_id = a.org_id WHERE a.id = $1', [attemptId])
    ).rows[0];
    if (!owner || owner.provider !== provider.data) throw new ApiError('not_found', 'Attempt not found');
    const now = ctx.campaigns.now();
    const log = request.log.child({ org_id: owner.org_id, attempt_id: attemptId, provider_call_id: event.providerCallId });
    const outcome = await ctx.tenants.withOrg(owner.org_id, async (tx) => {
      const applied = await applyProviderEvent(tx, owner.org_id, attemptId, event, now, log, ctx.metrics);
      if (applied.result === 'finished') await ctx.campaigns.closeFinished(tx, owner.org_id, now);
      return applied.result;
    });
    return { ok: true, result: outcome };
  });
}
