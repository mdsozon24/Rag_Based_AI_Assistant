/**
 * Credential persistence. Every method takes orgId: a record is only visible to its own org.
 * InMemoryCredentialStore serves tests and the dev server; the Postgres store (table
 * provider_credential, row-level security on org_id) arrives with Phase 2 auth.
 */
import type { EncryptedSecret } from './cipher.ts';

export interface StoredCredential {
  id: string;
  orgId: string;
  /** Vendor id: "elevenlabs", "deepgram", "google", "openai", "cartesia", "custom". */
  provider: string;
  label: string;
  /** Display-only mask computed at creation ("••••abcd"); the secret itself is only in `encrypted`. */
  masked: string;
  encrypted: EncryptedSecret;
  createdAt: string;
  lastUsedAt?: string;
}

export interface CredentialStore {
  insert(record: StoredCredential): Promise<void>;
  get(orgId: string, id: string): Promise<StoredCredential | null>;
  list(orgId: string): Promise<StoredCredential[]>;
  /** Newest credential of the org for a vendor, if any. */
  findByProvider(orgId: string, provider: string): Promise<StoredCredential | null>;
  delete(orgId: string, id: string): Promise<boolean>;
  touch(orgId: string, id: string, at: string): Promise<void>;
}

export class InMemoryCredentialStore implements CredentialStore {
  private readonly byOrg = new Map<string, Map<string, StoredCredential>>();

  private org(orgId: string): Map<string, StoredCredential> {
    let records = this.byOrg.get(orgId);
    if (!records) this.byOrg.set(orgId, (records = new Map()));
    return records;
  }

  async insert(record: StoredCredential): Promise<void> {
    this.org(record.orgId).set(record.id, structuredClone(record));
  }

  async get(orgId: string, id: string): Promise<StoredCredential | null> {
    const record = this.byOrg.get(orgId)?.get(id);
    return record ? structuredClone(record) : null;
  }

  async list(orgId: string): Promise<StoredCredential[]> {
    return [...(this.byOrg.get(orgId)?.values() ?? [])].map((r) => structuredClone(r));
  }

  async findByProvider(orgId: string, provider: string): Promise<StoredCredential | null> {
    const matches = [...(this.byOrg.get(orgId)?.values() ?? [])].filter((r) => r.provider === provider);
    matches.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return matches[0] ? structuredClone(matches[0]) : null;
  }

  async delete(orgId: string, id: string): Promise<boolean> {
    return this.byOrg.get(orgId)?.delete(id) ?? false;
  }

  async touch(orgId: string, id: string, at: string): Promise<void> {
    const record = this.byOrg.get(orgId)?.get(id);
    if (record) record.lastUsedAt = at;
  }
}
