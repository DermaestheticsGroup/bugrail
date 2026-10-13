import { expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { applyMigrations } from '../db/migrate';
import type { Db } from '../lib/db-types';
import { USERS, seedUsers, userFromHeader } from '../lib/sync/users';

test('userFromHeader rejects inherited property names and empty', () => {
  for (const h of ['constructor', '__proto__', 'toString', 'hasOwnProperty', '', null]) expect(userFromHeader(h)).toBeUndefined();
});
test('userFromHeader returns a known user', () => {
  expect(userFromHeader('alice')).toBe(USERS.alice);
});
test('userFromHeader returns undefined in production', () => {
  const env = process.env as Record<string, string | undefined>;
  const prev = env.NODE_ENV;
  env.NODE_ENV = 'production';
  try {
    expect(userFromHeader('admin')).toBeUndefined();
  } finally {
    env.NODE_ENV = prev;
  }
});
test('dev auth is off unless BUGRAIL_DEV_AUTH=1, even in development', async () => {
  const env = process.env as Record<string, string | undefined>;
  const prev = [env.NODE_ENV, env.BUGRAIL_DEV_AUTH];
  env.NODE_ENV = 'development';
  delete env.BUGRAIL_DEV_AUTH;
  try {
    expect(userFromHeader('admin')).toBeUndefined();
    const db = (await connect(':memory:')) as unknown as Db;
    await applyMigrations(db, 'server');
    await seedUsers(db);
    expect(Number((await db.get('SELECT count(*) AS n FROM users')).n)).toBe(0);
  } finally {
    [env.NODE_ENV, env.BUGRAIL_DEV_AUTH] = prev;
  }
});
