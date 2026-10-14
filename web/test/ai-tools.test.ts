import { beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { applyMigrations } from '../db/migrate';
import { createClock } from '../lib/hlc';
import { createFile, type Ctx } from '../lib/client/repo';
import { chunkText, generate, makeMyMemory, saveStaged, translateFile, validateGenerate, type Translate } from '../lib/client/ai-tools';
import type { Db, Row } from '../lib/db-types';

let db: Db, ctx: Ctx, fid: string;
beforeEach(async () => {
  db = (await connect(':memory:')) as unknown as Db;
  await applyMigrations(db, 'local');
  ctx = { db, clock: createClock('d1'), email: 'alice@bugrail.test', role: 'qa_internal', memberOf: ['ws-a'] };
  fid = String((await createFile(ctx, 'ws-a', 'F')).id);
});
const live = () => db.all('SELECT * FROM testcases WHERE deleted_at IS NULL ORDER BY rowid') as Promise<Row[]>;

describe('validateGenerate', () => {
  test('fields, content and image count are checked before any request', () => {
    const ok = { mode: 'brs' as const, content: 'x', images: [], fields: ['module'] };
    expect(validateGenerate(ok)).toBeNull();
    expect(validateGenerate({ ...ok, fields: [] })).toBe('Pilih minimal 1 field.');
    expect(validateGenerate({ ...ok, content: '  ' })).toBe('Isi konten dulu.');
    expect(validateGenerate({ ...ok, mode: 'screenshot', content: '' })).toBe('Upload minimal 1 screenshot.');
    expect(validateGenerate({ ...ok, mode: 'screenshot', images: Array(6).fill('data:image/png;base64,AA') })).toContain('Maksimal 5');
    expect(validateGenerate({ ...ok, mode: 'screenshot', content: '', images: ['data:image/png;base64,AA'] })).toBeNull();
  });
});

describe('generate', () => {
  const input = { mode: 'text' as const, content: 'login', images: [], fields: ['module', 'scenario'] };
  test('posts the request without images outside screenshot mode and returns the staged rows', async () => {
    let sent: Record<string, unknown> = {};
    const f = (async (_u: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response(JSON.stringify({ testcases: [{ module: 'Login', scenario: 's' }] })); }) as unknown as typeof fetch;
    expect(await generate(input, f)).toEqual([{ module: 'Login', scenario: 's' }]);
    expect(sent.images).toBeUndefined();
  });
  test('the server error message is shown; a bad body does not crash', async () => {
    const e = (async () => new Response(JSON.stringify({ error: 'Fitur Generate AI sedang dinonaktifkan.' }), { status: 503 })) as unknown as typeof fetch;
    expect(await generate(input, e).catch((x) => x.message)).toBe('Fitur Generate AI sedang dinonaktifkan.');
    const g = (async () => new Response('not json', { status: 502 })) as unknown as typeof fetch;
    expect(await generate(input, g).catch((x) => x.message)).toBe('Generate gagal (502)');
    const h = (async () => new Response(JSON.stringify({ testcases: 'nope' }))) as unknown as typeof fetch;
    expect(await generate(input, h)).toEqual([]);
  });
});

describe('saveStaged', () => {
  test('saves complete rows as Open cases without a code, neutralises markup in steps, logs one activity', async () => {
    const n = await saveStaged(ctx, fid, [
      { module: 'Login', scenario: 'ok', steps: '1. <script>alert(1)</script>\n2. press', typeTest: 'Negative' },
      { module: 'Login', scenario: '', steps: 'dropped: no scenario' },
      { module: 'Cart', scenario: 'add', typeTest: 'weird' },
    ]);
    expect(n).toBe(2);
    const rows = await live();
    expect(rows.map((r) => [r.module, r.status, r.code, r.type_test])).toEqual([['Login', 'Open', null, 'Negative'], ['Cart', 'Open', null, 'Positive']]);
    expect(String(rows[0].steps)).not.toContain('<script>');
    expect(String(rows[0].steps)).toContain('lt;script'); // escaped (twice, as the legacy path did), never live markup
    expect((await db.all("SELECT * FROM activity_log WHERE action = 'tc_ai_generate'")).length).toBe(1);
  });
  test('nothing complete means nothing written and a clear error', async () => {
    expect(await saveStaged(ctx, fid, [{ module: '', scenario: 'x' }]).catch((e) => e.message)).toContain('Tidak ada test case yang lengkap');
    expect(await live()).toHaveLength(0);
  });
  test('a failure part-way rolls back, even while the write block stays on', async () => {
    let calls = 0;
    ctx.writeBlock = () => (++calls >= 3 ? 'blocked' : null);
    expect(await saveStaged(ctx, fid, [{ module: 'a', scenario: '1' }, { module: 'a', scenario: '2' }, { module: 'a', scenario: '3' }]).catch((e) => e.message)).toBe('blocked');
    ctx.writeBlock = undefined;
    expect(await live()).toHaveLength(0);
  });
});

describe('translateFile', () => {
  const seed = async () => {
    await db.run("INSERT INTO testcases (id, file_id, module, scenario, test_case, steps, expected_result, status, hlc, status_hlc) VALUES ('t1', ?, 'Login', 'Login dengan password yang salah', 'Pengguna tidak dapat masuk', '<ol><li>buka halaman</li></ol>', 'muncul pesan', 'Open', '0', '0')", fid);
    await db.run("INSERT INTO testcases (id, file_id, module, scenario, test_case, status, hlc, status_hlc) VALUES ('t2', ?, 'Cart', 'The user adds an item to the cart', 'It is shown in the list', 'Open', '0', '0')", fid);
  };
  const fake: Translate = async (text, pair) => (text.trim() ? text.split('\n').map((l) => l.replace(/^(\d+\. )?/, (m) => `${m}[${pair}] `)).join('\n') : '');
  test('each case is translated in its own direction, steps stay a list, other fields are kept', async () => {
    await seed();
    expect(await translateFile(ctx, fid, fake)).toBe(2);
    const [a, b] = await live();
    expect(a.scenario).toBe('[id|en] Login dengan password yang salah');
    expect(String(a.steps)).toContain('<li>');
    expect(String(a.steps)).toContain('<li>[id|en] buka halaman</li>');
    expect(b.scenario).toBe('[en|id] The user adds an item to the cart');
    expect([a.module, a.status]).toEqual(['Login', 'Open']);
  });
  test('one failing translation changes nothing', async () => {
    await seed();
    let n = 0;
    const flaky: Translate = async (t) => { if (++n === 9) throw new Error('Translate API error'); return `x${t}`; };
    expect(await translateFile(ctx, fid, flaky).catch((e) => e.message)).toBe('Translate API error');
    expect((await live())[0].scenario).toBe('Login dengan password yang salah');
  });
  test('write block set before writing: nothing changes', async () => {
    await seed();
    ctx.writeBlock = () => 'Read only';
    expect(await translateFile(ctx, fid, fake).catch((e) => e.message)).toBe('Read only');
    ctx.writeBlock = undefined;
    expect((await live())[0].scenario).toBe('Login dengan password yang salah');
  });
  test('a write failing part-way restores rows already written', async () => {
    await seed();
    let calls = 0;
    ctx.afterWrite = () => { if (++calls === 2) throw new Error('disk full'); };
    expect(await translateFile(ctx, fid, fake).catch((e) => e.message)).toBe('disk full');
    const [a, b] = await live();
    expect([a.scenario, a.steps, b.scenario]).toEqual(['Login dengan password yang salah', '<ol><li>buka halaman</li></ol>', 'The user adds an item to the cart']);
  });
  test('an empty file is reported', async () => {
    expect(await translateFile(ctx, fid, fake).catch((e) => e.message)).toBe('File ini belum punya test case.');
  });
});

describe('myMemory', () => {
  const reply = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
  test('quota and length errors served as HTTP 200 are failures, not translations', async () => {
    const quota = reply({ responseStatus: 429, responseDetails: 'YOU USED ALL AVAILABLE FREE TRANSLATIONS', responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS' } });
    expect(await makeMyMemory(quota)('halo', 'id|en').catch((e) => e.message)).toContain('Translate API error: YOU USED ALL');
    const len = reply({ responseStatus: 200, responseData: { translatedText: 'QUERY LENGTH LIMIT EXCEEDED. MAX ALLOWED QUERY : 500 CHARS' } });
    expect(await makeMyMemory(len)('halo', 'id|en').catch((e) => e.message)).toContain('Translate API error');
  });
  test('long text is sent in chunks of at most 450 chars and rejoined', async () => {
    const qs: string[] = [];
    const f = (async (url: string) => {
      const q = decodeURIComponent(new URL(url).searchParams.get('q')!);
      qs.push(q);
      return { ok: true, json: async () => ({ responseStatus: 200, responseData: { translatedText: q.toUpperCase() } }) };
    }) as unknown as typeof fetch;
    const text = Array.from({ length: 30 }, (_, i) => `langkah nomor ${i} dilakukan.`).join('\n');
    const out = await makeMyMemory(f)(text, 'id|en');
    expect(qs.length).toBeGreaterThan(1);
    expect(qs.every((q) => q.length <= 450)).toBe(true);
    expect(out).toBe(text.toUpperCase());
    expect(chunkText('x'.repeat(1000)).every((c) => c.length <= 450)).toBe(true);
  });
});
