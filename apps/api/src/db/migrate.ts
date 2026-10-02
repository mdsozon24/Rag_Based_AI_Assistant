/**
 * Forward-only SQL migrations from apps/api/migrations (NNNN_name.sql), each in its own
 * transaction. Applied migrations are recorded with a checksum; if an applied file changes, startup
 * fails: never edit an applied migration, add a new one.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from './database.ts';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export function checksum(sql: string): string {
  // Normalize line endings so a Windows checkout does not look like an edit
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

export function readMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((name) => {
      const sql = fs.readFileSync(path.join(dir, name), 'utf8');
      return { name, sql, checksum: checksum(sql) };
    });
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/** Apply pending migrations; returns the names applied. */
export async function migrate(db: Database, migrations: MigrationFile[] = readMigrations()): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migration (
    name text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const applied = new Map(
    (await db.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migration')).rows.map((r) => [r.name, r.checksum])
  );
  for (const [name, sum] of applied) {
    const file = migrations.find((m) => m.name === name);
    if (!file) throw new MigrationError(`Applied migration ${name} is missing from the migrations folder`);
    if (file.checksum !== sum) throw new MigrationError(`Migration ${name} was modified after it was applied; add a new migration instead`);
  }
  const done: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.name)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.query('INSERT INTO schema_migration (name, checksum) VALUES ($1, $2)', [migration.name, migration.checksum]);
    });
    done.push(migration.name);
  }
  return done;
}
