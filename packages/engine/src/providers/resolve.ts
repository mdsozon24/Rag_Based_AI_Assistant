/**
 * Build the providers for one call: for each component, the primary provider and its fallbacks,
 * using the org's own keys where it stored them and platform keys otherwise.
 *
 * The primary provider must build (missing key or bad config fails the call before it starts, with
 * a clear message). A fallback that cannot build (typically: no key for that vendor) is skipped
 * with a warning, so presets work with whatever keys exist.
 */
import type { AssistantConfig } from '../engine/config.ts';
import { providerFields } from '../engine/config.ts';
import type { Logger } from '../logger.ts';
import type { ChainEntry, ProviderChain } from './chain.ts';
import type { BuildContext, InstanceOf, ProviderRegistry } from './registry.ts';
import type { ComponentKind, LanguageModel, ProviderIdentity, Transcriber, VoiceSynthesizer } from './types.ts';

export interface CallProviders {
  transcriber: ProviderChain<Transcriber>;
  model: ProviderChain<LanguageModel>;
  voice: ProviderChain<VoiceSynthesizer>;
}

export class ProviderResolutionError extends Error {
  constructor(
    message: string,
    readonly kind: ComponentKind,
    readonly provider: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'ProviderResolutionError';
  }
}

async function resolveComponent<K extends ComponentKind>(
  kind: K,
  component: AssistantConfig[K],
  registry: ProviderRegistry,
  context: BuildContext,
  logger: Logger
): Promise<ProviderChain<InstanceOf<K> & ProviderIdentity>> {
  const chain: ChainEntry<InstanceOf<K> & ProviderIdentity>[] = [];
  const configs = [providerFields(component), ...component.fallbacks.map((f) => providerFields(f))];
  for (let i = 0; i < configs.length; i++) {
    const config = configs[i];
    try {
      const built = await registry.build(kind, config, context);
      const instance = built.instance as InstanceOf<K> & ProviderIdentity;
      chain.push({
        instance,
        provider: instance.provider,
        model: instance.model,
        credentialSource: built.credentialSource,
        ...(built.credentialId ? { credentialId: built.credentialId } : {}),
        billing: built.billing,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (i === 0) throw new ProviderResolutionError(`Cannot start ${kind} "${config.provider}": ${message}`, kind, config.provider, { cause: error });
      logger.warn({ component: kind, provider: config.provider, fallback_index: i - 1, reason: message }, 'fallback provider unavailable, skipped');
    }
  }
  return chain;
}

export async function resolveCallProviders(
  config: AssistantConfig,
  registry: ProviderRegistry,
  context: Omit<BuildContext, 'language'>,
  logger: Logger
): Promise<CallProviders> {
  const build = { ...context, language: config.language };
  const results = await Promise.allSettled([
    resolveComponent('transcriber', config.transcriber, registry, build, logger),
    resolveComponent('model', config.model, registry, build, logger),
    resolveComponent('voice', config.voice, registry, build, logger),
  ]);
  // Report every component that cannot start, not just the first
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason as Error);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    const first = failures[0] as ProviderResolutionError;
    throw new ProviderResolutionError(failures.map((f) => f.message).join('; '), first.kind, first.provider, { cause: failures });
  }
  const [transcriber, model, voice] = results.map((r) => (r as PromiseFulfilledResult<unknown>).value);
  return { transcriber, model, voice } as CallProviders;
}

/**
 * Only the model chain (text mode: chat API, SMS). A missing transcriber or voice key does not
 * matter here, since text conversations never use them.
 */
export async function resolveModelChain(
  config: AssistantConfig,
  registry: ProviderRegistry,
  context: Omit<BuildContext, 'language'>,
  logger: Logger
): Promise<ProviderChain<LanguageModel>> {
  return resolveComponent('model', config.model, registry, { ...context, language: config.language }, logger) as Promise<ProviderChain<LanguageModel>>;
}
