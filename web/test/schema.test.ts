import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { connect } from '@tursodatabase/database';
import { TABLES, SYNCED_TABLES } from '../db/tables';
import { applyMigrations } from '../db/migrate';
import { MIGRATIONS } from '../db/schema/index';
import type { Db } from '../lib/db-types';

const fresh = async () => (await connect(':memory:')) as unknown as Db;
const sqlFile = (n: string) => readFileSync(new URL(`../db/schema/${n}`, import.meta.url), 'utf8');

async function shape(db: Db): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const tables = await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  for (const t of tables) out[t.name] = (await db.all(`PRAGMA table_info(${t.name})`)).map((c) => `${c.name}:${c.type}:${c.dflt_value}:${c.notnull}:${c.pk}`).sort();
  // Indexes and the stored CREATE text cover constraints and anything table_info misses.
  const objs = await db.all("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
  for (const o of objs) out[`${o.type}:${o.name}`] = [String(o.sql).replace(/\s+/g, ' ').trim()];
  return out;
}

describe('schema', () => {
  for (const name of SYNCED_TABLES) {
    test(`${name} columns match TABLES`, async () => {
      const db = await fresh();
      await applyMigrations(db, 'server');
      const cols = (await db.all(`PRAGMA table_info(${name})`)).map((c) => c.name);
      expect(new Set(cols)).toEqual(new Set(TABLES[name].columns));
    });
  }

  test('TABLES lists every synced table in the data model', () => {
    expect(new Set(SYNCED_TABLES)).toEqual(new Set([
      'files', 'file_shares', 'testcases', 'bugs', 'bug_events', 'bug_status_master', 'custom_field_defs', 'activity_log',
    ]));
    expect(TABLES.testcases.kind).toBe('lww+status');
    expect(TABLES.bugs.kind).toBe('lww+status');
    expect(TABLES.bug_events.kind).toBe('insert-only');
    expect(TABLES.activity_log.kind).toBe('insert-only');
  });

  for (const scope of ['server', 'local'] as const) {
    test(`${scope}: idempotent, records the highest file number`, async () => {
      const db = await fresh();
      const v1 = await applyMigrations(db, scope);
      const v2 = await applyMigrations(db, scope);
      expect(v1).toBe(4);
      expect(v2).toBe(v1);
      const [meta, key] = scope === 'server' ? ['sync_meta', 'schema_version'] : ['meta', 'applied_version'];
      expect(Number((await db.get(`SELECT value FROM ${meta} WHERE key = '${key}'`)).value)).toBe(v1);
    });
  }

  test('server keeps the seq counter across re-runs', async () => {
    const db = await fresh();
    await applyMigrations(db, 'server');
    await db.run("UPDATE sync_meta SET value = 7 WHERE key = 'seq'");
    await applyMigrations(db, 'server');
    expect(Number((await db.get("SELECT value FROM sync_meta WHERE key = 'seq'")).value)).toBe(7);
  });

  test('.sql files and exported strings build the same schema', async () => {
    for (const [, file, sql] of [...MIGRATIONS.server, ...MIGRATIONS.local]) {
      const a = await fresh();
      const b = await fresh();
      await a.exec(sqlFile(file));
      await b.exec(sql);
      const sa = await shape(a);
      expect(Object.keys(sa).length).toBeGreaterThan(0);
      expect(await shape(b)).toEqual(sa);
    }
  });
});
