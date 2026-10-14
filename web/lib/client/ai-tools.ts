// TestForge (AI test case generator) and Translate for a test case file. Both write through the normal local-write path.
// The AI call itself is /api/testforge/generate (online only); nothing is saved until the user reviews the staged rows.
import type { Row } from '../db-types';
import { detectLang, stepsHtmlToText, textToStepsHtml } from '../domain/steps';
import { createTestcase, logActivity, softDelete, upsertRow, type Ctx } from './repo';

export const TESTFORGE_FIELDS = [
  { key: 'module', label: 'Module' }, { key: 'roleUser', label: 'Role User' }, { key: 'scenario', label: 'Scenario' }, { key: 'testCase', label: 'Test Case' },
  { key: 'preconditions', label: 'Pre-Condition' }, { key: 'steps', label: 'Test Step' }, { key: 'testData', label: 'Test Data' },
  { key: 'expectedResult', label: 'Expected Result' }, { key: 'typeTest', label: 'Type Test' },
];
export const MAX_IMAGES = 5;

export type Staged = Record<string, string>;

// AI text is untrusted: < and > are neutralised so textToStepsHtml's "already HTML" passthrough never treats it as markup.
const plain = (s: unknown) => String(s ?? '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// All-or-nothing like import: a failure part-way soft-deletes what was written (the undo ignores the write block that may have caused it).
export async function saveStaged(ctx: Ctx, fileId: string, staged: Staged[]): Promise<number> {
  const blocked = ctx.writeBlock?.();
  if (blocked) throw new Error(blocked);
  const rows = staged.filter((t) => (t.scenario ?? '').trim() && (t.module ?? '').trim());
  if (!rows.length) throw new Error('Tidak ada test case yang lengkap (Module dan Scenario wajib).');
  const ws = ((await ctx.db.get('SELECT workspace_id FROM files WHERE id = ?', fileId)) as Row | undefined)?.workspace_id as string | null ?? null;
  const created: string[] = [];
  try {
    for (const t of rows) {
      const row = await createTestcase(ctx, fileId, {
        module: t.module.trim(), role_user: t.roleUser ?? '', scenario: t.scenario.trim(), test_case: t.testCase ?? '', preconditions: t.preconditions ?? '',
        steps: textToStepsHtml(plain(t.steps)), test_data: t.testData ?? '', expected_result: t.expectedResult ?? '', actual_result: '',
        type_test: t.typeTest === 'Negative' ? 'Negative' : 'Positive', status: 'Open', execution_date: '',
      });
      created.push(String(row.id));
    }
  } catch (e) {
    const stuck: string[] = [];
    for (const id of created) await softDelete({ ...ctx, writeBlock: undefined }, 'testcases', id).catch(() => { stuck.push(id); });
    throw stuck.length ? new Error(`${(e as Error).message} (gagal membatalkan ${stuck.length} baris: ${stuck.join(', ')})`) : e;
  }
  await logActivity(ctx, ws, 'tc_ai_generate', `${rows.length} Test Case digenerate via AI (TestForge)`);
  return rows.length;
}

export interface GenerateInput { mode: 'brs' | 'screenshot' | 'text'; content: string; images: string[]; fields: string[] }

export function validateGenerate(i: GenerateInput): string | null {
  if (!i.fields.length) return 'Pilih minimal 1 field.';
  if (i.mode !== 'screenshot' && !i.content.trim()) return 'Isi konten dulu.';
  if (i.mode === 'screenshot' && !i.images.length) return 'Upload minimal 1 screenshot.';
  if (i.mode === 'screenshot' && i.images.length > MAX_IMAGES) return `Maksimal ${MAX_IMAGES} screenshot per generate.`;
  return null;
}

export async function generate(i: GenerateInput, fetchFn: typeof fetch = fetch): Promise<Staged[]> {
  const bad = validateGenerate(i);
  if (bad) throw new Error(bad);
  const res = await fetchFn('/api/testforge/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: i.mode, content: i.content, images: i.mode === 'screenshot' ? i.images : undefined, fields: i.fields }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Generate gagal (${res.status})`);
  return Array.isArray(data.testcases) ? data.testcases : [];
}

// ---- Translate ----
export type Translate = (text: string, langpair: string) => Promise<string>;

// Public MyMemory API, as the legacy page did. It receives the text: the confirm dialog says so.
export const myMemory: Translate = async (text, langpair) => {
  const t = text.trim();
  if (!t) return '';
  const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(t)}&langpair=${langpair}`);
  if (!res.ok) throw new Error('Translate API error');
  const data = await res.json();
  return data?.responseData?.translatedText || t;
};

const TEXT_FIELDS = ['scenario', 'test_case', 'preconditions', 'test_data', 'expected_result', 'actual_result'];

// Direction per test case from its own scenario and test case text (ID to EN or EN to ID). Every result is computed before anything is written,
// so a failing translation changes nothing.
export async function translateFile(ctx: Ctx, fileId: string, tr: Translate): Promise<number> {
  const rows = (await ctx.db.all('SELECT * FROM testcases WHERE file_id = ? AND deleted_at IS NULL ORDER BY rowid', fileId)) as Row[];
  if (!rows.length) throw new Error('File ini belum punya test case.');
  const out: { id: string; patch: Row }[] = [];
  for (const t of rows) {
    const from = detectLang([t.scenario, t.test_case].filter(Boolean).join(' '));
    const pair = `${from}|${from === 'id' ? 'en' : 'id'}`;
    const steps = stepsHtmlToText(String(t.steps ?? ''));
    const [fields, translatedSteps] = await Promise.all([Promise.all(TEXT_FIELDS.map((f) => tr(String(t[f] ?? ''), pair))), steps ? tr(steps, pair) : Promise.resolve('')]);
    const patch: Row = Object.fromEntries(TEXT_FIELDS.map((f, i) => [f, fields[i]]));
    if (translatedSteps) patch.steps = textToStepsHtml(plain(translatedSteps));
    out.push({ id: String(t.id), patch });
  }
  for (const o of out) await upsertRow(ctx, 'testcases', o.id, o.patch);
  const ws = ((await ctx.db.get('SELECT workspace_id FROM files WHERE id = ?', fileId)) as Row | undefined)?.workspace_id as string | null ?? null;
  await logActivity(ctx, ws, 'testcase_update', `${rows.length} test case diterjemahkan`);
  return rows.length;
}
