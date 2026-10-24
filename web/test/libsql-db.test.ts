import { expect, test } from 'bun:test';
import { connectRemote } from '../lib/libsql-db';

test('refuses to send an auth token over a cleartext URL', () => {
  expect(() => connectRemote('http://db.example.com', 'tok')).toThrow(/libsql:, https: or wss:/);
  expect(() => connectRemote('libsql://db.example.turso.io?tls=0', 'tok')).toThrow();
  expect(() => connectRemote('libsql://db.example.turso.io', 'tok')).not.toThrow();
  expect(() => connectRemote('file::memory:')).not.toThrow();
});
