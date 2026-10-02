/**
 * Inbound messaging webhooks: POST /v1/messaging/:provider/webhook (twilio; "fake" in tests).
 * Verified with the provider's signature, acknowledged at once, answered in the background by
 * SmsService (so a slow model never hits the provider's webhook timeout).
 */
import type { FastifyInstance } from 'fastify';
import type { MessagingProvider } from '../../../../packages/engine/src/messaging/types.ts';
import type { AppContext } from '../context.ts';
import { ApiError } from '../http/errors.ts';

export function messagingWebhookEnabled(provider: string, environment: string, secret: string): boolean {
  return environment !== 'production' || provider !== 'twilio' || Boolean(secret);
}

export function registerMessagingRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/v1/messaging/:provider/webhook', { config: { auth: 'none' } }, async (request, reply) => {
    const provider = (request.params as { provider: string }).provider as MessagingProvider;
    const adapter = Object.hasOwn(ctx.messaging, provider) ? ctx.messaging[provider] : undefined;
    if (!adapter || (provider === 'fake' && ctx.config.env === 'production')) throw new ApiError('not_found', 'Unknown messaging provider');
    const body = (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>;
    const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
    // Twilio signs with the account auth token
    const secret = ctx.config.twilioWebhookSecret ?? ctx.config.twilio.authToken ?? '';
    if (!messagingWebhookEnabled(provider, ctx.config.env, secret)) throw new ApiError('not_found', 'Route not found');
    if (!adapter.verifyWebhookSignature(`${ctx.config.publicUrl}${request.url}`, headers, body, secret)) {
      throw new ApiError('unauthorized', 'Invalid messaging webhook signature');
    }
    const inbound = adapter.parseInbound(body);
    if (inbound) ctx.sms.accept(adapter, inbound, request.log);
    const ack = adapter.webhookAck();
    return reply.header('content-type', ack.contentType).send(ack.body);
  });
}
