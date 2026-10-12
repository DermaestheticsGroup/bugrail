const express = require('express');
const cors = require('cors');
const db = require('./db');

const ALLOWED_KEYS = new Set(['qa_testcases', 'qa_bugs', 'qa_files', 'qa_settings', 'qa_counters', 'qa_activity_log']);

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));
// Serve the frontend too, so local dev is just `npm start` + http://localhost:3001
app.use(express.static(require('path').join(__dirname, '..', 'qa-app')));

// All KV pairs at once — used for the one-time hydrate on app boot.
app.get('/api/kv', async (req, res) => {
  try {
    const conn = await db.getDb();
    const rows = await conn.collection('kv_store').find().toArray();
    // _revs: each key's version, sent back on PUT so a stale write is refused (see PUT below).
    const out = { _revs: {} };
    rows.forEach(r => { out[r._id] = r.value; out._revs[r._id] = r.rev || 0; });
    res.json(out);
  } catch (err) {
    console.error('GET /api/kv failed', err);
    res.status(500).json({ error: 'Database unreachable' });
  }
});

app.get('/api/kv/:key', async (req, res) => {
  try {
    const conn = await db.getDb();
    const row = await conn.collection('kv_store').findOne({ _id: req.params.key });
    res.json({ value: row ? row.value : null, rev: (row && row.rev) || 0 });
  } catch (err) {
    console.error('GET /api/kv/:key failed', err);
    res.status(500).json({ error: 'Database unreachable' });
  }
});

// Client identifies itself via these headers (see Storage.set in qa-app/js/utils.js).
// Not real authentication (no signature/session check) — but stops a non-admin
// client from writing files it doesn't own into another workspace, or granting
// cross-workspace sharing without the share permission, even if the frontend
// UI gating is bypassed.
function readClientAuth(req){
  return {
    role: req.get('x-role') || '',
    workspace: req.get('x-workspace') || '',
    canShare: req.get('x-can-share') === '1'
  };
}

// The client always PUTs the WHOLE qa_files array (every workspace's files,
// since Auth.visibleFiles() lets a non-admin see files shared into their
// workspace too) — so validation must diff against what's already stored
// and only police what THIS write actually changed, not every row in the
// array, or a non-admin would get 403'd just for having someone else's
// file present-but-untouched in their payload.
function sameSharedWith(a, b){
  const x = (a || []).slice().sort();
  const y = (b || []).slice().sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

async function validateFilesWrite(req, res, next){
  const { role, workspace, canShare } = readClientAuth(req);
  if (role === 'admin') return next();
  const files = Array.isArray(req.body.value) ? req.body.value : [];
  try {
    const conn = await db.getDb();
    const row = await conn.collection('kv_store').findOne({ _id: 'qa_files' });
    const oldFiles = (row && Array.isArray(row.value)) ? row.value : [];
    const oldById = new Map(oldFiles.map(f => [f.id, f]));
    const newById = new Map(files.map(f => [f.id, f]));

    for (const f of files){
      const old = oldById.get(f.id);
      if (!old){
        // New file: must be created in own workspace (or shared/legacy).
        if (f.workspaceId && f.workspaceId !== workspace){
          return res.status(403).json({ error: `Tidak berhak membuat file di workspace lain: ${f.id}` });
        }
        continue;
      }
      const changed = old.name !== f.name || old.workspaceId !== f.workspaceId || !sameSharedWith(old.sharedWith, f.sharedWith);
      if (!changed) continue;
      // Editing an existing file: only its owning workspace (or legacy/shared) may touch it.
      if (old.workspaceId && old.workspaceId !== workspace){
        return res.status(403).json({ error: `Tidak berhak mengubah file milik workspace lain: ${f.id}` });
      }
      if (!sameSharedWith(old.sharedWith, f.sharedWith) && !canShare){
        return res.status(403).json({ error: `Tidak punya izin share file: ${f.id}` });
      }
    }
    for (const old of oldFiles){
      if (newById.has(old.id)) continue;
      // Deleting a file: only its owning workspace (or legacy/shared) may delete it.
      if (old.workspaceId && old.workspaceId !== workspace){
        return res.status(403).json({ error: `Tidak berhak menghapus file milik workspace lain: ${old.id}` });
      }
    }
    next();
  } catch (err) {
    console.error('validateFilesWrite failed', err);
    res.status(500).json({ error: 'Database unreachable' });
  }
}

// A qa_settings write must keep every top-level key already stored (users,
// workspaces, roles, rolePermissions, bugStatusMaster...). A client that booted
// without the real settings (offline fallback, empty browser storage) would
// otherwise replace them with its seed defaults — this once wiped every account
// and workspace. Clearing a list is still fine: send it as [] / {}.
async function validateSettingsWrite(req, res, next){
  const value = req.body.value;
  if (!value || typeof value !== 'object' || Array.isArray(value)){
    return res.status(400).json({ error: 'qa_settings harus berupa object' });
  }
  try {
    const conn = await db.getDb();
    const row = await conn.collection('kv_store').findOne({ _id: 'qa_settings' });
    const stored = (row && row.value && typeof row.value === 'object') ? row.value : {};
    const missing = Object.keys(stored).filter(k => !(k in value));
    if (missing.length){
      return res.status(409).json({ error: `Settings ditolak: akan menghapus ${missing.join(', ')} di server. Muat ulang halaman.` });
    }
    next();
  } catch (err) {
    console.error('validateSettingsWrite failed', err);
    res.status(500).json({ error: 'Database unreachable' });
  }
}

// qa_bugs is PUT whole too — only police bugs this write ADDS (ids not stored yet):
// title + actual result present, and (non-admin) the bug's file belongs to the
// writer's workspace, is shared into it, or is legacy (no workspace).
// The full form rules (qa-app/js/utils.js BUG_FORM) stay client-side: Excel
// import and bugs saved before those fields existed don't carry them.
async function validateBugsWrite(req, res, next){
  const { role, workspace } = readClientAuth(req);
  const bugs = Array.isArray(req.body.value) ? req.body.value : null;
  if (!bugs) return res.status(400).json({ error: 'qa_bugs harus berupa array' });
  try {
    const conn = await db.getDb();
    const row = await conn.collection('kv_store').findOne({ _id: 'qa_bugs' });
    const known = new Set(((row && Array.isArray(row.value)) ? row.value : []).map(b => b.id));
    const added = bugs.filter(b => b && !known.has(b.id));
    if (!added.length) return next();
    const text = v => String(v == null ? '' : v).trim();
    for (const b of added){
      const title = text(b.title).length;
      if (!title || title > 150) return res.status(400).json({ error: `Bug Title wajib diisi (maks. 150 karakter): ${b.code || b.id}` });
      if (!text(b.actualResult)) return res.status(400).json({ error: `Actual Result wajib diisi: ${b.code || b.id}` });
    }
    if (role === 'admin') return next();
    const filesRow = await conn.collection('kv_store').findOne({ _id: 'qa_files' });
    const files = new Map(((filesRow && Array.isArray(filesRow.value)) ? filesRow.value : []).map(f => [f.id, f]));
    for (const b of added){
      const f = files.get(b.fileId);
      const member = !f || !f.workspaceId || f.workspaceId === workspace || (f.sharedWith || []).includes(workspace);
      if (!member) return res.status(403).json({ error: `Tidak berhak membuat bug di workspace lain: ${b.code || b.id}` });
    }
    next();
  } catch (err) {
    console.error('validateBugsWrite failed', err);
    res.status(500).json({ error: 'Database unreachable' });
  }
}

// Live push (Server-Sent Events): every open browser keeps GET /api/events open and is told
// which key changed after each saved PUT, then re-reads just that key. Only key + rev go out.
// ponytail: in-memory listener set — fine for one Node process; needs Redis pub/sub if scaled out.
const listeners = new Set();
function broadcast(msg){
  const line = `data: ${JSON.stringify(msg)}\n\n`;
  listeners.forEach(res => res.write(line));
}
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' }); // no-buffer: nginx
  res.flushHeaders();
  res.write(': connected\n\n');
  listeners.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000); // keeps proxies from closing an idle stream
  req.on('close', () => { clearInterval(ping); listeners.delete(res); });
});

app.put('/api/kv/:key', async (req, res, next) => {
  if (req.params.key === 'qa_files') return validateFilesWrite(req, res, next);
  if (req.params.key === 'qa_bugs') return validateBugsWrite(req, res, next);
  if (req.params.key === 'qa_settings') return validateSettingsWrite(req, res, next);
  next();
}, async (req, res) => {
  const { key } = req.params;
  if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: `Unknown key: ${key}` });
  // Optimistic lock: every value is PUT whole, so a write based on an old copy
  // would silently wipe what other users/tabs saved since. The client sends the
  // rev it last read; only that exact rev may be replaced (atomically, rev + 1).
  const rev = req.body.rev;
  if (!Number.isInteger(rev) || rev < 0){
    return res.status(409).json({ error: 'Aplikasi versi lama — muat ulang halaman (Ctrl+F5).', stale: true });
  }
  try {
    const conn = await db.getDb();
    const doc = await conn.collection('kv_store').findOneAndUpdate(
      { _id: key, rev: rev === 0 ? { $in: [0, null] } : rev }, // null matches docs saved before revs existed
      { $set: { value: req.body.value }, $inc: { rev: 1 } },
      { upsert: true, returnDocument: 'after' }
    );
    res.json({ ok: true, rev: doc.rev });
    broadcast({ key, rev: doc.rev });
  } catch (err) {
    // Upsert collided with the existing doc => its rev moved on: someone saved first.
    if (err && err.code === 11000) return res.status(409).json({ error: 'Data sudah diubah di tab/user lain.', stale: true });
    console.error('PUT /api/kv/:key failed', err);
    res.status(500).json({ error: 'Database unreachable' });
  }
});

const VALID_FIELDS = ['module', 'roleUser', 'scenario', 'testCase', 'preconditions', 'steps', 'testData', 'expectedResult', 'typeTest'];

// ponytail: fixed-window per-IP limiter, in-memory only (resets on restart,
// not shared across instances) — fine for a single-process internal tool.
const TESTFORGE_RATE_LIMIT = 10;
const TESTFORGE_RATE_WINDOW_MS = 5 * 60 * 1000;
const testForgeHits = new Map(); // ip -> [timestamps]
function isTestForgeRateLimited(ip){
  const now = Date.now();
  const hits = (testForgeHits.get(ip) || []).filter(t => now - t < TESTFORGE_RATE_WINDOW_MS);
  hits.push(now);
  testForgeHits.set(ip, hits);
  return hits.length > TESTFORGE_RATE_LIMIT;
}

// Returns the model's text, or null when the provider call fails (logged).
async function askGemini(apiKey, parts){
  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ parts }] })
    }
  );
  if (!geminiRes.ok) {
    console.error('Gemini API error', geminiRes.status, await geminiRes.text());
    return null;
  }
  const geminiJson = await geminiRes.json();
  return geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function buildTestForgePrompt(mode, content, fields, module){
  const fieldList = fields.join(', ');
  const moduleHint = module ? `The module/feature under test is "${module}".` : '';
  const sourceLabel = mode === 'brs' ? 'the following BRS (Business Requirement Specification) text'
    : mode === 'screenshot' ? 'the attached application screenshot(s)'
    : 'the following description';
  return `You are a QA test case generator. Based on ${sourceLabel}, generate a JSON array of test cases.
${moduleHint}
Each object in the array must contain ONLY these fields: ${fieldList}.
Field meanings: module=feature area name, roleUser=user role performing the action, scenario=short scenario title, testCase=detailed test case description, preconditions=state required before testing, steps=numbered test steps as plain text (one step per line), testData=input data to use, expectedResult=expected outcome, typeTest=either "Positive" or "Negative".
Respond with ONLY the JSON array, no markdown fences, no explanation.
${mode !== 'screenshot' ? `Content:\n${content}` : (content ? `Additional instructions: ${content}` : '')}`;
}

app.post('/api/testforge/generate', async (req, res) => {
  // Paused (server load) — the UI button is hidden too. Set TESTFORGE_ENABLED=1 in .env to turn it back on.
  if (process.env.TESTFORGE_ENABLED !== '1') {
    return res.status(503).json({ error: 'Fitur Generate AI sedang dinonaktifkan.' });
  }
  try {
    if (isTestForgeRateLimited(req.ip)) {
      return res.status(429).json({ error: 'Too many requests, coba lagi nanti.' });
    }
    const { mode, content, images, fields, module, apiKey: bodyApiKey } = req.body || {};
    if (!['brs', 'screenshot', 'text'].includes(mode)) {
      return res.status(400).json({ error: 'Invalid mode' });
    }
    const cleanFields = Array.isArray(fields) ? fields.filter(f => VALID_FIELDS.includes(f)) : [];
    if (!cleanFields.length) {
      return res.status(400).json({ error: 'No valid fields selected' });
    }
    if (mode !== 'screenshot' && !String(content || '').trim()) {
      return res.status(400).json({ error: 'Content is required for this mode' });
    }
    if (mode === 'screenshot' && (!Array.isArray(images) || !images.length)) {
      return res.status(400).json({ error: 'At least one image is required for screenshot mode' });
    }
    if (mode === 'screenshot' && images.length > 5) {
      return res.status(400).json({ error: 'Maksimal 5 screenshot per generate.' });
    }

    const apiKey = (typeof bodyApiKey === 'string' && bodyApiKey.trim()) || process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY belum diisi. Isi di halaman Settings atau .env server.' });

    const promptText = buildTestForgePrompt(mode, content, cleanFields, module);
    const parts = [{ text: promptText }];
    if (mode === 'screenshot') {
      images.forEach(dataUrl => {
        const m = String(dataUrl).match(/^data:(image\/[a-zA-Z+]+);base64,(.+)$/);
        if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
      });
    }

    const rawText = await askGemini(apiKey, parts);
    if (rawText === null) return res.status(502).json({ error: 'AI provider error' });
    const jsonMatch = rawText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return res.status(502).json({ error: 'AI response had no JSON array', raw: rawText });
    }
    let parsed;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      return res.status(502).json({ error: 'AI response JSON parse failed', raw: rawText });
    }
    if (!Array.isArray(parsed)) {
      return res.status(502).json({ error: 'AI response was not an array', raw: rawText });
    }
    const testcases = parsed.map(tc => {
      const out = {};
      cleanFields.forEach(f => { out[f] = typeof tc[f] === 'string' ? tc[f] : ''; });
      return out;
    });
    res.json({ testcases });
  } catch (err) {
    console.error('POST /api/testforge/generate failed', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Failed test case -> draft bug (title, severity, priority, analysis). The tester
// reviews it in the bug form before saving; nothing is stored here.
const BUG_SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
const BUG_PRIORITIES = ['Urgent', 'High', 'Medium', 'Low'];
const BUG_TC_FIELDS = ['module', 'scenario', 'testCase', 'preconditions', 'steps', 'testData', 'expectedResult', 'actualResult'];

function buildBugAnalyzePrompt(tc){
  const lines = BUG_TC_FIELDS.map(f => `${f}: ${String(tc[f] || '').slice(0, 3000)}`).join('\n');
  return `You are a QA engineer. This test case FAILED. Write a bug report draft from it, based mainly on the actualResult vs expectedResult.
Respond with ONLY a JSON object, no markdown fences, with these keys:
title = short bug title (max 120 chars, Bahasa Indonesia), describing what is wrong;
severity = one of ${BUG_SEVERITIES.join(', ')};
priority = one of ${BUG_PRIORITIES.join(', ')};
analysis = short analysis in Bahasa Indonesia (max 600 chars): impact to the user and possible cause.
Test case:
${lines}`;
}

app.post('/api/bug/analyze', async (req, res) => {
  try {
    if (isTestForgeRateLimited(req.ip)) {
      return res.status(429).json({ error: 'Too many requests, coba lagi nanti.' });
    }
    const { testcase, apiKey: bodyApiKey } = req.body || {};
    if (!testcase || typeof testcase !== 'object' || !String(testcase.actualResult || '').trim()) {
      return res.status(400).json({ error: 'Actual Result test case wajib diisi' });
    }
    const apiKey = (typeof bodyApiKey === 'string' && bodyApiKey.trim()) || process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'GEMINI_API_KEY belum diisi. Isi di halaman Settings atau .env server.' });

    const rawText = await askGemini(apiKey, [{ text: buildBugAnalyzePrompt(testcase) }]);
    if (rawText === null) return res.status(502).json({ error: 'AI provider error' });
    let parsed;
    try { parsed = JSON.parse((rawText.match(/\{[\s\S]*\}/) || [])[0]); } catch (e) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') return res.status(502).json({ error: 'AI response JSON parse failed' });
    const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    res.json({
      title: str(parsed.title, 150),
      severity: BUG_SEVERITIES.includes(parsed.severity) ? parsed.severity : '',
      priority: BUG_PRIORITIES.includes(parsed.priority) ? parsed.priority : '',
      analysis: str(parsed.analysis, 2000)
    });
  } catch (err) {
    console.error('POST /api/bug/analyze failed', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = { app, sameSharedWith, isTestForgeRateLimited, buildTestForgePrompt, buildBugAnalyzePrompt, testForgeHits };
