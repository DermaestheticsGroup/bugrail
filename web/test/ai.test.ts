import { describe, expect, test } from 'bun:test';
import { analyzeBug, generateTestCases, type Ask } from '../lib/server/ai';

const say = (text: string | null): Ask => async () => text;
const gen = (body: object, ask: Ask = say('[]'), key: string | undefined = 'k', on = true) => generateTestCases(body, key, ask, on);

describe('generateTestCases', () => {
  test('disabled by default gives 503', async () => {
    expect((await gen({}, say('[]'), 'k', false)).status).toBe(503);
  });
  test('validates mode, fields, content, images and key', async () => {
    expect((await gen({ mode: 'x' })).body.error).toBe('Invalid mode');
    expect((await gen({ mode: 'text', content: 'a', fields: ['nope'] })).body.error).toBe('No valid fields selected');
    expect((await gen({ mode: 'text', content: ' ', fields: ['module'] })).body.error).toBe('Content is required for this mode');
    expect((await gen({ mode: 'screenshot', fields: ['module'], images: [] })).status).toBe(400);
    expect((await gen({ mode: 'screenshot', fields: ['module'], images: Array(6).fill('x') })).status).toBe(400);
    expect((await gen({ mode: 'text', content: 'a', fields: ['module'] }, say('[]'), '')).status).toBe(500);
  });
  test('keeps only requested string fields, defaults the rest to empty', async () => {
    const r = await gen({ mode: 'text', content: 'a', fields: ['module', 'scenario'] }, say('noise [{"module":"Login","scenario":5,"extra":"x"}] tail'));
    expect(r).toEqual({ status: 200, body: { testcases: [{ module: 'Login', scenario: '' }] } });
  });
  test('provider failure and unparsable output give 502', async () => {
    const b = { mode: 'text', content: 'a', fields: ['module'] };
    expect((await gen(b, say(null))).status).toBe(502);
    expect((await gen(b, say('no array here'))).body.error).toBe('AI response had no JSON array');
    expect((await gen(b, say('[not json]'))).body.error).toBe('AI response JSON parse failed');
  });
  test('a screenshot request with no usable image is rejected before calling the model', async () => {
    let called = false;
    const r = await gen({ mode: 'screenshot', fields: ['module'], images: ['http://evil/x', 'junk'] }, async () => { called = true; return '[]'; });
    expect(r.status).toBe(400);
    expect(called).toBe(false);
  });
  test('only data-URL images are forwarded', async () => {
    let parts: any[] = [];
    await gen({ mode: 'screenshot', fields: ['module'], images: ['data:image/png;base64,AAA', 'http://evil/x'] }, async (_k, p) => { parts = p as any[]; return '[]'; });
    expect(parts.length).toBe(2);
    expect(parts[1].inline_data).toEqual({ mime_type: 'image/png', data: 'AAA' });
  });
});

describe('analyzeBug', () => {
  const tc = { actualResult: 'boom', expectedResult: 'ok' };
  test('requires actualResult and a key', async () => {
    expect((await analyzeBug({ testcase: { actualResult: ' ' } }, 'k', say('{}'))).status).toBe(400);
    expect((await analyzeBug({}, 'k', say('{}'))).status).toBe(400);
    expect((await analyzeBug({ testcase: tc }, undefined, say('{}'))).status).toBe(500);
  });
  test('clamps lengths and drops values outside the allowed lists', async () => {
    const r = await analyzeBug({ testcase: tc }, 'k', say(JSON.stringify({ title: 'T'.repeat(300), severity: 'Catastrophic', priority: 'Urgent', analysis: ' ok ' })));
    expect(r.status).toBe(200);
    expect((r.body.title as string).length).toBe(150);
    expect(r.body).toMatchObject({ severity: '', priority: 'Urgent', analysis: 'ok' });
  });
  test('an empty array from the provider gives 502', async () => {
    expect((await analyzeBug({ testcase: tc }, 'k', say('[]'))).status).toBe(502);
  });
  test('unparsable output gives 502', async () => {
    expect((await analyzeBug({ testcase: tc }, 'k', say('nope'))).status).toBe(502);
    expect((await analyzeBug({ testcase: tc }, 'k', say(null))).status).toBe(502);
  });
});
