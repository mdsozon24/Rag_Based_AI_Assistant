/**
 * Provider registry: turns a component config such as
 *   {"provider":"deepgram","model":"nova-3","language":"bn"}
 * into a provider instance. Each provider registers a spec with a strict zod schema (typos and
 * unknown fields are rejected) and a build function that fetches the right credential.
 */
import { z } from 'zod';
import type { CredentialService, CredentialSource } from '../credentials/service.ts';
import type { EndpointPolicy } from './net.ts';
import type { ComponentKind, LanguageModel, Transcriber, VoiceSynthesizer } from './types.ts';

export type InstanceOf<K extends ComponentKind> = K extends 'transcriber' ? Transcriber : K extends 'model' ? LanguageModel : VoiceSynthesizer;

/** Component config as written in an assistant: provider id plus provider-specific fields. */
export interface ComponentConfig {
  provider: string;
  model?: string;
  [field: string]: unknown;
}

export interface BuildContext {
  orgId: string;
  /** Assistant language, used when the component sets none. */
  language: string;
  credentials: CredentialService;
  endpointPolicy: EndpointPolicy;
  /** Platform-level defaults from env, e.g. default voice ids per vendor. */
  defaults: { voiceIds: Record<string, string | undefined> };
}

/** Who pays for the provider usage of a call. */
export type Billing = 'platform' | 'customer';

export interface BuiltProvider<K extends ComponentKind> {
  instance: InstanceOf<K>;
  /** "none" for custom endpoints without a secret. */
  credentialSource: CredentialSource | 'none';
  credentialId?: string;
  billing: Billing;
}

export interface ProviderSpec<K extends ComponentKind = ComponentKind> {
  kind: K;
  id: string;
  description: string;
  defaultModel: string;
  /** Validates the provider fields of a component (no policy keys or fallbacks). Should be .strict(). */
  schema: z.ZodTypeAny;
  build(config: ComponentConfig, context: BuildContext): Promise<BuiltProvider<K>>;
}

export class UnknownProviderError extends Error {
  constructor(
    readonly kind: ComponentKind,
    readonly provider: string,
    readonly known: string[]
  ) {
    super(`Unknown ${kind} provider "${provider}". Available ${kind} providers: ${known.join(', ') || '(none registered)'}`);
    this.name = 'UnknownProviderError';
  }
}

export class ProviderConfigError extends Error {
  constructor(
    message: string,
    readonly kind: ComponentKind,
    readonly provider: string
  ) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

export class ProviderRegistry {
  private readonly specs = new Map<string, ProviderSpec>();

  register<K extends ComponentKind>(spec: ProviderSpec<K>): this {
    const key = `${spec.kind}:${spec.id}`;
    if (this.specs.has(key)) throw new Error(`Provider ${key} is already registered`);
    this.specs.set(key, spec as unknown as ProviderSpec);
    return this;
  }

  ids(kind: ComponentKind): string[] {
    return [...this.specs.values()].filter((s) => s.kind === kind).map((s) => s.id);
  }

  spec<K extends ComponentKind>(kind: K, provider: string): ProviderSpec<K> {
    const spec = this.specs.get(`${kind}:${provider}`);
    if (!spec) throw new UnknownProviderError(kind, provider, this.ids(kind));
    return spec as unknown as ProviderSpec<K>;
  }

  /** Validate one component config (without fallbacks). Throws UnknownProviderError / ProviderConfigError. */
  validate(kind: ComponentKind, raw: unknown, path: string = kind): ComponentConfig {
    if (!raw || typeof raw !== 'object' || typeof (raw as { provider?: unknown }).provider !== 'string') {
      throw new ProviderConfigError(`${path}.provider is required (one of: ${this.ids(kind).join(', ')})`, kind, '');
    }
    const provider = (raw as { provider: string }).provider;
    const spec = this.spec(kind, provider);
    const result = spec.schema.safeParse(raw);
    if (!result.success) {
      const problems = result.error.issues
        .map((i) => (i.code === 'unrecognized_keys' ? `${path}: unknown field(s) ${i.keys.join(', ')} for provider "${provider}"` : `${path}.${i.path.join('.')}: ${i.message}`))
        .join('; ');
      throw new ProviderConfigError(`Invalid ${kind} config for "${provider}": ${problems}`, kind, provider);
    }
    return result.data as ComponentConfig;
  }

  async build<K extends ComponentKind>(kind: K, config: ComponentConfig, context: BuildContext): Promise<BuiltProvider<K>> {
    return this.spec(kind, config.provider).build(config, context);
  }
}
