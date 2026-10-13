import { describe, expect, test } from 'bun:test';
import { createClock } from '../lib/hlc';

describe('hlc', () => {
  test('format is ms:15-counter:5-device', () => {
    const c = createClock('dev-a', () => 1_700_000_000_000);
    expect(c.now()).toBe('001700000000000-00000-dev-a');
  });

  test('strictly increasing with a frozen wall clock', () => {
    const c = createClock('dev-a', () => 1000);
    let prev = '';
    for (let i = 0; i < 10_000; i++) {
      const next = c.now();
      expect(next > prev).toBe(true);
      prev = next;
    }
  });

  test('wall clock going backwards does not go backwards', () => {
    let wall = 5000;
    const c = createClock('dev-a', () => wall);
    const a = c.now();
    wall = 1000;
    expect(c.now() > a).toBe(true);
  });

  test('counter overflow rolls into the next millisecond', () => {
    const c = createClock('dev-a', () => 1000);
    let prev = '';
    for (let i = 0; i < 100_002; i++) prev = c.now();
    expect(prev.startsWith('000000000001001-')).toBe(true);
  });

  test('two devices at the same instant never produce equal values', () => {
    const a = createClock('dev-a', () => 1000);
    const b = createClock('dev-b', () => 1000);
    const ha = a.now();
    const hb = b.now();
    expect(ha).not.toBe(hb);
    expect(ha < hb).toBe(true); // tie broken by deviceId
  });

  // Review Focus 5
  test('after observing a fast-clock hlc, now() is greater and still increasing', () => {
    const c = createClock('dev-a', () => 1000);
    const remote = '000000009999999-00042-dev-z';
    c.observe(remote);
    const n1 = c.now();
    const n2 = c.now();
    expect(n1 > remote).toBe(true);
    expect(n2 > n1).toBe(true);
  });

  test('observing an older hlc changes nothing', () => {
    const c = createClock('dev-a', () => 5000);
    const before = c.now();
    c.observe('000000000000001-00000-dev-z');
    expect(c.now() > before).toBe(true);
  });

  test('deviceId containing dashes (UUID) still parses on observe', () => {
    const c = createClock('11111111-2222-3333-4444-555555555555', () => 1000);
    const h = c.now();
    const d = createClock('dev-b', () => 1);
    d.observe(h);
    expect(d.now() > h).toBe(true);
  });
});

describe('hlc observe (ADR-001 gap f)', () => {
  const wall = 1_700_000_000_000;
  const at = (ms: number) => `${String(ms).padStart(15, '0')}-00000-x`;
  test('ignores malformed strings', () => {
    const c = createClock('dev-a', () => wall);
    for (const bad of ['', 'garbage', '9-9', `${'9'.repeat(15)}`, `${String(wall + 5).padStart(15, '0')}-zz-x`]) c.observe(bad);
    expect(c.now()).toBe(`${String(wall).padStart(15, '0')}-00000-dev-a`);
  });
  test('ignores an HLC more than 24 h ahead of the wall clock', () => {
    const c = createClock('dev-a', () => wall);
    c.observe(at(wall + 24 * 3600_000 + 1));
    expect(c.now()).toBe(`${String(wall).padStart(15, '0')}-00000-dev-a`);
    c.observe(at(wall + 1000));
    expect(c.now()).toBe(`${String(wall + 1000).padStart(15, '0')}-00001-dev-a`);
  });
});
