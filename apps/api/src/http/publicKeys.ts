/** Rules for requests made with public (browser) keys, shared by web calls and web chat. */
import type { FastifyRequest } from 'fastify';
import { ApiError } from './errors.ts';

/**
 * What a call or chat started with a public (browser) key may override. Public keys are visible to anyone
 * who opens the page, so they cannot change the prompt, model, tools or anything that changes cost
 * or behaviour beyond presentation and turn-taking. Inline assistants need a private key on the
 * customer's server (it creates the call and hands { id, connectToken, wsUrl } to the browser).
 */
export const PUBLIC_KEY_OVERRIDES = new Set(['firstMessage', 'firstMessageMode', 'language', 'endpointing', 'interruption', 'idle']);
const PUBLIC_KEY_VOICE_OVERRIDES = new Set(['voiceId']);

export function disallowedPublicOverrides(overrides: Record<string, unknown>): string[] {
  const refused: string[] = [];
  for (const [field, value] of Object.entries(overrides)) {
    if (PUBLIC_KEY_OVERRIDES.has(field)) continue;
    if (field === 'voice' && value && typeof value === 'object' && !Array.isArray(value)) {
      refused.push(...Object.keys(value).filter((key) => !PUBLIC_KEY_VOICE_OVERRIDES.has(key)).map((key) => `voice.${key}`));
      continue;
    }
    refused.push(field);
  }
  return refused;
}

/** Public key on this request? */
export function isPublicKey(request: FastifyRequest): boolean {
  return request.principal?.kind === 'api_key' && request.principal.keyType === 'public';
}

/** Throws 403 when a public-key request overrides anything outside the allowlist. */
export function assertPublicOverrides(overrides: Record<string, unknown>): void {
  const refused = disallowedPublicOverrides(overrides);
  if (refused.length) {
    throw new ApiError('forbidden', 'Public browser keys cannot override these fields; create the conversation from your server with a private key', {
      fields: refused,
      allowed: [...PUBLIC_KEY_OVERRIDES, 'voice.voiceId'],
    });
  }
}
