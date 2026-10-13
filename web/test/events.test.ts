import { beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { applyMigrations } from '../db/migrate';
import { broadcast, subscribe } from '../lib/server/events';
import { push } from '../lib/sync/server';
import { USERS, seedUsers } from '../lib/sync/users';
import type { Db } from '../lib/db-types';

const h = '000000000000001-00000-a';

describe('broadcast', () => {
  test('reaches matching workspaces and admins only, stops after unsubscribe', () => {
    const got: string[] = [];
    const offs = [
      subscribe(false, ['ws-a'], () => got.push('a')),
      subscribe(false, ['ws-v'], () => got.push('v')),
      subscribe(true, [], () => got.push('admin')),
    ];
    broadcast(['ws-a']);
    expect(got.sort()).toEqual(['a', 'admin']);
    offs.forEach((o) => o());
    broadcast(['ws-a']);
    expect(got.length).toBe(2);
  });
});

describe('push reports touched workspaces', () => {
  let db: Db;
  beforeEach(async () => {
    db = (await connect(':memory:')) as unknown as Db;
    await applyMigrations(db, 'server');
    await seedUsers(db);
  });

  test('owner and every sharing workspace are touched', async () => {
    await push(db, USERS.admin, [
      { tbl: 'files', row: { id: 'f', name: 'f', workspace_id: 'ws-a', hlc: h } },
      { tbl: 'file_shares', row: { id: 'f:ws-v', file_id: 'f', workspace_id: 'ws-v', hlc: h } },
    ]);
    const touched = new Set<string>();
    await push(db, USERS.alice, [{ tbl: 'bugs', row: { id: 'b', file_id: 'f', title: 't', status_code: 'OPEN', status_hlc: h, hlc: h } }], touched);
    expect([...touched].sort()).toEqual(['ws-a', 'ws-v']);
  });

  test('a rejected push touches nothing', async () => {
    const touched = new Set<string>();
    await push(db, USERS.alice, [{ tbl: 'files', row: { id: 'f', name: 'f', workspace_id: 'ws-v', hlc: h } }], touched);
    expect(touched.size).toBe(0);
  });
});
