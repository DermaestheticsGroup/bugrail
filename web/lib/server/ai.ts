// Ports /api/testforge/generate and /api/bug/analyze from server/app.js. `ask` is injected so tests never call Gemini.
export type Ask = (apiKey: string, parts: unknown[]) => Promise<string | null>;
export type AiResult = { status: number; body: Record<string, unknown> };
const fail = (status: number, error: string, extra: object = {}): AiResult => ({ status, body: { error, ...extra } });

export const VALID_FIELDS = ['module', 'roleUser', 'scenario', 'testCase', 'preconditions', 'steps', 'testData', 'expectedResult', 'typeTest'];
const BUG_SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
const BUG_PRIORITIES = ['Urgent', 'High', 'Medium', 'Low'];
const BUG_TC_FIELDS = ['module', 'scenario', 'testCase', 'preconditions', 'steps', 'testData', 'expectedResult', 'actualResult'];

export const askGemini: Ask = async (apiKey, parts) => {
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ contents: [{ parts }] }),
  });
  if (!res.ok) { console.error('Gemini API error', res.status, await res.text()); return null; }
  return (await res.json())?.candidates?.[0]?.content?.parts?.[0]?.text || '';
};

function testForgePrompt(mode: string, content: string, fields: string[], module: string): string {
  const moduleHint = module ? `The module/feature under test is "${module}".` : '';
  const source = mode === 'brs' ? 'the following BRS (Business Requirement Specification) text'
    : mode === 'screenshot' ? 'the attached application screenshot(s)' : 'the following description';
  return `You are a QA test case generator. Based on ${source}, generate a JSON array of test cases.
${moduleHint}
Each object in the array must contain ONLY these fields: ${fields.join(', ')}.
Field meanings: module=feature area name, roleUser=user role performing the action, scenario=short scenario title, testCase=detailed test case description, preconditions=state required before the test, steps=numbered steps, testData=input data used, expectedResult=what should happen, typeTest=Positive or Negative.
Respond with ONLY the JSON array, no markdown fences, no explanation.
${mode !== 'screenshot' ? `Content:\n${content}` : (content ? `Additional instructions: ${content}` : '')}`;
}

export async function generateTestCases(body: any, apiKey: string | undefined, ask: Ask, enabled = process.env.TESTFORGE_ENABLED === '1'): Promise<AiResult> {
  if (!enabled) return fail(503, 'Fitur Generate AI sedang dinonaktifkan.');
  const { mode, content, images, fields, module } = body || {};
  if (!['brs', 'screenshot', 'text'].includes(mode)) return fail(400, 'Invalid mode');
  const cleanFields = Array.isArray(fields) ? fields.filter((f) => VALID_FIELDS.includes(f)) : [];
  if (!cleanFields.length) return fail(400, 'No valid fields selected');
  if (mode !== 'screenshot' && !String(content || '').trim()) return fail(400, 'Content is required for this mode');
  if (mode === 'screenshot' && (!Array.isArray(images) || !images.length)) return fail(400, 'At least one image is required for screenshot mode');
  if (mode === 'screenshot' && images.length > 5) return fail(400, 'Maksimal 5 screenshot per generate.');
  if (!apiKey) return fail(500, 'GEMINI_API_KEY belum diisi. Isi di halaman Settings atau .env server.');

  const parts: unknown[] = [{ text: testForgePrompt(mode, content, cleanFields, module) }];
  if (mode === 'screenshot') {
    for (const dataUrl of images) {
      const m = String(dataUrl).match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
      if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
    }
  }
  // Never call the model for a screenshot it would not receive.
  if (mode === 'screenshot' && parts.length === 1) return fail(400, 'No valid image (expected image data URLs)');
  const raw = await ask(apiKey, parts);
  if (raw === null) return fail(502, 'AI provider error');
  const json = raw.match(/\[[\s\S]*\]/);
  if (!json) return fail(502, 'AI response had no JSON array', { raw });
  let parsed: unknown;
  try { parsed = JSON.parse(json[0]); } catch { return fail(502, 'AI response JSON parse failed', { raw }); }
  if (!Array.isArray(parsed)) return fail(502, 'AI response was not an array', { raw });
  const testcases = parsed.map((tc) => Object.fromEntries(cleanFields.map((f) => [f, typeof tc?.[f] === 'string' ? tc[f] : ''])));
  return { status: 200, body: { testcases } };
}

function analyzePrompt(tc: Record<string, unknown>): string {
  const lines = BUG_TC_FIELDS.map((f) => `${f}: ${String(tc[f] || '').slice(0, 3000)}`).join('\n');
  return `You are a QA engineer. This test case FAILED. Write a bug report draft from it, based mainly on the actualResult vs expectedResult.
Respond with ONLY a JSON object, no markdown fences, with these keys:
title = short bug title (max 120 chars, Bahasa Indonesia), describing what is wrong;
severity = one of ${BUG_SEVERITIES.join(', ')};
priority = one of ${BUG_PRIORITIES.join(', ')};
analysis = short analysis in Bahasa Indonesia (max 600 chars): impact to the user and possible cause.
Test case:
${lines}`;
}

export async function analyzeBug(body: any, apiKey: string | undefined, ask: Ask): Promise<AiResult> {
  const tc = body?.testcase;
  if (!tc || typeof tc !== 'object' || !String(tc.actualResult || '').trim()) return fail(400, 'Actual Result test case wajib diisi');
  if (!apiKey) return fail(500, 'GEMINI_API_KEY belum diisi. Isi di halaman Settings atau .env server.');
  const raw = await ask(apiKey, [{ text: analyzePrompt(tc) }]);
  if (raw === null) return fail(502, 'AI provider error');
  let parsed: any;
  try { parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? ''); } catch { parsed = null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail(502, 'AI response JSON parse failed');
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  return {
    status: 200,
    body: {
      title: str(parsed.title, 150),
      severity: BUG_SEVERITIES.includes(parsed.severity) ? parsed.severity : '',
      priority: BUG_PRIORITIES.includes(parsed.priority) ? parsed.priority : '',
      analysis: str(parsed.analysis, 2000),
    },
  };
}
