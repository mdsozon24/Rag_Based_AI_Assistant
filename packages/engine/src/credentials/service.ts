/**
 * Org provider credentials (bring your own key) and platform keys.
 *
 * - create/list/get return CredentialView: id, provider, label, mask. Never the secret.
 * - resolveKey(orgId, vendor): the org's own key if it stored one ("org", customer-billed),
 *   otherwise the platform key from env ("platform", platform-billed), otherwise null.
 * - Secrets leave this module only as Secret objects, which redact themselves in logs and JSON.
 */
import { randomUUID } from 'node:crypto';
import { CredentialCipher, CredentialEncryptionError } from './cipher.ts';
import { maskSecret, Secret } from './secret.ts';
import type { CredentialStore, StoredCredential } from './store.ts';

/** Vendors that accept credentials, and the env var holding the platform key for each. */
export const PLATFORM_KEY_ENV: Record<string, string | null> = {
  elevenlabs: 'ELEVENLABS_API_KEY',
  deepgram: 'DEEPGRAM_API_KEY',
  google: 'GEMINI_API_KEY',
  openai: 'OPENAI_API_KEY',
  cartesia: 'CARTESIA_API_KEY',
  // Customer endpoints have no platform key
  custom: null,
};

export const CREDENTIAL_VENDORS = Object.keys(PLATFORM_KEY_ENV);

export type CredentialSource = 'org' | 'platform';

export interface CredentialView {
  id: string;
  orgId: string;
  provider: string;
  label: string;
  masked: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface ResolvedKey {
  secret: Secret;
  source: CredentialSource;
  /** Set for org credentials. */
  credentialId?: string;
}

export class CredentialError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid' | 'not-found' | 'encryption-unavailable'
  ) {
    super(message);
    this.name = 'CredentialError';
  }
}

export function platformKeysFromEnv(env: NodeJS.ProcessEnv = process.env): Map<string, Secret> {
  const keys = new Map<string, Secret>();
  for (const [vendor, name] of Object.entries(PLATFORM_KEY_ENV)) {
    const value = name ? env[name]?.trim() : undefined;
    if (value) keys.set(vendor, new Secret(value));
  }
  return keys;
}

function aad(record: Pick<StoredCredential, 'orgId' | 'id' | 'provider'>): string {
  return `org=${record.orgId};credential=${record.id};provider=${record.provider}`;
}

function view(record: StoredCredential): CredentialView {
  return {
    id: record.id,
    orgId: record.orgId,
    provider: record.provider,
    label: record.label,
    masked: record.masked,
    createdAt: record.createdAt,
    ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {}),
  };
}

export class CredentialService {
  constructor(
    private readonly store: CredentialStore,
    /** null when CREDENTIALS_ENCRYPTION_KEY is not set: org keys cannot be stored or read. */
    private readonly cipher: CredentialCipher | null,
    private readonly platformKeys: Map<string, Secret> = new Map(),
    private readonly now: () => Date = () => new Date()
  ) {}

  private requireCipher(): CredentialCipher {
    if (!this.cipher) {
      throw new CredentialError('Org credentials need CREDENTIALS_ENCRYPTION_KEY (32 bytes, base64) to be configured', 'encryption-unavailable');
    }
    return this.cipher;
  }

  async create(orgId: string, input: { provider: string; secret: string; label?: string }): Promise<CredentialView> {
    if (!orgId) throw new CredentialError('orgId is required', 'invalid');
    if (!CREDENTIAL_VENDORS.includes(input.provider)) {
      throw new CredentialError(`Unknown credential provider "${input.provider}". Known: ${CREDENTIAL_VENDORS.join(', ')}`, 'invalid');
    }
    const secret = input.secret?.trim() ?? '';
    if (secret.length < 8 || secret.length > 4096 || /\s/.test(secret)) {
      throw new CredentialError('Secret must be 8-4096 characters with no whitespace', 'invalid');
    }
    const label = (input.label ?? input.provider).trim().slice(0, 100);
    const cipher = this.requireCipher();
    const base = { id: randomUUID(), orgId, provider: input.provider };
    const record: StoredCredential = {
      ...base,
      label,
      masked: maskSecret(secret),
      encrypted: cipher.encrypt(secret, aad(base)),
      createdAt: this.now().toISOString(),
    };
    await this.store.insert(record);
    return view(record);
  }

  async list(orgId: string): Promise<CredentialView[]> {
    return (await this.store.list(orgId)).map(view);
  }

  async get(orgId: string, id: string): Promise<CredentialView | null> {
    const record = await this.store.get(orgId, id);
    return record ? view(record) : null;
  }

  async delete(orgId: string, id: string): Promise<boolean> {
    return this.store.delete(orgId, id);
  }

  private async decryptRecord(record: StoredCredential): Promise<Secret> {
    const plaintext = this.requireCipher().decrypt(record.encrypted, aad(record));
    await this.store.touch(record.orgId, record.id, this.now().toISOString());
    return new Secret(plaintext);
  }

  /** The org's key for `vendor`, else the platform key, else null. */
  async resolveKey(orgId: string, vendor: string): Promise<ResolvedKey | null> {
    const record = await this.store.findByProvider(orgId, vendor);
    if (record) {
      if (!this.cipher) throw new CredentialEncryptionError('Org has a stored credential but CREDENTIALS_ENCRYPTION_KEY is not configured');
      return { secret: await this.decryptRecord(record), source: 'org', credentialId: record.id };
    }
    const platform = this.platformKeys.get(vendor);
    return platform ? { secret: platform, source: 'platform' } : null;
  }

  /** A specific credential of the org (e.g. the secret for a custom endpoint). */
  async resolveById(orgId: string, id: string, vendor?: string): Promise<ResolvedKey> {
    const record = await this.store.get(orgId, id);
    if (!record || (vendor && record.provider !== vendor)) {
      throw new CredentialError(`Credential ${id} not found for this org${vendor ? ` (provider ${vendor})` : ''}`, 'not-found');
    }
    return { secret: await this.decryptRecord(record), source: 'org', credentialId: record.id };
  }
}
