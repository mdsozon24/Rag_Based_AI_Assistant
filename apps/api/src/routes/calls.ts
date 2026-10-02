import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { buildCallConfig } from '../../../../packages/engine/src/assistant/engineConfig.ts';
import { MissingVariablesError } from '../../../../packages/engine/src/assistant/variables.ts';
import type { AssistantSpec } from '../../../../packages/engine/src/assistant/spec.ts';
import { applyMergePatch } from '../../../../packages/engine/src/assistant/merge.ts';
import { idParam, parse } from '../http/validation.ts';
import { ApiError } from '../http/errors.ts';
import { clientIp } from '../auth/authenticate.ts';
import type { AppContext } from '../context.ts';
import { audit } from '../services/audit.ts';
import { getAssistant, getVersion, requireValidSpec } from '../services/assistants.ts';
import { scope } from './org.ts';
import { disallowedPublicOverrides, PUBLIC_KEY_OVERRIDES } from '../http/publicKeys.ts';

const values = z.record(z.string().max(10_000)).default({});
const createCallSchema = z
  .object({
    assistantId: z.string().uuid().optional(),
    assistant: z.record(z.unknown()).optional(),
    version: z.number().int().positive().optional(),
    variables: values,
    overrides: z.record(z.unknown()).default({}),
    origin: z.string().url().optional(),
    test: z.boolean().default(false),
  })
  .strict();

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');


function missingVariables(error: MissingVariablesError): ApiError {
  return new ApiError('validation_error', 'The call is missing required assistant variables', {
    issues: error.missing.map((item) => ({ path: `variables.${item.name}`, message: `Required by ${item.usedIn.join(' and ')}` })),
  });
}

export function registerCallRoutes(app: FastifyInstance, ctx: AppContext): void {
  const specContext = { registry: ctx.voice.registry, endpointPolicy: ctx.voice.endpointPolicy };

  async function createCall(request: FastifyRequest, reply: FastifyReply, forcedAssistantId?: string) {
    const org = scope(request);
    const body = parse(createCallSchema, request.body);
    const assistantId = forcedAssistantId ?? body.assistantId;
    if (assistantId) org.assertAssistantAllowed(assistantId);
    const publicKey = request.principal?.kind === 'api_key' && request.principal.keyType === 'public';
    if (!assistantId && publicKey) throw new ApiError('forbidden_key_type', 'Public browser keys require a saved assistantId; create inline assistants from your server with a private key');
    if (publicKey) {
      const refused = disallowedPublicOverrides(body.overrides);
      if (refused.length) {
        throw new ApiError('forbidden', 'Public browser keys cannot override these fields; create the call from your server with a private key', {
          fields: refused,
          allowed: [...PUBLIC_KEY_OVERRIDES, 'voice.voiceId'],
        });
      }
    }
    // The browser origin the media socket must come from. Browser callers (public keys, dashboard
    // sessions) are bound to the Origin header the auth hook already checked; a server holding a
    // private key says which origin it creates the call for (or none).
    const headerOrigin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
    const callOrigin = request.principal?.kind === 'api_key' && !publicKey ? body.origin : headerOrigin ?? body.origin;
    if (!forcedAssistantId && Boolean(body.assistantId) === Boolean(body.assistant)) {
      throw new ApiError('validation_error', 'The request is invalid', { issues: [{ path: 'assistantId', message: 'Provide exactly one of assistantId or assistant' }] });
    }
    const startedAt = new Date();
    const callId = randomUUID();
    let spec: AssistantSpec;
    let name = 'Transient assistant';
    let source: 'published' | 'version' | 'transient' = 'transient';
    let versionId: string | null = null;
    let versionNumber: number | null = null;

    const result = await org.run(async (tx) => {
      if (assistantId) {
        const assistant = await getAssistant(tx, org.id, assistantId);
        name = assistant.name;
        const version = body.version === undefined
          ? (assistant.published_version ? await getVersion(tx, org.id, assistantId, assistant.published_version) : null)
          : await getVersion(tx, org.id, assistantId, body.version);
        if (!version) throw new ApiError('conflict', 'Assistant has no published version');
        spec = requireValidSpec(applyMergePatch(version.config, body.overrides), specContext, 'overrides');
        source = body.version === undefined ? 'published' : 'version';
        versionId = version.id;
        versionNumber = version.version;
      } else {
        spec = requireValidSpec(body.assistant, specContext, 'assistant');
        if (Object.keys(body.overrides).length) spec = requireValidSpec(applyMergePatch(spec, body.overrides), specContext, 'overrides');
      }

      try {
        buildCallConfig({ spec, name, callId, startedAt, variables: body.variables }, ctx.voice.registry);
      } catch (error) {
        if (error instanceof MissingVariablesError) throw missingVariables(error);
        throw error;
      }

      const token = randomBytes(32).toString('base64url');
      await tx.query(
        `INSERT INTO call (id, org_id, type, test, assistant_id, assistant_version_id, config_source, assistant_name,
          config, config_schema, overridden_fields, variable_values, status, token_hash, token_expires_at, origin, created_by_type, created_by_id, direction)
         VALUES ($1, $2, 'web', $3, $4, $5, $6, $7, $8, $9, $10, $11, 'queued', $12, now() + interval '10 minutes', $13, $14, $15, 'web')`,
        [callId, org.id, body.test, assistantId ?? null, versionId, source, name, JSON.stringify(spec), 1, Object.keys(body.overrides), JSON.stringify(body.variables), tokenHash(token), callOrigin ?? null, org.actor.type, org.actor.id]
      );
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'call.created', targetType: 'call', targetId: callId, metadata: { assistantId: assistantId ?? null, version: versionNumber, source, test: body.test }, ip: clientIp(request) });
      return { callId, token, version: versionNumber, source, spec };
    });

    return reply.code(201).send({
      id: result.callId,
      status: 'queued',
      assistantId: assistantId ?? null,
      version: result.version,
      configSource: result.source,
      connectToken: result.token,
      tokenExpiresAt: new Date(startedAt.getTime() + 10 * 60_000).toISOString(),
      wsUrl: `${ctx.config.publicUrl.replace(/^http/, 'ws')}/v1/calls/${result.callId}/connect`,
      config: result.spec,
    });
  }

  app.post('/v1/calls', { config: { permission: 'calls:create', allowPublicKey: true } }, (request, reply) => createCall(request, reply));
  app.post('/v1/assistants/:id/test-call', { config: { permission: 'calls:create' } }, (request, reply) => createCall(request, reply, idParam(request.params, 'id', 'Assistant')));
}