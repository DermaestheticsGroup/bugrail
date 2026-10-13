// Slice 6c browser check: Dashboard, Summary, Report, Notifications, Activity Log, driven over data created through the UI.
// PLAYWRIGHT_CORE=<path> node scripts/g6c-e2e.cjs <outdir> <alphaWsId> <vendorWsId>   (server on :3200, seeded by scripts/e2e-seed.ts)
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
const val = async (p, id) => Number((await V(p, `[data-testid=${id}-value]`).first().textContent()) || -1);
const text = (p, id) => V(p, `[data-testid=${id}]`).first().innerText();
const sync = (p) => until('synced', async () => /up to date/.test(await V(p, '[data-testid=pending]').first().textContent()), 20000);

(async () => {
  const errors = [];
  const qa = await open('qa'), qp = qa.pages()[0] || await qa.newPage();
  qp.on('pageerror', (e) => errors.push(String(e)));
  await login(qp, 'qa@x.test', 'qapass1234');

  await step('setup: a file, three test cases (Failed, Passed, Open) and one bug made from the Failed one', async () => {
    await qp.goto(`${B}/w/${ALPHA}/testcases`);
    await qp.waitForSelector('form[aria-label="Add file"]', { timeout: 30000 });
    await qp.fill('input[aria-label="File name"]', 'Core');
    await qp.click('button:has-text("Add file")');
    await qp.locator('li[data-file="Core"] a').click();
    await qp.waitForSelector('button:has-text("New test case")');
    for (const [mod, sc] of [['Login', 'Wrong password'], ['Cart', 'Add item'], ['Cart', 'Remove item']]) {
      await qp.click('button:has-text("New test case")');
      const tf = qp.locator('form[aria-label="Test case form"]');
      await tf.locator('input[list=tc-modules]').fill(mod);
      await tf.locator('label:has-text("Scenario") input').fill(sc);
      await tf.locator('label:has-text("Steps") textarea').fill('open the page and press the button');
      await tf.locator('label:has-text("Expected result") textarea').fill('the expected thing happens');
      await tf.locator('button:has-text("Save")').click();
      await qp.waitForSelector(`tr:has-text("${sc}")`);
    }
    for (const [sc, status, actual] of [['Wrong password', 'Failed', 'server returned a 500 error'], ['Add item', 'Passed', 'item was added to the cart']]) {
      await qp.locator(`tr:has-text("${sc}") button:has-text("Run")`).click();
      await qp.fill('form[aria-label=Execute] textarea', actual);
      await qp.selectOption('form[aria-label=Execute] select', status);
      await qp.click('button:has-text("Save result")');
      await until('result saved', async () => (await V(qp, `tr:has-text("${sc}")`).first().textContent()).includes(status));
    }
    await V(qp, 'tr:has-text("Wrong password") a:has-text("Create Bug")').click();
    const form = V(qp, 'form[aria-label="Bug form"]');
    await form.waitFor({ timeout: 20000 });
    await form.locator('[aria-label="Bug Title"]').fill('Login shows a 500 error');
    await form.locator('[aria-label="Severity"]').selectOption('Critical');
    await form.locator('button:has-text("Simpan")').click();
    await until('bug row', async () => (await V(qp, '[data-testid=bug-table] tbody tr').allTextContents()).some((t) => /Login shows a 500 error/.test(t)));
    await sync(qp);
  });

  await step('D1 Dashboard numbers match what was entered', async () => {
    await qp.goto(`${B}/w/${ALPHA}/dashboard`);
    await V(qp, '[data-testid=c-tc]').waitFor({ timeout: 30000 });
    await until('numbers', async () => (await val(qp, 'c-tc')) === 3);
    const got = { tc: await val(qp, 'c-tc'), passed: await val(qp, 'c-passed'), failed: await val(qp, 'c-failed'), open: await val(qp, 'c-open'), module: await val(qp, 'c-module'), bug: await val(qp, 'c-bug') };
    if (JSON.stringify(got) !== JSON.stringify({ tc: 3, passed: 1, failed: 1, open: 1, module: 2, bug: 1 })) throw new Error(JSON.stringify(got));
    const overall = await text(qp, 'overall');
    if (!/33%/.test(overall)) throw new Error(overall);
    const sev = await text(qp, 'd-severity');
    if (!/Critical: 1/.test(sev)) throw new Error(sev);
    return got;
  });

  await step('D2 the module filter narrows the cards; module bars list both modules; reset restores', async () => {
    const bars = await text(qp, 'module-bars');
    if (!/Login/.test(bars) || !/Cart/.test(bars)) throw new Error(bars);
    await V(qp, '[aria-label="Module filter"]').selectOption('Cart');
    await until('narrowed', async () => (await val(qp, 'c-tc')) === 2);
    if ((await val(qp, 'c-bug')) !== 0) throw new Error('bug count should be 0 for Cart');
    await V(qp, 'button:has-text("Reset filters")').click();
    await until('restored', async () => (await val(qp, 'c-tc')) === 3);
  });

  await step('S1 Summary: file and date filters, analysis text, bug per file', async () => {
    await qp.goto(`${B}/w/${ALPHA}/summary`);
    await V(qp, '[data-testid=findings]').waitFor({ timeout: 30000 });
    await until('analysis', async () => /Pass rate rendah|moderat|baik/.test(await text(qp, 'findings')));
    const f = await text(qp, 'findings');
    if (!/Critical/.test(await text(qp, 'recommendations'))) throw new Error('missing Critical recommendation');
    if (!/Core/.test(await text(qp, 'bug-per-file'))) throw new Error('bug per file missing Core');
    await V(qp, '[aria-label="Date from"]').fill('2999-01-01');
    // executed cases fall outside the range; the Open one has no execution date and is never excluded by it
    await until('date narrowed', async () => (await val(qp, 'c-tc')) === 1);
    await V(qp, 'button:has-text("Reset filters")').click();
    return f.slice(0, 80);
  });

  await step('R1 Report: Critical bug open and 50% pass rate gives NO GO with the reason and a must-fix list', async () => {
    await qp.goto(`${B}/w/${ALPHA}/report`);
    await V(qp, '[data-testid=verdict]').waitFor({ timeout: 30000 });
    await until('verdict', async () => (await V(qp, '[data-testid=verdict]').first().getAttribute('data-verdict')) === 'NO_GO');
    const reason = await text(qp, 'reason');
    if (!/1 bug Critical terbuka/.test(reason)) throw new Error(reason);
    if (!/Login shows a 500 error|BUG-/.test(await text(qp, 'must-fix'))) throw new Error('must-fix empty');
    const rows = await V(qp, '[data-testid=module-table] tbody tr').count();
    if (rows !== 2) throw new Error('module rows ' + rows);
    return reason;
  });

  await step('N1 reminder: the bell tells the creator one file still has a test case not run', async () => {
    await qp.goto(`${B}/w/${ALPHA}/dashboard`);
    await V(qp, '[aria-label=Notifikasi]').waitFor({ timeout: 30000 });
    await V(qp, '[aria-label=Notifikasi]').click();
    await until('reminder', async () => /1 test case belum dijalankan/.test(await text(qp, 'notif-panel')));
  });

  // qa assigns the bug to qa2: qa2's bell must show it, and opening the panel clears the badge.
  await step('N2 assigning a bug notifies the assignee; opening the panel clears the badge; the link opens the bug', async () => {
    await qp.goto(`${B}/w/${ALPHA}/bugs`);
    await qp.locator('li[data-file="Core"] a').click();
    await V(qp, 'tr:has-text("Login shows a 500 error") button:has-text("Edit")').click();
    const form = V(qp, 'form[aria-label="Bug form"]');
    await form.waitFor();
    await form.locator('[aria-label="Assign ke"]').selectOption('qa2@x.test');
    await form.locator('button:has-text("Simpan")').click();
    await form.waitFor({ state: 'detached', timeout: 15000 });
    await sync(qp);
    const q2 = await open('qa2'), p2 = q2.pages()[0] || await q2.newPage();
    p2.on('pageerror', (e) => errors.push(String(e)));
    await login(p2, 'qa2@x.test', 'qapass1234');
    await p2.goto(`${B}/w/${ALPHA}/dashboard`);
    await until('badge', async () => (await V(p2, '[data-testid=notif]').first().locator('[data-testid=notif-badge]').textContent()).trim() === '1', 30000);
    await V(p2, '[aria-label=Notifikasi]').click();
    const panel = await text(p2, 'notif-panel');
    if (!/di-assign ke Anda oleh qa@x.test/.test(panel) && !/Bug baru/.test(panel)) throw new Error(panel);
    if ((await V(p2, '[data-testid=notif]').first().locator('[data-testid=notif-badge]').textContent()).trim() !== '') throw new Error('badge not cleared');
    await V(p2, '[data-testid=notif-event] a').first().click();
    await p2.waitForURL(/\/bugs\/.+\/.+/, { timeout: 15000 });
    await V(p2, '[data-testid=timeline]').waitFor({ timeout: 20000 });
    await q2.close();
  });

  await step('A1 Activity Log: admin sees the entries, can filter and search; a QA role is refused', async () => {
    await qp.goto(`${B}/w/${ALPHA}/activity`);
    await V(qp, '[data-testid=no-access]').waitFor({ timeout: 30000 });
    const ad = await open('admin'), ap = ad.pages()[0] || await ad.newPage();
    await login(ap, 'root@x.test', 'rootpass123');
    await ap.goto(`${B}/w/${ALPHA}/activity`);
    await until('rows', async () => (await V(ap, '[data-testid=activity-table] tbody tr').count()) >= 3, 30000);
    const all = await V(ap, '[data-testid=activity-table] tbody tr').count();
    await V(ap, '[aria-label="Action filter"]').selectOption('bugreport');
    const bug = await V(ap, '[data-testid=activity-table] tbody tr').allTextContents();
    if (!bug.length || !bug.every((t) => /bugreport_/.test(t))) throw new Error('group filter: ' + bug.join('|'));
    await V(ap, '[aria-label="Action filter"]').selectOption('');
    await V(ap, '[aria-label=Search]').fill('qa@x.test nomatchword');
    await until('empty', async () => (await V(ap, '[data-testid=activity-empty]').count()) > 0);
    await V(ap, '[aria-label=Search]').fill('qa@x.test');
    await until('some', async () => (await V(ap, '[data-testid=activity-table] tbody tr').count()) > 0);
    await V(ap, '[data-testid=activity-table] tbody tr').first().click();
    await V(ap, 'dialog[aria-label="Activity detail"]').waitFor({ timeout: 5000 });
    await ad.close();
    return { all, bugEntries: bug.length };
  });

  check('no uncaught page errors', errors.length === 0, errors.slice(0, 2));
  await qa.close();
  const failed = results.filter((x) => !x).length;
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('crash', e); process.exit(2); });
