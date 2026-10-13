import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePrivateFileAtomic } from '../lib/migrate/private-file';

const dir = () => mkdtempSync(join(tmpdir(), 'bugrail-pf-'));

describe('writePrivateFileAtomic', () => {
  test('creates the file owner-only, and tightens an existing looser one by replacing it', () => {
    const d = dir(), f = join(d, 'out.json');
    writeFileSync(f, 'old');
    chmodSync(f, 0o644);
    writePrivateFileAtomic(f, 'new');
    expect(readFileSync(f, 'utf8')).toBe('new');
    if (process.platform !== 'win32') expect(statSync(f).mode & 0o777).toBe(0o600); // POSIX modes only
    expect(readdirSync(d)).toEqual(['out.json']); // no temp left behind
  });
  test('a large export is written completely', () => {
    const d = dir(), f = join(d, 'big.json'), text = 'x'.repeat(5_000_000);
    writePrivateFileAtomic(f, text);
    expect(statSync(f).size).toBe(text.length);
  });
  test('a planted predictable temp file or symlink is never written through', () => {
    const d = dir(), f = join(d, 'out.json'), victim = join(d, 'victim.txt');
    writeFileSync(victim, 'keep');
    symlinkSync(victim, `${f}.${process.pid}.tmp`);
    writePrivateFileAtomic(f, 'secret');
    expect(readFileSync(victim, 'utf8')).toBe('keep');
    expect(readFileSync(f, 'utf8')).toBe('secret');
  });
  test('a failed swap leaves the old export intact and removes the temp', () => {
    const d = dir(), f = join(d, 'sub');
    writeFileSync(join(d, 'keep.json'), 'good');
    // renaming a file over a path that is a directory fails
    require('node:fs').mkdirSync(f);
    expect(() => writePrivateFileAtomic(f, 'x')).toThrow();
    expect(readFileSync(join(d, 'keep.json'), 'utf8')).toBe('good');
    expect(readdirSync(d).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});
