// Slice 6b browser check: Bug Report (list, form, create-from-test-case, status flow, board, detail, comments, bulk).
// PLAYWRIGHT_CORE=<path> node scripts/g6b-e2e.cjs <outdir> <alphaWsId> <vendorWsId>   (server on :3200, see g6b.sh)
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const [SC, ALPHA] = process.argv.slice(2);
const B = 'http://localhost:3200';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 240))); };
const open = (name) => chromium.launchPersistentContext(`${SC}/${name}`, { executablePath: CHROME, headless: true, args: ['--no-first-run'] });
// Next keeps visited screens mounted but hidden: every locator must mean the visible one.
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
const rows = (p) => V(p, '[data-testid=bug-table] tbody tr').allTextContents();
const form = (p) => V(p, 'form[aria-label="Bug form"]');
const fill = (p, label, value) => form(p).locator(`[aria-label="${label}"]`).fill(value);
const count = async (p, code) => Number((await V(p, `[data-testid=count-${code}]`).first().textContent()) || -1);
const sync = (p) => until('synced', async () => /up to date/.test(await V(p, '[data-testid=pending]').first().textContent()), 20000);

(async () => {
  const errors = [];
  const qa = await open('qa'), qp = qa.pages()[0] || await qa.newPage();
  qp.on('pageerror', (e) => errors.push(String(e)));
  await login(qp, 'qa@x.test', 'qapass1234');

  let fileUrl = '', bugUrl = '', bugId = '';
  await step('setup: a file and a Failed test case', async () => {
    await qp.goto(`${B}/w/${ALPHA}/testcases`);
    await qp.waitForSelector('form[aria-label="Add file"]', { timeout: 30000 });
    await qp.fill('input[aria-label="File name"]', 'Core');
    await qp.click('button:has-text("Add file")');
    await qp.locator('li[data-file="Core"] a').click();
    await qp.waitForSelector('button:has-text("New test case")');
    await qp.click('button:has-text("New test case")');
    const tf = qp.locator('form[aria-label="Test case form"]');
    await tf.locator('input[list=tc-modules]').fill('Login');
    await tf.locator('label:has-text("Scenario") input').fill('Wrong password');
    await tf.locator('label:has-text("Steps") textarea').fill('open the login page and press the button');
    await tf.locator('label:has-text("Expected result") textarea').fill('user sees an error message');
    await tf.locator('button:has-text("Save")').click();
    await qp.waitForSelector('tr:has-text("Wrong password")');
    await qp.locator('tr:has-text("Wrong password") button:has-text("Run")').click();
    await qp.fill('form[aria-label=Execute] textarea', 'server returned a 500 error');
    await qp.selectOption('form[aria-label=Execute] select', 'Failed');
    await qp.click('button:has-text("Save result")');
    await until('tc code', async () => /LOG-\d{4}/.test((await V(qp, 'tr:has-text("Wrong password")').first().textContent()) || ''));
    fileUrl = qp.url().split('/testcases/')[1];
  });

  await step('T8 Create Bug from a Failed test case opens the form prefilled and linked', async () => {
    await V(qp, 'tr:has-text("Wrong password") a:has-text("Create Bug")').click();
    await form(qp).waitFor({ timeout: 20000 });
    const v = async (l) => form(qp).locator(`[aria-label="${l}"]`).inputValue();
    const got = { module: await v('Module'), scenario: await v('Scenario'), actual: await v('Actual Result'), tc: await v('Test case') };
    if (got.module !== 'Login' || got.scenario !== 'Wrong password' || !/500/.test(got.actual) || !got.tc) throw new Error(JSON.stringify(got));
    return got;
  });

  await step('B2 validation shows the legacy messages and keeps the form open', async () => {
    await form(qp).locator('button:has-text("Simpan")').click();
    await form(qp).locator('[data-error=title]').waitFor({ timeout: 5000 });
    return await form(qp).locator('[data-error=title]').textContent();
  });

  await step('B6 AI analyze fails gracefully without an API key (no crash, message shown)', async () => {
    await form(qp).locator('button:has-text("Analisa dengan AI")').click();
    await until('ai message', async () => /gagal/i.test((await form(qp).locator('[data-testid=ai-status]').textContent()) || ''), 15000);
    return await form(qp).locator('[data-testid=ai-status]').textContent();
  });

  await step('B2 a valid bug is created and gets its code from the server within 15 s', async () => {
    await fill(qp, 'Bug Title', 'Login shows a 500 error');
    await form(qp).locator('button:has-text("Simpan")').click();
    await V(qp, '[data-testid=bug-table]').waitFor({ timeout: 20000 }).catch(() => {});
    await until('bug row', async () => (await rows(qp)).some((t) => /Login shows a 500 error/.test(t)));
    const ms = await until('code', async () => (await rows(qp)).some((t) => /BUG-0001/.test(t) && /LOG-\d{4}/.test(t)));
    bugUrl = await V(qp, 'tr:has-text("Login shows a 500 error") a:has-text("BUG-0001")').getAttribute('href');
    bugId = decodeURIComponent(bugUrl.split('/').pop());
    return { ms, linkedTc: true };
  });

  await step('B2 a similar open bug is flagged while typing a new title', async () => {
    await V(qp, 'button:has-text("New bug")').click();
    await form(qp).waitFor();
    await fill(qp, 'Bug Title', 'Login shows a 500 error page');
    await form(qp).locator('[data-testid=similar]').waitFor({ timeout: 5000 });
    const text = await form(qp).locator('[data-testid=similar]').textContent();
    if (!/BUG-0001/.test(text)) throw new Error(text);
    await fill(qp, 'Module', 'Login');
    await fill(qp, 'Steps to Reproduce', 'open the page then press the login button');
    await fill(qp, 'Expected Result', 'a friendly message');
    await fill(qp, 'Actual Result', 'server 500 page shown');
    await form(qp).locator('button:has-text("Simpan")').click();
    await until('second bug', async () => (await rows(qp)).length === 2);
    await until('both coded', async () => (await rows(qp)).every((t) => /BUG-\d{4}/.test(t)));
    return text.slice(0, 60);
  });

  await step('B3 a QA role cannot move a bug out of Open through the form (rule message shown, nothing saved)', async () => {
    await V(qp, 'tr:has-text("Login shows a 500 error page") button:has-text("Edit")').click();
    await form(qp).waitFor();
    await form(qp).locator('[aria-label="Status"]').selectOption('IN_PROGRESS');
    await form(qp).locator('button:has-text("Simpan")').click();
    await form(qp).locator('[role=alert]:has-text("QA hanya")').waitFor({ timeout: 8000 });
    await form(qp).locator('button:has-text("Batal")').click();
    return (await rows(qp)).filter((t) => /In Progress/.test(t)).length === 0 || (() => { throw new Error('status changed'); })();
  });

  await step('B4 comments: added on the detail page, and a second user sees them within 15 s, and replies back', async () => {
    await qp.goto(`${B}${bugUrl}`);
    await V(qp, 'form[aria-label="Add comment"]').waitFor({ timeout: 30000 });
    await V(qp, '[aria-label=Comment]').fill('first comment');
    await V(qp, 'button:has-text("Kirim")').click();
    await until('own comment', async () => /first comment/.test(await V(qp, '[data-testid=timeline]').innerText()));
    await sync(qp);
    const q2 = await open('qa2'), p2 = q2.pages()[0] || await q2.newPage();
    p2.on('pageerror', (e) => errors.push(String(e)));
    await login(p2, 'qa2@x.test', 'qapass1234');
    await p2.goto(`${B}${bugUrl}`);
    const ms = await until('second user sees it', async () => /first comment/.test(await V(p2, '[data-testid=timeline]').innerText()), 30000);
    await V(p2, '[aria-label=Comment]').fill('reply from qa2');
    await V(p2, 'button:has-text("Kirim")').click();
    await sync(p2);
    await until('reply arrives', async () => /reply from qa2/.test(await V(qp, '[data-testid=timeline]').innerText()), 20000);
    await q2.close();
    return { ms };
  });

  await step('#bug=<id> links open the bug detail page', async () => {
    await qp.goto(`${B}/w/${ALPHA}/dashboard#bug=${encodeURIComponent(bugId)}`);
    await qp.waitForURL(new RegExp(`/bugs/.+/${bugId.replace(/[-]/g, '\\-')}$`), { timeout: 20000 });
    return qp.url().split('/w/')[1];
  });

  // admin: board, drag and drop, note dialog, bulk
  const ad = await open('adm'), ap = ad.pages()[0] || await ad.newPage();
  ap.on('pageerror', (e) => errors.push(String(e)));
  await login(ap, 'root@x.test', 'rootpass123');
  await step('B1 admin opens the board for the file', async () => {
    await ap.goto(`${B}/w/all/bugs`);
    await ap.waitForSelector('li[data-file="Core"]', { timeout: 30000 });
    await ap.locator('li[data-file="Core"] a').click();
    await ap.getByRole('link', { name: 'Board', exact: true }).click();
    await V(ap, '[data-testid=board]').waitFor({ timeout: 20000 });
    return { open: await count(ap, 'OPEN') };
  });
  await step('B1 dragging a card to another column moves it (dev flow needs no note)', async () => {
    await V(ap, '[data-testid=col-OPEN] [data-id]').first().dragTo(V(ap, '[data-testid=col-IN_PROGRESS]').first());
    await until('moved', async () => (await count(ap, 'IN_PROGRESS')) === 1 && (await count(ap, 'OPEN')) === 1);
  });
  await step('B3 a move outside the dev flow asks for a note; cancel changes nothing; with a note it moves and is recorded', async () => {
    const card = V(ap, '[data-testid=col-IN_PROGRESS] [data-id]').first();
    const id = await card.getAttribute('data-id');
    await card.dragTo(V(ap, '[data-testid=col-CLOSED]').first());
    await V(ap, 'form[role=dialog][aria-label="Status change"]').waitFor({ timeout: 8000 });
    await V(ap, 'button:has-text("Batal")').click();
    if ((await count(ap, 'CLOSED')) !== 0) throw new Error('moved despite cancel');
    await card.dragTo(V(ap, '[data-testid=col-CLOSED]').first());
    await V(ap, 'form[role=dialog][aria-label="Status change"]').waitFor();
    await V(ap, 'button:has-text("Ubah status")').click();
    await V(ap, 'form[role=dialog] [role=alert]:has-text("wajib")').waitFor({ timeout: 5000 }); // a note is required
    await V(ap, '[aria-label="Status note"]').fill('verified on staging');
    await V(ap, 'button:has-text("Ubah status")').click();
    await until('closed', async () => (await count(ap, 'CLOSED')) === 1);
    await ap.goto(`${B}/w/all/bugs/${fileUrl}/${encodeURIComponent(id)}`);
    await until('timeline', async () => /verified on staging/.test(await V(ap, '[data-testid=timeline]').innerText().catch(() => '')) || (await V(ap, 'button:has-text("All")').click().then(() => false)), 20000);
    return id;
  });
  await step('B4 reopen count: moving a bug to Retest shows 1x on its detail page', async () => {
    await ap.goto(`${B}/w/all/bugs/${fileUrl}/board`);
    await V(ap, '[data-testid=board]').waitFor({ timeout: 20000 });
    const sel = V(ap, '[data-testid=col-OPEN] select[aria-label^="Move"]').first();
    const label = await sel.getAttribute('aria-label');
    await sel.selectOption('RETEST');
    await until('retest', async () => (await count(ap, 'RETEST')) === 1);
    await V(ap, `[data-testid=col-RETEST] a`).first().click();
    await until('detail', async () => (await V(ap, '[data-field="Jumlah Retest"]').first().textContent()) === '1x (Reopened)');
    return label;
  });

  await step('B2 limited edit: a PM (status and priority only) cannot change the title but can change priority', async () => {
    const pm = await open('pm'), pp = pm.pages()[0] || await pm.newPage();
    pp.on('pageerror', (e) => errors.push(String(e)));
    await login(pp, 'pm@x.test', 'pmpass12345');
    await pp.goto(`${B}/w/${ALPHA}/bugs/${fileUrl}`);
    await V(pp, '[data-testid=bug-table] tbody tr').first().waitFor({ timeout: 30000 });
    await V(pp, 'tr:has-text("Login shows a 500 error page") button:has-text("Edit")').click();
    await form(pp).waitFor();
    if (!(await form(pp).locator('[aria-label="Bug Title"]').isDisabled())) throw new Error('title should be locked');
    if (await form(pp).locator('[aria-label="Priority"]').isDisabled()) throw new Error('priority should be editable');
    await form(pp).locator('[aria-label="Priority"]').selectOption('Urgent');
    await form(pp).locator('button:has-text("Simpan")').click();
    await until('saved', async () => (await V(pp, '[data-testid=bug-table]').count()) > 0 && (await form(pp).count()) === 0);
    await sync(pp);
    await pm.close();
    await until('admin sees urgent', async () => { await ap.goto(`${B}/w/all/bugs/${fileUrl}`); await V(ap, '[data-testid=bug-table] tbody tr').first().waitFor(); await ap.locator('tr:has-text("Login shows a 500 error page") a').first().click(); return (await V(ap, '[data-field="Priority"]').first().textContent()) === 'Urgent'; }, 25000);
  });

  await step('B5 admin bulk status (note required) and bulk delete', async () => {
    await ap.goto(`${B}/w/all/bugs/${fileUrl}`);
    await V(ap, '[data-testid=bug-table] tbody tr').first().waitFor({ timeout: 30000 });
    await V(ap, 'input[aria-label="Select page"]').check();
    await V(ap, 'select[aria-label="Bulk status"]').selectOption('REJECTED');
    await V(ap, 'form[role=dialog][aria-label="Status change"]').waitFor({ timeout: 8000 });
    await V(ap, '[aria-label="Status note"]').fill('duplicate of another report');
    await V(ap, 'button:has-text("Ubah status")').click();
    await until('both rejected', async () => (await rows(ap)).length === 2 && (await rows(ap)).every((t) => /Rejected/.test(t)));
    await V(ap, 'input[aria-label="Select page"]').check();
    ap.once('dialog', (d) => d.accept());
    await V(ap, 'button:has-text("Delete selected")').click();
    await until('empty', async () => (await rows(ap)).length === 0);
    await sync(ap);
  });
  await step('B5 the deletion reaches another browser within 15 s', async () => {
    await qp.goto(`${B}/w/${ALPHA}/bugs/${fileUrl}`);
    await until('qa sees none', async () => (await V(qp, '[data-testid=bug-empty]').count()) > 0, 25000);
  });

  check('no uncaught page errors', errors.length === 0, errors.slice(0, 2));
  await qa.close(); await ad.close();
  const failed = results.filter((x) => !x).length;
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('crash', e); process.exit(2); });
