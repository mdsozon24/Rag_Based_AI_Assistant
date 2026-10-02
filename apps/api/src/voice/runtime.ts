/**
 * What the API needs from the voice engine: the provider registry (to validate assistant configs),
 * the custom-endpoint policy, and provider resolution for a call (org key, else platform key).
 * Tests replace providersForCall with fake providers; validation stays real.
 */
import type { AssistantConfig } from '../../../../packages/engine/src/engine/config.ts';
import type { Logger } from '../../../../packages/engine/src/logger.ts';
import type { EndpointPolicy } from '../../../../packages/engine/src/providers/net.ts';
import type { ProviderRegistry } from '../../../../packages/engine/src/providers/registry.ts';
import type { CallProviders } from '../../../../packages/engine/src/providers/resolve.ts';
import type { ProviderChain } from '../../../../packages/engine/src/providers/chain.ts';
import type { LanguageModel } from '../../../../packages/engine/src/providers/types.ts';
import type { FastifyBaseLogger } from 'fastify';

export interface VoiceRuntime {
  registry: ProviderRegistry;
  endpointPolicy: EndpointPolicy;
  providersForCall(config: AssistantConfig, orgId: string, logger: Logger): Promise<CallProviders>;
  /** Only the model chain, for text conversations (no STT or TTS key needed). */
  modelForCall(config: AssistantConfig, orgId: string, logger: Logger): Promise<ProviderChain<LanguageModel>>;
}

/** Fastify's pino logger as the engine's Logger (same call shape). */
export function engineLogger(log: FastifyBaseLogger): Logger {
  return {
    debug: (fields, msg) => log.debug(fields, msg),
    info: (fields, msg) => log.info(fields, msg),
    warn: (fields, msg) => log.warn(fields, msg),
    error: (fields, msg) => log.error(fields, msg),
    child: (bindings) => engineLogger(log.child(bindings)),
  };
}
