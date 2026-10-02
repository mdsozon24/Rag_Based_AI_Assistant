/**
 * The current org, its members and invitations. All queries run through request.org.run,
 * scoped to the request's org (and filtered by org_id explicitly as well).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext, OrgScope } from '../context.ts';
import { clientIp } from '../auth/authenticate.ts';
import { newId, randomToken, sha256 } from '../auth/crypto.ts';
import { canManageRole, ROLES, type Role } from '../auth/permissions.ts';
import { ApiError } from '../http/errors.ts';
import { cursorClause, idParam, iso, pageRequest, parse, toPage } from '../http/validation.ts';
import { audit } from '../services/audit.ts';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function scope(request: FastifyRequest): OrgScope {
  if (!request.org) throw new ApiError('internal_error', 'Route is missing org scope');
  return request.org;
}

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  rate_limit_per_minute: number | null;
  chat_billing_unit: 'message' | 'token';
  created_at: Date;
}
const orgView = (o: OrgRow) => ({ id: o.id, name: o.name, slug: o.slug, status: o.status, rateLimitPerMinute: o.rate_limit_per_minute, chatBillingUnit: o.chat_billing_unit, createdAt: iso(o.created_at) });

interface MemberRow {
  id: string;
  cursor_ts: string;
  email: string;
  name: string;
  role: Role;
  created_at: Date;
}
const memberView = (m: MemberRow) => ({ userId: m.id, email: m.email, name: m.name, role: m.role, joinedAt: iso(m.created_at) });

interface InvitationRow {
  id: string;
  cursor_ts: string;
  email: string;
  role: string;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}
const invitationView = (i: InvitationRow) => ({
  id: i.id,
  email: i.email,
  role: i.role,
  status: i.revoked_at ? 'revoked' : i.accepted_at ? 'accepted' : i.expires_at.getTime() <= Date.now() ? 'expired' : 'pending',
  expiresAt: iso(i.expires_at),
  createdAt: iso(i.created_at),
});

export function registerOrgRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ---------------------------------------------------------------- org

  app.get('/v1/org', { config: { permission: 'org:read' } }, async (request) => {
    const org = scope(request);
    const row = await org.run(async (tx) => (await tx.query<OrgRow>('SELECT * FROM org WHERE id = $1', [org.id])).rows[0]);
    return orgView(row);
  });

  app.patch('/v1/org', { config: { permission: 'org:update' } }, async (request) => {
    const org = scope(request);
    // chatBillingUnit: how chat turns are counted in usage records (per message or per token)
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(100).optional(), chatBillingUnit: z.enum(['message', 'token']).optional() }).strict().refine((b) => b.name !== undefined || b.chatBillingUnit !== undefined, 'Provide name or chatBillingUnit'),
      request.body
    );
    const row = await org.run(async (tx) => {
      const updated = (await tx.query<OrgRow>('UPDATE org SET name = coalesce($2, name), chat_billing_unit = coalesce($3, chat_billing_unit), updated_at = now() WHERE id = $1 RETURNING *', [org.id, body.name ?? null, body.chatBillingUnit ?? null])).rows[0];
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'org.updated', targetType: 'org', targetId: org.id, metadata: { ...(body.name ? { name: body.name } : {}), ...(body.chatBillingUnit ? { chatBillingUnit: body.chatBillingUnit } : {}) }, ip: clientIp(request) });
      return updated;
    });
    return orgView(row);
  });

  app.delete('/v1/org', { config: { permission: 'org:delete' } }, async (request, reply) => {
    const org = scope(request);
    parse(z.object({ confirm: z.literal('delete') }), request.body);
    // Deleting the org removes all its data (cascade); the audit entry outlives it (org_id null)
    await ctx.tenants.identity(async (tx) => {
      const row = (await tx.query<OrgRow>('SELECT * FROM org WHERE id = $1', [org.id])).rows[0];
      await tx.query('DELETE FROM org WHERE id = $1', [org.id]);
      await audit(tx, { orgId: null, actor: org.actor, action: 'org.deleted', targetType: 'org', targetId: org.id, metadata: { name: row?.name, slug: row?.slug }, ip: clientIp(request) });
    });
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- members

  app.get('/v1/members', { config: { permission: 'members:read' } }, async (request) => {
    const org = scope(request);
    const page = pageRequest(request.query);
    const cursor = cursorClause(page, 3, 'm');
    const rows = await org.run(async (tx) =>
      (
        await tx.query<MemberRow>(
          `SELECT u.id, m.created_at::text AS cursor_ts, u.email, u.name, m.role, m.created_at
           FROM membership m JOIN app_user u ON u.id = m.user_id
           WHERE m.org_id = $1${cursor.sql.replace('m.id', 'm.user_id')}
           ORDER BY m.created_at DESC, m.user_id DESC LIMIT $2`,
          [org.id, page.limit + 1, ...cursor.params]
        )
      ).rows
    );
    return toPage(rows, page.limit, memberView);
  });

  async function loadMember(org: OrgScope, userId: string) {
    return org.run(async (tx) => (await tx.query<{ role: Role }>('SELECT role FROM membership WHERE org_id = $1 AND user_id = $2', [org.id, userId])).rows[0]?.role ?? null);
  }

  async function ensureAnotherOwner(org: OrgScope, leavingUserId: string): Promise<void> {
    const owners = await org.run(async (tx) =>
      Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM membership WHERE org_id = $1 AND role = 'owner' AND user_id <> $2`, [org.id, leavingUserId])).rows[0].n)
    );
    if (owners === 0) throw new ApiError('conflict', 'An organization needs at least one owner; make someone else owner first');
  }

  app.patch('/v1/members/:userId', { config: { permission: 'members:manage' } }, async (request) => {
    const org = scope(request);
    const userId = idParam(request.params, 'userId', 'Member');
    const { role } = parse(z.object({ role: z.enum(ROLES) }).strict(), request.body);
    const current = await loadMember(org, userId);
    if (!current) throw new ApiError('not_found', 'Member not found');
    const actorRole = org.role ?? 'api_key';
    if (!canManageRole(actorRole, current) || !canManageRole(actorRole, role)) {
      throw new ApiError('forbidden', 'Only owners can grant, change or remove the owner role');
    }
    if (current === 'owner' && role !== 'owner') await ensureAnotherOwner(org, userId);
    const row = await org.run(async (tx) => {
      await tx.query('UPDATE membership SET role = $3 WHERE org_id = $1 AND user_id = $2', [org.id, userId, role]);
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'member.role_changed', targetType: 'user', targetId: userId, metadata: { from: current, to: role }, ip: clientIp(request) });
      return (
        await tx.query<MemberRow>(
          `SELECT u.id, m.created_at::text AS cursor_ts, u.email, u.name, m.role, m.created_at FROM membership m JOIN app_user u ON u.id = m.user_id WHERE m.org_id = $1 AND m.user_id = $2`,
          [org.id, userId]
        )
      ).rows[0];
    });
    return memberView(row);
  });

  // Members may remove themselves (leave); removing others needs members:manage
  app.delete('/v1/members/:userId', { config: { permission: 'members:read' } }, async (request, reply) => {
    const org = scope(request);
    const userId = idParam(request.params, 'userId', 'Member');
    const self = org.actor.type === 'user' && org.actor.id === userId;
    if (!self && !org.can('members:manage')) throw new ApiError('forbidden', 'Missing permission members:manage', { permission: 'members:manage' });
    const current = await loadMember(org, userId);
    if (!current) throw new ApiError('not_found', 'Member not found');
    if (!self && !canManageRole(org.role ?? 'api_key', current)) throw new ApiError('forbidden', 'Only owners can remove an owner');
    if (current === 'owner') await ensureAnotherOwner(org, userId);
    await org.run(async (tx) => {
      await tx.query('DELETE FROM membership WHERE org_id = $1 AND user_id = $2', [org.id, userId]);
      await audit(tx, { orgId: org.id, actor: org.actor, action: self ? 'member.left' : 'member.removed', targetType: 'user', targetId: userId, metadata: { role: current }, ip: clientIp(request) });
    });
    // The removed user's sessions lose this org right away
    await ctx.tenants.identity((tx) => tx.query('UPDATE session SET active_org_id = NULL WHERE user_id = $1 AND active_org_id = $2', [userId, org.id]));
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- invitations

  app.post('/v1/invitations', { config: { permission: 'invitations:manage' } }, async (request, reply) => {
    const org = scope(request);
    const body = parse(z.object({ email: z.string().trim().toLowerCase().email().max(254), role: z.enum(['admin', 'member', 'viewer']) }).strict(), request.body);
    const token = randomToken();
    const row = await org.run(async (tx) => {
      const already = await tx.query(
        `SELECT 1 FROM membership m JOIN app_user u ON u.id = m.user_id WHERE m.org_id = $1 AND u.email = $2`,
        [org.id, body.email]
      );
      if (already.rowCount > 0) throw new ApiError('conflict', 'This person is already a member');
      // A new invitation replaces a pending one for the same email
      await tx.query('UPDATE invitation SET revoked_at = now() WHERE org_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL', [org.id, body.email]);
      const created = (
        await tx.query<InvitationRow>(
          `INSERT INTO invitation (id, org_id, email, role, token_hash, invited_by_user_id, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, now() + ($7::bigint * interval '1 millisecond'))
           RETURNING *, created_at::text AS cursor_ts`,
          [newId(), org.id, body.email, body.role, sha256(token), org.actor.type === 'user' ? org.actor.id : null, INVITE_TTL_MS]
        )
      ).rows[0];
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'invitation.created', targetType: 'invitation', targetId: created.id, metadata: { email: body.email, role: body.role }, ip: clientIp(request) });
      return created;
    });
    const orgName = await org.run(async (tx) => (await tx.query<{ name: string }>('SELECT name FROM org WHERE id = $1', [org.id])).rows[0].name);
    // The token only travels by email: only the invited address can accept
    await ctx.mailer.send({
      to: body.email,
      subject: `You're invited to ${orgName} on Voice of Octo`,
      text: `You have been invited to join ${orgName} as ${body.role}. Accept: ${ctx.config.dashboardUrl}/invite?token=${token}\n\nThe invitation expires in 7 days.`,
    });
    return reply.code(201).send(invitationView(row));
  });

  app.get('/v1/invitations', { config: { permission: 'invitations:read' } }, async (request) => {
    const org = scope(request);
    const page = pageRequest(request.query);
    const cursor = cursorClause(page, 3);
    const rows = await org.run(async (tx) =>
      (await tx.query<InvitationRow>(`SELECT *, created_at::text AS cursor_ts FROM invitation WHERE org_id = $1${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT $2`, [org.id, page.limit + 1, ...cursor.params])).rows
    );
    return toPage(rows, page.limit, invitationView);
  });

  app.delete('/v1/invitations/:id', { config: { permission: 'invitations:manage' } }, async (request) => {
    const org = scope(request);
    const id = idParam(request.params, 'id', 'Invitation');
    const row = await org.run(async (tx) => {
      const updated = (
        await tx.query<InvitationRow>(
          `UPDATE invitation SET revoked_at = coalesce(revoked_at, now()) WHERE org_id = $1 AND id = $2 AND accepted_at IS NULL RETURNING *, created_at::text AS cursor_ts`,
          [org.id, id]
        )
      ).rows[0];
      if (!updated) throw new ApiError('not_found', 'Invitation not found');
      await audit(tx, { orgId: org.id, actor: org.actor, action: 'invitation.revoked', targetType: 'invitation', targetId: id, ip: clientIp(request) });
      return updated;
    });
    return invitationView(row);
  });
}
