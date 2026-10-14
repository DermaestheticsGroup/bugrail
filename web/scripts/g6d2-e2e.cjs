// Slice 6d-2 browser check: import (real file upload), template, Excel/CSV export (real downloads), JSON backup and restore.
// PLAYWRIGHT_CORE=<path> node scripts/g6d2-e2e.cjs <outdir> <alphaWsId> <vendorWsId>   (server on :3200, seeded by scripts/e2e-seed.ts)
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const fs = require('fs');
const [SC, ALPHA] = process.argv.slice(2);
const B = 'http://localhost:3200';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 240))); };
const open = (name) => chromium.launchPersistentContext(`${SC}/${name}`, { executablePath: CHROME, headless: true, acceptDownloads: true, args: ['--no-first-run'] });
const V = (page, sel) => page.locator(`${sel}:visible`);
const until = async (what, fn, ms = 15000) => { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return Date.now() - t; } catch { /* retry */ } if (Date.now() - t > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 250)); } };
const step = async (name, fn) => { try { const d = await fn(); check(name, true, d); } catch (e) { check(name, false, String(e.message || e).slice(0, 220)); } };
async function login(p, email, password) {
  await p.goto(B + '/login');
  await p.fill('input[name=email]', email);
  await p.fill('input[name=password]', password);
  await Promise.all([p.waitForURL(/\/w\//, { timeout: 30000 }), p.click('button[type=submit]')]);
  await p.waitForSelector('[data-testid=sync-badge]', { timeout: 30000 });
}
const sync = (p) => until('synced', async () => /up to date/.test(await V(p, '[data-testid=pending]').first().textContent()), 20000);
const download = async (p, click) => { const [d] = await Promise.all([p.waitForEvent('download', { timeout: 15000 }), click()]); const path = `${SC}/dl-${Date.now()}-${d.suggestedFilename()}`; await d.saveAs(path); return { name: d.suggestedFilename(), path }; };

(async () => {
  const errors = [];
  const qa = await open('qa'), p = qa.pages()[0] || await qa.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('dialog', (d) => d.accept());
  await login(p, 'qa@x.test', 'qapass1234');
  await p.goto(`${B}/w/${ALPHA}/testcases`);
  await p.waitForSelector('form[aria-label="Add file"]', { timeout: 30000 });
  await p.fill('input[aria-label="File name"]', 'Imports');
  await p.click('button:has-text("Add file")');
  await p.waitForSelector('li[data-file="Imports"]');

  let template = '';
  await step('X1 the template downloads as .xlsx', async () => {
    await p.goto(`${B}/w/${ALPHA}/import-export`);
    await V(p, 'button:has-text("Download template")').waitFor({ timeout: 30000 });
    const d = await download(p, () => V(p, 'button:has-text("Download template")').click());
    if (d.name !== 'Template_Import_TestCase.xlsx' || fs.statSync(d.path).size < 1000) throw new Error(JSON.stringify(d));
    template = d.path;
    return d.name;
  });

  await step('X2 the downloaded template imports as one test case, which appears in the file', async () => {
    await V(p, '[aria-label="Target file"]').selectOption({ label: 'Imports' });
    await V(p, '[aria-label="Import file"]').setInputFiles(template);
    await V(p, '[data-testid=io-ok]').waitFor({ timeout: 15000 });
    await p.goto(`${B}/w/${ALPHA}/testcases`);
    await p.locator('li[data-file="Imports"] a').click();
    await until('row', async () => /Login dengan kredensial valid/.test(await V(p, 'table').first().innerText()), 20000);
    await until('server code', async () => /LOG-\d{4}/.test(await V(p, 'table').first().innerText()), 20000);
  });

  await step('X3 a bad file imports nothing and names the problem', async () => {
    const csv = `${SC}/bad.csv`;
    fs.writeFileSync(csv, 'Module,Scenario,Type Test\nLogin,,Sideways\n');
    await p.goto(`${B}/w/${ALPHA}/import-export`);
    await V(p, '[aria-label="Import file"]').waitFor({ timeout: 30000 });
    await V(p, '[aria-label="Target file"]').selectOption({ label: 'Imports' });
    await V(p, '[aria-label="Import file"]').setInputFiles(csv);
    const m = await V(p, '[data-testid=io-error]').textContent({ timeout: 10000 });
    if (!/baris 2/.test(m)) throw new Error(m);
    return m.slice(0, 80);
  });

  await step('X4 Excel export of test cases has the imported case; CSV has the legacy header', async () => {
    const x = await download(p, () => V(p, 'button:has-text("Test Case Excel")').click());
    if (!/^TestCases_\d{4}-\d{2}-\d{2}\.xlsx$/.test(x.name)) throw new Error(x.name);
    const buf = fs.readFileSync(x.path);
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('not a zip/xlsx');
    const c = await download(p, () => V(p, 'button:has-text("Test Case CSV")').click());
    const text = fs.readFileSync(c.path, 'utf8');
    if (!text.startsWith('No,Test Case ID,Module,Role User,Scenario') || !/Login dengan kredensial valid/.test(text)) throw new Error(text.slice(0, 120));
  });

  await step('X5 bug export downloads (CSV header, Excel zip)', async () => {
    const c = await download(p, () => V(p, 'button:has-text("Bug Report CSV")').click());
    if (!fs.readFileSync(c.path, 'utf8').startsWith('Bug ID,Test Case ID,Module')) throw new Error('bug csv header');
    const x = await download(p, () => V(p, 'button:has-text("Bug Report Excel")').click());
    if (fs.readFileSync(x.path)[0] !== 0x50) throw new Error('bug xlsx not a zip');
  });

  let backupPath = '';
  await step('X6 backup JSON downloads and holds the imported test case and the file', async () => {
    const d = await download(p, () => V(p, 'button:has-text("Backup JSON")').click());
    const b = JSON.parse(fs.readFileSync(d.path, 'utf8'));
    if (b.app !== 'bugrail' || !b.tables.testcases.some((t) => t.scenario === 'Login dengan kredensial valid') || !b.tables.files.some((f) => f.name === 'Imports')) throw new Error('backup content');
    backupPath = d.path;
    return d.name;
  });

  await step('X7 restoring a non-backup file is refused with a message', async () => {
    const junk = `${SC}/junk.json`;
    fs.writeFileSync(junk, '{"hello":1}');
    await V(p, '[aria-label="Restore file"]').setInputFiles(junk);
    const m = await V(p, '[data-testid=io-error]').textContent({ timeout: 10000 });
    if (!/bukan backup/.test(m)) throw new Error(m);
  });

  await step('X8 restore into a second user on another device: rows appear and sync to the server', async () => {
    const q = await open('qa2'), qp = q.pages()[0] || await q.newPage();
    qp.on('dialog', (d) => d.accept());
    await login(qp, 'qa2@x.test', 'qapass1234');
    await sync(qp);
    await qp.goto(`${B}/w/${ALPHA}/import-export`);
    await V(qp, '[aria-label="Restore file"]').waitFor({ timeout: 30000 });
    // qa2 already pulled the same rows (same workspace): restoring merges instead of duplicating them
    await V(qp, '[aria-label="Restore file"]').setInputFiles(backupPath);
    await V(qp, '[data-testid=io-ok]').waitFor({ timeout: 15000 });
    await sync(qp);
    await qp.goto(`${B}/w/${ALPHA}/testcases`);
    await qp.locator('li[data-file="Imports"] a').click();
    await until('one row only', async () => (await V(qp, 'tbody tr').count()) === 1, 20000);
    await q.close();
  });

  check('no uncaught page errors', errors.length === 0, errors.slice(0, 2));
  await qa.close();
  const failed = results.filter((x) => !x).length;
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('crash', e); process.exit(2); });
