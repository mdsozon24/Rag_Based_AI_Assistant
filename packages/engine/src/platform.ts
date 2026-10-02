/**
 * Platform wiring from environment: provider registry, credential service (org keys + platform
 * keys), custom-endpoint policy and default voices. Used by the dev server and smoke script; the
 * future `apps/voice` process builds the same thing with a Postgres credential store.
 */
import { CredentialCipher } from './credentials/cipher.ts';
import { CredentialService, platformKeysFromEnv } from './credentials/service.ts';
import { InMemoryCredentialStore, type CredentialStore } from './credentials/store.ts';
import type { AssistantConfig } from './engine/config.ts';
import type { Logger } from './logger.ts';
import { createDefaultRegistry } from './providers/catalog.ts';
import type { EndpointPolicy } from './providers/net.ts';
import type { BuildContext, ProviderRegistry } from './providers/registry.ts';
import { resolveCallProviders, type CallProviders } from './providers/resolve.ts';

export interface Platform {
  registry: ProviderRegistry;
  credentials: CredentialService;
  endpointPolicy: EndpointPolicy;
  defaults: BuildContext['defaults'];
  /** Build the provider chains for one call of `orgId`. */
  providersForCall(config: AssistantConfig, orgId: string, logger: Logger): Promise<CallProviders>;
}

export function createPlatform(env: NodeJS.ProcessEnv = process.env, store: CredentialStore = new InMemoryCredentialStore()): Platform {
  const registry = createDefaultRegistry();
  const credentials = new CredentialService(store, CredentialCipher.fromEnv(env), platformKeysFromEnv(env));
  const allowPrivate = env.CUSTOM_ENDPOINTS_ALLOW_PRIVATE === 'true';
  if (allowPrivate && env.NODE_ENV === 'production') {
    throw new Error('CUSTOM_ENDPOINTS_ALLOW_PRIVATE=true is not allowed when NODE_ENV=production');
  }
  const endpointPolicy: EndpointPolicy = { allowPrivateNetwork: allowPrivate };
  const defaults = platformDefaults(env);
  return {
    registry,
    credentials,
    endpointPolicy,
    defaults,
    providersForCall: (config, orgId, logger) => resolveCallProviders(config, registry, { orgId, credentials, endpointPolicy, defaults }, logger),
  };
}

/** Platform-level provider defaults from env (default voice per vendor). */
export function platformDefaults(env: NodeJS.ProcessEnv = process.env): BuildContext['defaults'] {
  return {
    voiceIds: {
      // Premade "George" voice, same default as the legacy app
      elevenlabs: env.ELEVENLABS_VOICE_ID?.trim() || 'JBFqnCBsd6RMkjVDRZzb',
      cartesia: env.CARTESIA_VOICE_ID?.trim() || undefined,
    },
  };
}
