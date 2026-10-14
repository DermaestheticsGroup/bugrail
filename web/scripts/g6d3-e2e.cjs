// Slice 6d-3 browser check: TestForge and Translate. The Gemini and MyMemory calls are NOT real: the real server route is hit once
// (to prove the disabled message), then Playwright answers /api/testforge/generate and the MyMemory URL, so this checks our UI and writes only.
// PLAYWRIGHT_CORE=<path> node scripts/g6d3-e2e.cjs <outdir> <alphaWsId> <vendorWsId>   (server on :3200, seeded by scripts/e2e-seed.ts)
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const [SC, ALPHA] = process.argv.slice(2);
const B = 'http://localhost:3200';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 240))); };
const open = (name) => chromium.launchPersistentContext(`${SC}/${name}`, { executablePath: CHROME, headless: true, args: ['--no-first-run'] });
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

(async () => {
  const errors = [];
  const qa = await open('qa'), p = qa.pages()[0] || await qa.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('dialog', (d) => d.accept());
  await login(p, 'qa@x.test', 'qapass1234');
  await p.goto(`${B}/w/${ALPHA}/testcases`);
  await p.waitForSelector('form[aria-label="Add file"]', { timeout: 30000 });
  await p.fill('input[aria-label="File name"]', 'Forge');
  await p.click('button:has-text("Add file")');
  await p.locator('li[data-file="Forge"] a').click();
  await p.waitForSelector('button:has-text("Generate AI")', { timeout: 20000 });

  const openForge = async () => {
    await V(p, 'button:has-text("Generate AI")').click();
    await V(p, 'dialog[aria-label=TestForge] button:has-text("Lanjut")').click();
    await V(p, 'dialog[aria-label=TestForge] [aria-label=Content]').fill('Fitur login dengan email dan password');
  };

  await step('G1 the real route answers the disabled message in the panel (feature flag off by default)', async () => {
    await openForge();
    await V(p, 'dialog[aria-label=TestForge] button:has-text("Generate")').click();
    const m = await V(p, '[data-testid=tf-error]').textContent({ timeout: 15000 });
    if (!/nonaktifkan|belum diisi/.test(m)) throw new Error(m);
    await V(p, 'dialog[aria-label=TestForge] button:has-text("Kembali")').click();
    return m;
  });

  await step('G2 a generated draft is reviewable and editable; deleting one row and saving stores the rest as Open cases', async () => {
    await p.route('**/api/testforge/generate', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ testcases: [
      { module: 'Login', scenario: 'Login ok', testCase: 'valid', steps: '1. open <b>x</b>\n2. press', typeTest: 'Positive' },
      { module: 'Login', scenario: 'Login wrong password', steps: '1. open', typeTest: 'Negative' },
      { module: 'Login', scenario: 'to be deleted', steps: '' },
    ] }) }));
    await V(p, 'dialog[aria-label=TestForge] button:has-text("Lanjut")').click(); // G1 left us on the field step
    await V(p, 'dialog[aria-label=TestForge] button:has-text("Generate")').click();
    await until('three staged', async () => (await V(p, '[data-testid=tf-staged]').count()) === 3);
    await V(p, '[aria-label="1 scenario"]').fill('Login ok (edited)');
    await V(p, '[data-testid=tf-staged]').nth(2).locator('button:has-text("Hapus")').click();
    await V(p, 'dialog[aria-label=TestForge] button:has-text("Simpan Semua")').click();
    await until('saved', async () => (await V(p, 'dialog[aria-label=TestForge]').count()) === 0, 15000);
    await until('rows', async () => { const t = await V(p, '[data-testid=tc-table]').innerText(); return /Login ok \(edited\)/.test(t) && /Login wrong password/.test(t) && !/to be deleted/.test(t); });
    await until('server codes', async () => (await V(p, '[data-testid=tc-table] tbody tr').allTextContents()).every((t) => /LOG-\d{4}/.test(t)), 20000);
    await sync(p);
  });

  await step('G3 markup in AI text is stored escaped, never as live tags', async () => {
    await V(p, 'tr:has-text("Login ok (edited)") button:has-text("Edit")').click();
    const steps = await V(p, 'form[aria-label="Test case form"] label:has-text("Steps") textarea').inputValue({ timeout: 15000 });
    if (/<b>|<\/b>/.test(steps)) throw new Error('live tag stored: ' + steps);
    await V(p, 'form[aria-label="Test case form"] button:has-text("Cancel"), form[aria-label="Test case form"] button:has-text("Batal")').first().click();
    return steps.slice(0, 60);
  });

  await step('G4 Translate: confirm names the service; each case is translated in its own direction and saved', async () => {
    let dialogText = '';
    p.removeAllListeners('dialog');
    p.on('dialog', (d) => { dialogText = d.message(); void d.accept(); });
    await p.route('https://api.mymemory.translated.net/**', (r) => {
      const url = new URL(r.request().url());
      r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ responseData: { translatedText: `[${url.searchParams.get('langpair')}] ${url.searchParams.get('q')}` } }) });
    });
    await p.goto(p.url());
    await V(p, 'button:has-text("Translate file")').waitFor({ timeout: 30000 });
    await V(p, 'button:has-text("Translate file")').click();
    await until('translated', async () => /\[(en\|id|id\|en)\] Login ok/.test(await V(p, '[data-testid=tc-table]').innerText()), 20000);
    if (!/MyMemory/.test(dialogText)) throw new Error(dialogText);
    return dialogText.slice(0, 70);
  });

  await step('G5 a translation API failure changes nothing and shows the error', async () => {
    await p.unroute('https://api.mymemory.translated.net/**');
    await p.route('https://api.mymemory.translated.net/**', (r) => r.fulfill({ status: 500, headers: { 'access-control-allow-origin': '*' }, body: 'x' }));
    const before = await V(p, '[data-testid=tc-table]').innerText();
    await V(p, 'button:has-text("Translate file")').click();
    await V(p, '[role=alert]:has-text("Translate API error")').waitFor({ timeout: 15000 });
    if ((await V(p, '[data-testid=tc-table]').innerText()) !== before) throw new Error('table changed');
  });

  await step('G6 offline: Generate AI and Translate are disabled', async () => {
    await qa.setOffline(true);
    await p.evaluate(() => window.dispatchEvent(new Event('offline')));
    await until('disabled', async () => (await V(p, 'button:has-text("Generate AI")').isDisabled()) && (await V(p, 'button:has-text("Translate file")').isDisabled()), 8000);
    await qa.setOffline(false);
    await p.evaluate(() => window.dispatchEvent(new Event('online')));
  });

  await step('P1 print media hides the header, nav and buttons but keeps the table', async () => {
    await p.emulateMedia({ media: 'print' });
    const vis = await p.evaluate(() => ({
      header: getComputedStyle(document.querySelector('header')).display, nav: getComputedStyle(document.querySelector('nav[aria-label=Main]')).display,
      table: getComputedStyle(document.querySelector('[data-testid=tc-table]')).display,
    }));
    await p.emulateMedia({ media: 'screen' });
    if (vis.header !== 'none' || vis.nav !== 'none' || vis.table === 'none') throw new Error(JSON.stringify(vis));
    return vis;
  });

  check('no uncaught page errors', errors.length === 0, errors.slice(0, 2));
  await qa.close();
  const failed = results.filter((x) => !x).length;
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('crash', e); process.exit(2); });
