/**
 * Postgres implementation of the engine's CredentialStore (bring-your-own-key provider keys).
 * Every method runs in a transaction scoped to the given org (row-level security), so the voice
 * engine and the API share one org-isolated store.
 */
import type { CredentialStore, StoredCredential } from '../../../../packages/engine/src/credentials/store.ts';
import type { TenantDb } from '../db/tenant.ts';

interface Row {
  id: string;
  org_id: string;
  provider: string;
  label: string;
  masked: string;
  encrypted: StoredCredential['encrypted'];
  created_at: Date;
  last_used_at: Date | null;
}

const toStored = (r: Row): StoredCredential => ({
  id: r.id,
  orgId: r.org_id,
  provider: r.provider,
  label: r.label,
  masked: r.masked,
  encrypted: r.encrypted,
  createdAt: r.created_at.toISOString(),
  ...(r.last_used_at ? { lastUsedAt: r.last_used_at.toISOString() } : {}),
});

export class PostgresCredentialStore implements CredentialStore {
  constructor(private readonly tenants: TenantDb) {}

  async insert(record: StoredCredential): Promise<void> {
    await this.tenants.withOrg(record.orgId, (tx) =>
      tx.query(`INSERT INTO provider_credential (id, org_id, provider, label, masked, encrypted, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
        record.id,
        record.orgId,
        record.provider,
        record.label,
        record.masked,
        JSON.stringify(record.encrypted),
        record.createdAt,
      ])
    );
  }

  async get(orgId: string, id: string): Promise<StoredCredential | null> {
    const row = await this.tenants.withOrg(orgId, async (tx) => (await tx.query<Row>('SELECT * FROM provider_credential WHERE org_id = $1 AND id = $2', [orgId, id])).rows[0]);
    return row ? toStored(row) : null;
  }

  async list(orgId: string): Promise<StoredCredential[]> {
    const rows = await this.tenants.withOrg(orgId, async (tx) => (await tx.query<Row>('SELECT * FROM provider_credential WHERE org_id = $1 ORDER BY created_at DESC, id DESC', [orgId])).rows);
    return rows.map(toStored);
  }

  async findByProvider(orgId: string, provider: string): Promise<StoredCredential | null> {
    const row = await this.tenants.withOrg(orgId, async (tx) =>
      (await tx.query<Row>('SELECT * FROM provider_credential WHERE org_id = $1 AND provider = $2 ORDER BY created_at DESC, id DESC LIMIT 1', [orgId, provider])).rows[0]
    );
    return row ? toStored(row) : null;
  }

  async delete(orgId: string, id: string): Promise<boolean> {
    return (await this.tenants.withOrg(orgId, (tx) => tx.query('DELETE FROM provider_credential WHERE org_id = $1 AND id = $2', [orgId, id]))).rowCount > 0;
  }

  async touch(orgId: string, id: string, at: string): Promise<void> {
    await this.tenants.withOrg(orgId, (tx) => tx.query('UPDATE provider_credential SET last_used_at = $3 WHERE org_id = $1 AND id = $2', [orgId, id, at]));
  }
}
