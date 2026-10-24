import { expect, test } from 'bun:test';
import { basicAuthOk } from '../proxy';

const b = (s: string) => `Basic ${btoa(s)}`;

test('basic auth is off unless both credentials are set', () => {
  expect(basicAuthOk(null, undefined, undefined)).toBe(true);
  expect(basicAuthOk(null, 'u', undefined)).toBe(true);
});

test('basic auth checks the header', () => {
  expect(basicAuthOk(null, 'u', 'p')).toBe(false);
  expect(basicAuthOk(b('u:x'), 'u', 'p')).toBe(false);
  expect(basicAuthOk('Bearer abc', 'u', 'p')).toBe(false);
  expect(basicAuthOk(b('u:p'), 'u', 'p')).toBe(true);
});
