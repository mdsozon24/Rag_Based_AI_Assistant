/**
 * Audit log for the current org (owners and admins).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { cursorClause, iso, pageRequest, parse, toPage } from '../http/validation.ts';
import { scope } from './org.ts';

interface Row {
  id: string;
  cursor_ts: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown>;
  ip: string | null;
  created_at: Date;
}

const view = (r: Row) => ({
  id: r.id,
  actor: { type: r.actor_type, id: r.actor_id },
  action: r.action,
  target: r.target_type ? { type: r.target_type, id: r.target_id } : null,
  metadata: r.metadata,
  ip: r.ip,
  createdAt: iso(r.created_at),
});

export function registerAuditRoutes(app: FastifyInstance, _ctx: AppContext): void {
  app.get('/v1/audit-logs', { config: { permission: 'audit:read' } }, async (request) => {
    const org = scope(request);
    const page = pageRequest(request.query);
    const { action } = parse(z.object({ action: z.string().max(100).optional() }).passthrough(), request.query);
    const cursor = cursorClause(page, action ? 4 : 3);
    const actionFilter = action ? ' AND action = $3' : '';
    const rows = await org.run(async (tx) =>
      (
        await tx.query<Row>(
          `SELECT *, created_at::text AS cursor_ts FROM audit_log WHERE org_id = $1${actionFilter}${cursor.sql} ORDER BY created_at DESC, id DESC LIMIT $2`,
          [org.id, page.limit + 1, ...(action ? [action] : []), ...cursor.params]
        )
      ).rows
    );
    return toPage(rows, page.limit, view);
  });
}
