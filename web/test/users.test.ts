import { expect, test } from 'bun:test';
import { USERS, userFromHeader } from '../lib/sync/users';

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
