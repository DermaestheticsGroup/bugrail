// Slice 6a browser check: files, sharing, test cases, rejected-writes panel. Server: next start on :3200 (see g5.sh pattern).
// PLAYWRIGHT_CORE=<path> node scripts/g6a-e2e.cjs <outdir> <alphaWsId> <vendorWsId>
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const [SC, ALPHA, VENDOR] = process.argv.slice(2);
const B = 'http://localhost:3200';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 220))); };
const open = (name) => chromium.launchPersistentContext(`${SC}/${name}`, { executablePath: CHROME, headless: true, args: ['--no-first-run'] });

async function login(p, email, password) {
  await p.goto(B + '/login');
  await p.fill('input[name=email]', email);
  await p.fill('input[name=password]', password);
  await Promise.all([p.waitForURL(/\/w\//, { timeout: 30000 }), p.click('button[type=submit]')]);
  await p.waitForSelector('[data-testid=sync-badge]', { timeout: 30000 });
}
// Next keeps visited screens mounted but hidden: every locator must mean the visible one.
const V = (page, sel) => page.locator(`${sel}:visible`);
const rowsText = (p) => V(p, '[data-testid=tc-table] tbody tr').allTextContents();
const until = async (what, fn, ms = 15000) => { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return Date.now() - t; } catch { /* retry */ } if (Date.now() - t > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 250)); } };
const step = async (name, fn) => { try { const d = await fn(); check(name, true, d); } catch (e) { check(name, false, String(e.message || e).slice(0, 160)); } };

(async () => {
  const a = await open('a');
  const p = a.pages()[0] || await a.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));
  await login(p, 'qa@x.test', 'qapass1234');

  await step('F2 create a file', async () => {
    await p.goto(`${B}/w/${ALPHA}/testcases`);
    await p.waitForSelector('form[aria-label="Add file"]', { timeout: 30000 });
    await p.fill('input[aria-label="File name"]', 'Core');
    await p.click('button:has-text("Add file")');
    await p.waitForSelector('[data-testid=file-list] li[data-file="Core"]');
  });
  await step('F3 rename a file', async () => {
    await p.locator('li[data-file="Core"] button:has-text("Edit")').click();
    await p.fill('form[aria-label="Edit file"] input[aria-label=Name]', 'Core flows');
    await p.click('form[aria-label="Edit file"] button:has-text("Save")');
    await p.waitForSelector('li[data-file="Core flows"]');
  });
  await step('T2 create test cases; T7 codes arrive within 15 s', async () => {
    await p.locator('li[data-file="Core flows"] a').click();
    await p.waitForSelector('button:has-text("New test case")');
    for (const [mod, sc] of [['Login', 'Happy path'], ['Login', 'Wrong password'], ['Payments', 'Refund']]) {
      await p.click('button:has-text("New test case")');
      await p.fill('form[aria-label="Test case form"] input[list=tc-modules]', mod);
      await p.fill('form[aria-label="Test case form"] label:has-text("Scenario") input', sc);
      await p.click('form[aria-label="Test case form"] button:has-text("Save")');
      await p.waitForSelector(`tr:has-text("${sc}")`);
    }
    return until('codes', async () => (await rowsText(p)).every((t) => /LOG-\d{4}|PAY|PAYM|PAM/.test(t) || /[A-Z]{2,3}-\d{4}/.test(t)));
  });
  await step('T1 search narrows the list; reset restores it', async () => {
    await p.fill('input[aria-label=Search]', 'wrong password');
    await until('search', async () => (await rowsText(p)).length === 1);
    await p.click('button:has-text("Reset filters")');
    await until('reset', async () => (await rowsText(p)).length === 3);
  });
  await step('T4 execute a test case and filter by its status', async () => {
    await p.locator('tr:has-text("Wrong password") button:has-text("Run")').click();
    await p.fill('form[aria-label=Execute] textarea', 'got 500');
    await p.selectOption('form[aria-label=Execute] select', 'Failed');
    await p.click('button:has-text("Save result")');
    await p.selectOption('select[aria-label="Status filter"]', 'Failed');
    await until('filter', async () => { const r = await rowsText(p); return r.length === 1 && /Wrong password/.test(r[0]); });
    await p.click('button:has-text("Reset filters")');
  });
  await step('T5 duplicate gets its own code from the server', async () => {
    await p.locator('tr:has-text("Happy path") button:has-text("Duplicate")').click();
    await until('dup', async () => (await rowsText(p)).length === 4);
    return until('dup code', async () => (await rowsText(p)).every((t) => !/pending/.test(t)));
  });
  await step('T6 bulk status update (qa_internal has no delete permission, so no delete button)', async () => {
    await V(p, 'input[aria-label="Select page"]').check();
    await p.selectOption('select[aria-label="Bulk status"]', 'Passed');
    await until('bulk', async () => (await rowsText(p)).every((t) => /Passed/.test(t)));
  });

  // sharing into the vendor workspace
  const v = await open('v');
  const vp = v.pages()[0] || await v.newPage();
  vp.on('pageerror', (e) => errors.push(String(e)));
  await login(vp, 'vendor@x.test', 'vendorpass1');
  await vp.goto(`${B}/w/${VENDOR}/testcases`);
  await vp.waitForSelector('[data-testid=sync-badge]');
  await step('F6 vendor sees none of Alpha before sharing', async () => {
    await vp.waitForTimeout(3000);
    return (await vp.locator('[data-testid=file-list] li').count()) === 0 || (() => { throw new Error('vendor sees a file'); })();
  });
  await step('F5 share the file into Vendor; the vendor sees it within 15 s as shared', async () => {
    await p.goto(`${B}/w/${ALPHA}/testcases`);
    await p.locator('li[data-file="Core flows"] button:has-text("Edit")').click();
    await p.locator('fieldset label:has-text("Vendor") input').check();
    await p.click('form[aria-label="Edit file"] button:has-text("Save")');
    return until('vendor sees file', async () => /shared with you/.test(await vp.locator('[data-testid=file-list]').innerText()));
  });
  await step('F5/F6 unshare: the file disappears from the vendor within 15 s', async () => {
    await p.locator('li[data-file="Core flows"] button:has-text("Edit")').click();
    await p.locator('fieldset label:has-text("Vendor") input').uncheck();
    await p.click('form[aria-label="Edit file"] button:has-text("Save")');
    return until('vendor loses file', async () => (await vp.locator('[data-testid=file-list] li').count()) === 0);
  });

  // O2: a write the UI allows but the server refuses is shown, then discarded
  await step('O2 a refused write is shown to the user and can be discarded', async () => {
    await p.locator('li[data-file="Core flows"] button:has-text("Edit")').click();
    await p.locator('fieldset label:has-text("Vendor") input').check();
    await p.click('form[aria-label="Edit file"] button:has-text("Save")');
    await until('vendor sees file again', async () => /shared with you/.test(await vp.locator('[data-testid=file-list]').innerText()));
    await vp.locator('[data-testid=file-list] a').click();
    await vp.waitForSelector('[data-testid=tc-table] tbody tr', { timeout: 20000 });
    // an admin takes testcase_update away from vendors; the vendor's open page still offers Edit
    const adm = await open('adm');
    const ap = adm.pages()[0] || await adm.newPage();
    await login(ap, 'root@x.test', 'rootpass123');
    const st = await ap.evaluate(async () => (await fetch('/api/admin/roles', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ qa_vendor: { testcase_read: true, testcase_update: false } }) })).status);
    if (st !== 200) throw new Error('role change ' + st);
    await adm.close();
    await V(vp, 'tr:has-text("Happy path") button:has-text("Edit")').first().click();
    await vp.fill('form[aria-label="Test case form"] label:has-text("Scenario") input', 'Vendor edit');
    await vp.click('form[aria-label="Test case form"] button:has-text("Save")');
    await vp.waitForSelector('[data-testid=rejected-panel]', { timeout: 20000 });
    const text = await vp.locator('[data-testid=rejected-panel]').innerText();
    if (!/not allowed: testcase_update/.test(text)) throw new Error('reason missing: ' + text);
    await V(vp, '[data-testid=rejected-panel] button:has-text("Discard")').first().click();
    await until('panel gone', async () => (await V(vp, '[data-testid=rejected-panel]').count()) === 0, 20000).catch(async (e) => { throw new Error(e.message + ' | ' + JSON.stringify(await vp.locator('[data-testid=rejected-panel]').allInnerTexts())); });
    await until('row reverted', async () => !/Vendor edit/.test((await rowsText(vp)).join()) && /Happy path/.test((await rowsText(vp)).join()));
    return text.slice(0, 80);
  });

  await step('F4 admin deletes a file: its test cases go too, on every device', async () => {
    const adm = await open('adm2');
    const ap = adm.pages()[0] || await adm.newPage();
    await login(ap, 'root@x.test', 'rootpass123');
    await ap.goto(`${B}/w/all/testcases`);
    await ap.waitForSelector('li[data-file="Core flows"]', { timeout: 30000 });
    ap.once('dialog', (d) => d.accept());
    await ap.locator('li[data-file="Core flows"] button:has-text("Delete")').click();
    await ap.waitForSelector('li[data-file="Core flows"]', { state: 'detached' });
    // The push goes out a second after the last write: closing the browser sooner would lose the delete.
    await until('admin pushed', async () => /up to date/.test(await V(ap, '[data-testid=pending]').first().textContent()), 15000);
    await adm.close();
    await until('vendor loses it', async () => (await V(vp, '[data-testid=file-gone]').count()) > 0, 25000).catch(async (e) => { throw new Error(e.message + ' | ' + (await V(vp, 'main').first().innerText()).replace(/\s+/g, ' ').slice(0, 200)); });
    await p.goto(`${B}/w/${ALPHA}/testcases`);
    await until('qa loses it', async () => (await p.locator('li[data-file="Core flows"]').count()) === 0, 20000);
  });

  check('no uncaught page errors', errors.length === 0, errors.slice(0, 2));
  await a.close(); await v.close();
  const failed = results.filter((x) => !x).length;
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('crash', e); process.exit(2); });
