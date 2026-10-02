/**
 * Identity lookups that run before an org is known (owner connection, see db/tenant.ts):
 * users, sessions, email tokens, invitations by token, API keys by hash, org creation.
 * Nothing here returns another org's tenant data to a caller without first proving membership.
 */
import type { Queryable } from '../db/database.ts';
import { newId, sha256 } from './crypto.ts';
import type { Role } from './permissions.ts';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  google_sub: string | null;
  email_verified_at: Date | null;
  last_login_at: Date | null;
  created_at: Date;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function publicUser(user: Pick<UserRow, 'id' | 'email' | 'name' | 'email_verified_at'>) {
  return { id: user.id, email: user.email, name: user.name, emailVerified: Boolean(user.email_verified_at) };
}

// ---------------------------------------------------------------- users

export async function findUserByEmail(tx: Queryable, email: string): Promise<UserRow | null> {
  return (await tx.query<UserRow>('SELECT * FROM app_user WHERE email = $1', [normalizeEmail(email)])).rows[0] ?? null;
}

export async function findUserById(tx: Queryable, id: string): Promise<UserRow | null> {
  return (await tx.query<UserRow>('SELECT * FROM app_user WHERE id = $1', [id])).rows[0] ?? null;
}

export async function findUserByGoogleSub(tx: Queryable, sub: string): Promise<UserRow | null> {
  return (await tx.query<UserRow>('SELECT * FROM app_user WHERE google_sub = $1', [sub])).rows[0] ?? null;
}

export async function createUser(
  tx: Queryable,
  input: { email: string; name: string; passwordHash: string | null; googleSub?: string; verified?: boolean }
): Promise<UserRow> {
  const result = await tx.query<UserRow>(
    `INSERT INTO app_user (id, email, name, password_hash, google_sub, email_verified_at)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::boolean THEN now() END) RETURNING *`,
    [newId(), normalizeEmail(input.email), input.name, input.passwordHash, input.googleSub ?? null, input.verified ?? false]
  );
  return result.rows[0];
}

// ---------------------------------------------------------------- orgs and memberships

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  role: Role;
  status: string;
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base.length >= 2 ? base : 'org';
}

/** Create an org with `ownerId` as its first owner. */
export async function createOrg(tx: Queryable, name: string, ownerId: string): Promise<{ id: string; name: string; slug: string }> {
  const id = newId();
  // Random suffix keeps slugs unique without a retry loop
  const slug = `${slugify(name)}-${id.slice(0, 6)}`;
  await tx.query('INSERT INTO org (id, name, slug) VALUES ($1, $2, $3)', [id, name, slug]);
  await tx.query(`INSERT INTO membership (org_id, user_id, role) VALUES ($1, $2, 'owner')`, [id, ownerId]);
  return { id, name, slug };
}

export async function listUserOrgs(tx: Queryable, userId: string): Promise<OrgSummary[]> {
  return (
    await tx.query<OrgSummary>(
      `SELECT o.id, o.name, o.slug, o.status, m.role FROM membership m JOIN org o ON o.id = m.org_id
       WHERE m.user_id = $1 ORDER BY m.created_at ASC`,
      [userId]
    )
  ).rows;
}

export async function membershipRole(tx: Queryable, orgId: string, userId: string): Promise<Role | null> {
  return (await tx.query<{ role: Role }>('SELECT role FROM membership WHERE org_id = $1 AND user_id = $2', [orgId, userId])).rows[0]?.role ?? null;
}

// ---------------------------------------------------------------- sessions

export interface SessionRow {
  id: string;
  user_id: string;
  active_org_id: string | null;
  expires_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
}

export async function createSession(
  tx: Queryable,
  input: { userId: string; token: string; activeOrgId: string | null; ttlMs: number; ip?: string; userAgent?: string }
): Promise<SessionRow> {
  const result = await tx.query<SessionRow>(
    `INSERT INTO session (id, user_id, token_hash, active_org_id, ip, user_agent, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + ($7::bigint * interval '1 millisecond')) RETURNING *`,
    [newId(), input.userId, sha256(input.token), input.activeOrgId, input.ip ?? null, (input.userAgent ?? '').slice(0, 300), input.ttlMs]
  );
  return result.rows[0];
}

export async function findSession(tx: Queryable, token: string): Promise<(SessionRow & { email_verified_at: Date | null }) | null> {
  return (
    (
      await tx.query<SessionRow & { email_verified_at: Date | null }>(
        `SELECT s.*, u.email_verified_at FROM session s JOIN app_user u ON u.id = s.user_id WHERE s.token_hash = $1`,
        [sha256(token)]
      )
    ).rows[0] ?? null
  );
}

export async function revokeSession(tx: Queryable, sessionId: string): Promise<void> {
  await tx.query('UPDATE session SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}

export async function revokeAllSessions(tx: Queryable, userId: string): Promise<number> {
  return (await tx.query('UPDATE session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId])).rowCount;
}

// ---------------------------------------------------------------- email tokens

export type EmailTokenPurpose = 'verify_email' | 'reset_password';

export async function createEmailToken(tx: Queryable, userId: string, purpose: EmailTokenPurpose, token: string, ttlMs: number): Promise<void> {
  // A new token invalidates earlier unused ones for the same purpose
  await tx.query('UPDATE email_token SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL', [userId, purpose]);
  await tx.query(
    `INSERT INTO email_token (id, user_id, purpose, token_hash, expires_at) VALUES ($1, $2, $3, $4, now() + ($5::bigint * interval '1 millisecond'))`,
    [newId(), userId, purpose, sha256(token), ttlMs]
  );
}

/** Mark a valid token used (single use) and return its user id, or null. */
export async function consumeEmailToken(tx: Queryable, purpose: EmailTokenPurpose, token: string): Promise<string | null> {
  const result = await tx.query<{ user_id: string }>(
    `UPDATE email_token SET used_at = now()
     WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [sha256(token), purpose]
  );
  return result.rows[0]?.user_id ?? null;
}

// ---------------------------------------------------------------- API keys

export interface ApiKeyAuthRow {
  id: string;
  org_id: string;
  type: 'private' | 'public';
  allowed_origins: string[];
  allowed_assistant_ids: string[];
  rate_limit_per_minute: number | null;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  org_status: string;
  org_rate_limit_per_minute: number | null;
}

export async function findApiKeyByHash(tx: Queryable, keyHash: string): Promise<ApiKeyAuthRow | null> {
  return (
    (
      await tx.query<ApiKeyAuthRow>(
        `SELECT k.id, k.org_id, k.type, k.allowed_origins, k.allowed_assistant_ids, k.rate_limit_per_minute, k.last_used_at,
                k.expires_at, k.revoked_at, o.status AS org_status, o.rate_limit_per_minute AS org_rate_limit_per_minute
         FROM api_key k JOIN org o ON o.id = k.org_id WHERE k.key_hash = $1`,
        [keyHash]
      )
    ).rows[0] ?? null
  );
}
