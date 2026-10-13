import { test } from 'bun:test';
import assert from 'node:assert';
import { textToStepsHtml, stepsHtmlToText, detectLang } from '../lib/domain/steps';
import { moduleAbbrev } from '../lib/domain/ids';
import { computeBugResolutionStats } from '../lib/domain/status';

test('textToStepsHtml: numbered lines become <ol>, others <p>, HTML passes through, input escaped', () => {
  assert.strictEqual(textToStepsHtml('1. Buka\n2) Klik'), '<ol><li>Buka</li><li>Klik</li></ol>');
  assert.strictEqual(textToStepsHtml('Buka\nKlik'), '<p>Buka</p><p>Klik</p>');
  assert.strictEqual(textToStepsHtml('<p>x</p>'), '<p>x</p>');
  assert.strictEqual(textToStepsHtml('a < b'), '<p>a &lt; b</p>');
  assert.strictEqual(textToStepsHtml(null), '');
  assert.strictEqual(textToStepsHtml('  '), '');
});

test('stepsHtmlToText: lists re-numbered, paragraphs on lines, round trip', () => {
  assert.strictEqual(stepsHtmlToText('<ol><li>Buka</li><li>Klik</li></ol>'), '1. Buka\n2. Klik');
  assert.strictEqual(stepsHtmlToText('<ul><li>a</li><li>b</li></ul>'), '- a\n- b');
  assert.strictEqual(stepsHtmlToText('<p>x</p><p>y &amp; z</p>'), 'x\ny & z');
  assert.strictEqual(stepsHtmlToText('a<br>b'), 'a\nb');
  assert.strictEqual(stepsHtmlToText(''), '');
  assert.strictEqual(stepsHtmlToText(null), '');
  const text = '1. Buka\n2. Klik';
  assert.strictEqual(stepsHtmlToText(textToStepsHtml(text)), text);
});

test('detectLang: stopword count, ties and empty fall back to id', () => {
  assert.strictEqual(detectLang('the user must click the button'), 'en');
  assert.strictEqual(detectLang('tombol harus diklik dan tidak error'), 'id');
  assert.strictEqual(detectLang(''), 'id');
  assert.strictEqual(detectLang(undefined), 'id');
});

test('moduleAbbrev', () => {
  assert.strictEqual(moduleAbbrev('Login'), 'LOG');
  assert.strictEqual(moduleAbbrev('User Management'), 'UMS');
  assert.strictEqual(moduleAbbrev('A B C D'), 'ABC');
  assert.strictEqual(moduleAbbrev('Go'), 'GOX');
  assert.strictEqual(moduleAbbrev(''), 'TC');
  assert.strictEqual(moduleAbbrev(undefined), 'TC');
});

test('computeBugResolutionStats: counts only CLOSED bugs with a logged move to CLOSED', () => {
  const h = 3600000, t0 = '2026-01-01T00:00:00.000Z';
  const at = (hours: number) => new Date(Date.parse(t0) + hours * h).toISOString();
  const r = computeBugResolutionStats([
    { status: 'CLOSED', reportDate: t0, activity: [{ to: 'RETEST', at: at(1) }, { to: 'CLOSED', at: at(4) }] },
    { status: 'CLOSED', reportDate: t0, activity: [{ to: 'CLOSED', at: at(2) }] },
    { status: 'CLOSED', reportDate: t0, activity: [] },
    { status: 'OPEN', reportDate: t0, activity: [{ to: 'CLOSED', at: at(9) }] },
    { status: 'CLOSED', activity: [{ to: 'CLOSED', at: at(9) }] },
  ]);
  assert.deepStrictEqual(r, { resolvedCount: 2, avgHours: 3 });
  assert.deepStrictEqual(computeBugResolutionStats(null), { resolvedCount: 0, avgHours: 0 });
});
