/**
 * The signed-in user: profile and orgs, switching the active org, creating orgs, accepting
 * invitations. Dashboard sessions only (auth: 'user').
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext, Principal } from '../context.ts';
import { clientIp } from '../auth/authenticate.ts';
import { sha256 } from '../auth/crypto.ts';
import { createOrg, findUserById, listUserOrgs, membershipRole, publicUser } from '../auth/identity.ts';
import { ApiError } from '../http/errors.ts';
import { parse } from '../http/validation.ts';
import { audit } from '../services/audit.ts';

type SessionPrincipal = Extract<Principal, { kind: 'session' }>;

function session(request: FastifyRequest): SessionPrincipal {
  const p = request.principal;
  if (p?.kind !== 'session') throw new ApiError('forbidden_key_type', 'This endpoint needs a dashboard session');
  return p;
}

export function registerMeRoutes(app: FastifyInstance, ctx: AppContext): void {
  const user = { config: { auth: 'user' as const } };

  app.get('/v1/me', user, async (request) => {
    const p = session(request);
    return ctx.tenants.identity(async (tx) => {
      const me = await findUserById(tx, p.userId);
      const orgs = await listUserOrgs(tx, p.userId);
      return {
        user: publicUser(me!),
        orgs: orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug, role: o.role, status: o.status })),
        activeOrgId: orgs.some((o) => o.id === p.activeOrgId) ? p.activeOrgId : null,
      };
    });
  });

  app.put('/v1/me/active-org', user, async (request) => {
    const p = session(request);
    const { orgId } = parse(z.object({ orgId: z.string().uuid() }), request.body);
    await ctx.tenants.identity(async (tx) => {
      // Not a member and no such org look the same: no probing for other orgs' ids
      if (!(await membershipRole(tx, orgId, p.userId))) throw new ApiError('not_found', 'Organization not found');
      await tx.query('UPDATE session SET active_org_id = $2 WHERE id = $1', [p.sessionId, orgId]);
      await audit(tx, { orgId, actor: { type: 'user', id: p.userId }, action: 'auth.org_switched', targetType: 'org', targetId: orgId, ip: clientIp(request) });
    });
    return { activeOrgId: orgId };
  });

  app.post('/v1/orgs', user, async (request, reply) => {
    const p = session(request);
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(100) }), request.body);
    const org = await ctx.tenants.identity(async (tx) => {
      const created = await createOrg(tx, name, p.userId);
      await tx.query('UPDATE session SET active_org_id = $2 WHERE id = $1', [p.sessionId, created.id]);
      await audit(tx, { orgId: created.id, actor: { type: 'user', id: p.userId }, action: 'org.created', targetType: 'org', targetId: created.id, metadata: { name }, ip: clientIp(request) });
      return created;
    });
    return reply.code(201).send({ ...org, role: 'owner' });
  });

  app.post('/v1/invitations/accept', user, async (request) => {
    const p = session(request);
    const { token } = parse(z.object({ token: z.string().min(10).max(200) }), request.body);
    return ctx.tenants.identity(async (tx) => {
      const invitation = (
        await tx.query<{ id: string; org_id: string; email: string; role: string; invited_by_user_id: string | null }>(
          `SELECT id, org_id, email, role, invited_by_user_id FROM invitation
           WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`,
          [sha256(token)]
        )
      ).rows[0];
      const me = await findUserById(tx, p.userId);
      // The invitation is for one email address; a leaked link cannot be used by someone else
      if (!invitation || !me || invitation.email !== me.email) throw new ApiError('bad_request', 'This invitation is invalid, expired, or for a different email address');
      await tx.query(
        `INSERT INTO membership (org_id, user_id, role, invited_by_user_id) VALUES ($1, $2, $3, $4) ON CONFLICT (org_id, user_id) DO NOTHING`,
        [invitation.org_id, p.userId, invitation.role, invitation.invited_by_user_id]
      );
      await tx.query('UPDATE invitation SET accepted_at = now() WHERE id = $1', [invitation.id]);
      await tx.query('UPDATE session SET active_org_id = $2 WHERE id = $1', [p.sessionId, invitation.org_id]);
      await audit(tx, { orgId: invitation.org_id, actor: { type: 'user', id: p.userId }, action: 'invitation.accepted', targetType: 'invitation', targetId: invitation.id, metadata: { role: invitation.role }, ip: clientIp(request) });
      const role = await membershipRole(tx, invitation.org_id, p.userId);
      return { orgId: invitation.org_id, role };
    });
  });
}
