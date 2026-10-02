/**
 * Minimal database interface over PGlite (dev/tests: real Postgres in-process) and node-postgres
 * (production). Queries are parameterized SQL ($1, $2, ...); there is no string interpolation of
 * values anywhere in the API.
 */
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Run a script of several statements without parameters (migrations only). */
  exec(text: string): Promise<void>;
}

export interface Database extends Queryable {
  /** Run fn in one transaction; rolls back if it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: 'pglite' | 'postgres';
}

/** PGlite reports affectedRows = 0 for SELECT; like node-postgres, count returned rows then. */
function rowCount(affected: number | undefined, returned: number): number {
  return Math.max(affected ?? 0, returned);
}

class PgliteDatabase implements Database {
  readonly kind = 'pglite' as const;

  constructor(private readonly db: PGlite) {}

  async query<T>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const result = await this.db.query<T>(text, params);
    return { rows: result.rows, rowCount: rowCount(result.affectedRows, result.rows.length) };
  }

  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) =>
      fn({
        query: async <R>(text: string, params: unknown[] = []) => {
          const result = await tx.query<R>(text, params);
          return { rows: result.rows, rowCount: rowCount(result.affectedRows, result.rows.length) };
        },
        exec: async (text: string) => {
          await tx.exec(text);
        },
      })
    );
  }

  async exec(text: string): Promise<void> {
    await this.db.exec(text);
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}

class PostgresDatabase implements Database {
  readonly kind = 'postgres' as const;

  constructor(private readonly pool: pg.Pool) {}

  async query<T>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    const result = await this.pool.query(text, params);
    return { rows: result.rows as T[], rowCount: result.rowCount ?? result.rows.length };
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn({
        query: async <R>(text: string, params: unknown[] = []) => {
          const r = await client.query(text, params);
          return { rows: r.rows as R[], rowCount: r.rowCount ?? r.rows.length };
        },
        exec: async (text: string) => {
          await client.query(text);
        },
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async exec(text: string): Promise<void> {
    // No parameters: node-postgres uses the simple protocol, which allows several statements
    await this.pool.query(text);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * DATABASE_URL:
 * - "postgres://..." -> node-postgres pool (production)
 * - "pglite://memory" -> in-memory PGlite (tests)
 * - "pglite://./data/pg" -> PGlite persisted to a directory (local dev)
 */
export async function openDatabase(url: string): Promise<Database> {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    return new PostgresDatabase(new pg.Pool({ connectionString: url, max: 10 }));
  }
  if (url.startsWith('pglite://')) {
    const location = url.slice('pglite://'.length);
    const inMemory = location === 'memory' || location === '';
    // A PGlite directory must only be opened by one process at a time
    if (!inMemory) fs.mkdirSync(location, { recursive: true });
    const db = inMemory ? new PGlite() : new PGlite(location);
    await db.waitReady;
    return new PgliteDatabase(db);
  }
  throw new Error('DATABASE_URL must start with postgres://, postgresql:// or pglite://');
}
