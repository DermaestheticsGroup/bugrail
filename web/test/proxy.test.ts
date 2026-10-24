import { expect, test } from 'bun:test';
import { basicAuthOk } from '../proxy';

const b = (s: string) => `Basic ${btoa(s)}`;

test('basic auth is off unless both credentials are set', () => {
  expect(basicAuthOk(null, '', '')).toBe(true);
  expect(basicAuthOk(null, 'u', '')).toBe(true);
});

test('basic auth checks the header', () => {
  expect(basicAuthOk(null, 'u', 'p')).toBe(false);
  expect(basicAuthOk(b('u:x'), 'u', 'p')).toBe(false);
  expect(basicAuthOk('Bearer abc', 'u', 'p')).toBe(false);
  expect(basicAuthOk(b('u:pp'), 'u', 'p')).toBe(false);
  expect(basicAuthOk(b('u:'), 'u', 'p')).toBe(false);
  expect(basicAuthOk(b('u:p'), 'u', 'p')).toBe(true);
});

test('basic auth rejects invalid base64 and decodes UTF-8 credentials', () => {
  expect(basicAuthOk('Basic !!!', 'u', 'p')).toBe(false);
  const utf8 = `Basic ${Buffer.from('u:pässwörd').toString('base64')}`;
  expect(basicAuthOk(utf8, 'u', 'pässwörd')).toBe(true);
});
