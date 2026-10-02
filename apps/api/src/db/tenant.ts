/**
 * The single place where org scoping is applied to database access.
 *
 * - withOrg(orgId, fn): a transaction running as role octo_app with app.org_id = orgId. Row-level
 *   security on every tenant table limits every statement to that org, even one that forgets its
 *   WHERE clause. Repositories also filter by org_id explicitly (two layers, DECISIONS D6).
 * - identity(fn): the owner connection, for lookups that happen before an org is known (user by
 *   email, session by token hash, API key by hash) and for creating/deleting orgs. Only the auth and
 *   org-lifecycle modules use it.
 *
 * Route handlers never see the raw database: org routes get request.org.run (withOrg bound to the
 * request's org).
 */
import type { Database, Queryable } from './database.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export class TenantDb {
  constructor(private readonly db: Database) {}

  withOrg<T>(orgId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    if (!isUuid(orgId)) throw new Error('withOrg requires a valid org id');
    return this.db.transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE octo_app');
      await tx.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
      return fn(tx);
    });
  }

  identity<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }
}
