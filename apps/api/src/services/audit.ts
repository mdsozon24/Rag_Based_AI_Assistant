/**
 * Audit log: who did what. Written in the same transaction as the change it records.
 * Org events go through the tenant transaction (row-level security checks the org_id);
 * user-level events without an org (sign-up, login, password reset) have org_id null.
 */
import type { Queryable } from '../db/database.ts';
import { newId } from '../auth/crypto.ts';

export interface Actor {
  type: 'user' | 'api_key' | 'system';
  id: string | null;
}

export interface AuditEntry {
  orgId: string | null;
  actor: Actor;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}

export async function audit(tx: Queryable, entry: AuditEntry): Promise<void> {
  await tx.query(
    `INSERT INTO audit_log (id, org_id, actor_type, actor_id, action, target_type, target_id, metadata, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [newId(), entry.orgId, entry.actor.type, entry.actor.id, entry.action, entry.targetType ?? null, entry.targetId ?? null, JSON.stringify(entry.metadata ?? {}), entry.ip ?? null]
  );
}
