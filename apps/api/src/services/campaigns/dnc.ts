/**
 * The org-level do-not-call list. It is checked before every campaign dial (at claim time and again
 * right before the provider request), and a person who asks to stop during a call is added to it before
 * the call ends. Matching is exact on the E.164 number.
 */
import type { Queryable } from '../../db/database.ts';
import type { Actor } from '../audit.ts';

export async function isOnDnc(tx: Queryable, orgId: string, e164: string): Promise<boolean> {
  return (await tx.query('SELECT 1 FROM do_not_call WHERE org_id = $1 AND e164 = $2', [orgId, e164])).rowCount > 0;
}

/** Which of `numbers` are listed. */
export async function listedNumbers(tx: Queryable, orgId: string, numbers: string[]): Promise<Set<string>> {
  if (!numbers.length) return new Set();
  const rows = (await tx.query<{ e164: string }>('SELECT e164 FROM do_not_call WHERE org_id = $1 AND e164 = ANY ($2::text[])', [orgId, numbers])).rows;
  return new Set(rows.map((r) => r.e164));
}

export interface DncEntry {
  source: 'manual' | 'opt-out';
  reason?: string | null;
  campaignId?: string | null;
  callId?: string | null;
  actor: Actor;
}

/**
 * Add a number. Contacts waiting in any campaign of the org are closed at once (do_not_call); a call in
 * progress finishes and is recorded as an opt-out when it ends. Returns false when it was already listed
 * (the first entry, with its source and reason, is kept).
 */
export async function addToDnc(tx: Queryable, orgId: string, e164: string, entry: DncEntry): Promise<boolean> {
  const inserted = await tx.query(
    `INSERT INTO do_not_call (org_id, e164, source, reason, campaign_id, call_id, created_by_type, created_by_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (org_id, e164) DO NOTHING`,
    [orgId, e164, entry.source, entry.reason?.slice(0, 500) ?? null, entry.campaignId ?? null, entry.callId ?? null, entry.actor.type, entry.actor.id]
  );
  await tx.query(
    `UPDATE campaign_contact SET status = 'do_not_call', next_attempt_at = NULL, last_outcome = coalesce(last_outcome, 'do-not-call'), updated_at = now()
     WHERE org_id = $1 AND e164 = $2 AND status = 'pending'`,
    [orgId, e164]
  );
  return inserted.rowCount > 0;
}

export async function removeFromDnc(tx: Queryable, orgId: string, e164: string): Promise<boolean> {
  return (await tx.query('DELETE FROM do_not_call WHERE org_id = $1 AND e164 = $2', [orgId, e164])).rowCount > 0;
}
