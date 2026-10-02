/**
 * Migrations: apply cleanly, are idempotent, and applied files never change.
 * checksums.json pins every migration that may have been applied somewhere; editing one fails here
 * (and at startup on any database that already ran it). Add new migrations instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/database.ts';
import { migrate, MIGRATIONS_DIR, readMigrations } from '../src/db/migrate.ts';

const LOCK = path.join(MIGRATIONS_DIR, 'checksums.json');

describe('migrations', () => {
  it('apply to an empty database, then are a no-op', async () => {
    const db = await openDatabase('pglite://memory');
    expect(await migrate(db)).toEqual(readMigrations().map((m) => m.name));
    expect(await migrate(db)).toEqual([]);
    await db.close();
  });

  it('match the pinned checksums (applied migrations are never edited)', () => {
    const pinned = JSON.parse(fs.readFileSync(LOCK, 'utf8')) as Record<string, string>;
    const current = Object.fromEntries(readMigrations().map((m) => [m.name, m.checksum]));
    for (const [name, sum] of Object.entries(pinned)) {
      expect(current[name], `${name} was removed`).toBeDefined();
      expect(current[name], `${name} was edited; add a new migration instead`).toBe(sum);
    }
    const unpinned = Object.keys(current).filter((n) => !(n in pinned));
    expect(unpinned, `pin new migrations in ${LOCK}`).toEqual([]);
  });

  it('refuse to start on a database where an applied migration differs', async () => {
    const db = await openDatabase('pglite://memory');
    await migrate(db);
    const edited = readMigrations().map((m) => ({ ...m, checksum: 'edited' }));
    await expect(migrate(db, edited)).rejects.toThrow(/was modified after it was applied/);
    await db.close();
  });

  it('enable row-level security on every table with an org_id', async () => {
    const db = await openDatabase('pglite://memory');
    await migrate(db);
    const tables = await db.query<{ table_name: string; rls: boolean }>(
      `SELECT c.table_name, cl.relrowsecurity AS rls
       FROM information_schema.columns c JOIN pg_class cl ON cl.relname = c.table_name
       WHERE c.table_schema = 'public' AND c.column_name = 'org_id'`
    );
    expect(tables.rows.length).toBeGreaterThan(5);
    for (const row of tables.rows) expect(row.rls, `${row.table_name} needs row-level security`).toBe(true);
    await db.close();
  });
});
