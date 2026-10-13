// G5 browser check (offline, sync, SSE, isolation, user switch), driven through the Bug Report screens.
// Server: next start on :3200 with SESSION_PASSWORD and BUGRAIL_DB_PATH seeded by scripts/e2e-seed.ts (see scripts/e2e-run.sh).
// PLAYWRIGHT_CORE=<path> node scripts/g5-e2e.cjs <outdir> <alphaWsId> <vendorWsId>
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const [SC, ALPHA, VENDOR] = process.argv.slice(2);
const B = 'http://localhost:3200';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const results = [];
const check = (name, ok, detail) => { results.push([name, ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 240))); };
// Next keeps visited screens mounted but hidden: every locator must mean the visible one.
const V = (page, sel) => page.locator(`${sel}:visible`);
const ROWS = '[data-testid=bug-table] tbody tr';
const bugs = (p) => V(p, ROWS).allTextContents();
const until = async (what, fn, ms = 15000) => { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return Date.now() - t; } catch { /* retry */ } if (Date.now() - t > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 250)); } };
const pendingText = (p) => V(p, '[data-testid=pending]').first().textContent();

async function login(p, email, password) {
  await p.goto(B + '/login');
  await p.fill('input[name=email]', email);
  await p.fill('input[name=password]', password);
  await Promise.all([p.waitForURL(/\/w\//, { timeout: 30000 }), p.click('button[type=submit]')]);
  await p.waitForSelector('[data-testid=sync-badge]', { timeout: 30000 });
}
// Adds one bug through the real form (every required field filled).
async function addBug(p, title) {
  await V(p, 'button:has-text("New bug")').click();
  const f = V(p, 'form[aria-label="Bug form"]');
  await f.waitFor({ timeout: 15000 });
  await f.locator('[aria-label="Module"]').fill('Login');
  await f.locator('[aria-label="Steps to Reproduce"]').fill('open the page then press the login button');
  await f.locator('[aria-label="Expected Result"]').fill('the user is logged in');
  await f.locator('[aria-label="Bug Title"]').fill(title);
  await f.locator('[aria-label="Actual Result"]').fill('an error page is shown');
  await f.locator('button:has-text("Simpan")').click();
  await f.waitFor({ state: 'detached', timeout: 15000 });
}
const open = (name) => chromium.launchPersistentContext(`${SC}/${name}`, { executablePath: CHROME, headless: true, args: ['--no-first-run'] });

(async () => {
  const ctx = await open('profile-a');
  const p = ctx.pages()[0] || await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));

  await login(p, 'qa@x.test', 'qapass1234');
  check('1 login lands in the workspace shell', p.url().includes('/w/' + ALPHA), p.url());
  check('1b crossOriginIsolated', await p.evaluate(() => crossOriginIsolated));

  // a file to hold the bugs
  await p.goto(`${B}/w/${ALPHA}/bugs`);
  await p.waitForSelector('form[aria-label="Add file"]', { timeout: 30000 });
  await p.fill('input[aria-label="File name"]', 'G5');
  await p.click('button:has-text("Add file")');
  await p.locator('li[data-file="G5"] a').click();
  await p.waitForSelector('button:has-text("New bug")', { timeout: 20000 });
  const fileUrl = p.url();

  // online adds
  await addBug(p, 'online one'); await addBug(p, 'online two');
  try {
    await until('codes', async () => (await bugs(p)).filter((t) => /BUG-\d{4}/.test(t)).length === 2, 15000);
    check('2 online bugs get codes from the server within 15 s', true, await bugs(p));
  } catch { check('2 online bugs get codes from the server within 15 s', false, { list: await bugs(p), badge: await pendingText(p) }); }

  // A route reloads offline only if it was opened as a real page load while online (its document and first-render payload are
  // then cached). Soft navigation alone is not enough, so load the bug list as a page once before going offline.
  await p.goto(fileUrl);
  await p.waitForSelector('button:has-text("New bug")', { timeout: 20000 });
  await p.waitForTimeout(1500);

  // offline: add, reload, soft navigate
  await ctx.setOffline(true);
  await p.evaluate(() => window.dispatchEvent(new Event('offline')));
  await addBug(p, 'offline one');
  await until('pending row', async () => (await bugs(p)).some((t) => /pending/.test(t)), 5000).catch(() => {});
  const badge = await V(p, '[data-testid=sync-badge]').first().textContent();
  // One bug is two outbox rows: the bug and its activity-log entry.
  check('3 offline bug shows as pending, badge says offline and counts exactly 2 pending (bug + its activity row)', /offline/.test(badge) && /\b2 pending\b/.test(await pendingText(p)), badge);
  await p.reload();
  await p.waitForSelector('[data-testid=bug-table]', { timeout: 30000 }).catch(() => {});
  const afterReload = (await V(p, '[data-testid=bug-table]').count()) ? await bugs(p) : [];
  check('4 offline reload opens the app with its local data', afterReload.some((t) => /offline one/.test(t)), afterReload);
  try {
    await p.getByRole('link', { name: 'Test Case', exact: true }).click();
    await p.waitForSelector('h1:has-text("Test Case")', { timeout: 15000 });
    check('5 offline soft navigation to another screen works', true, p.url());
    await p.getByRole('link', { name: 'Bug Report', exact: true }).click();
    await p.waitForSelector('h1:has-text("Bug Report")', { timeout: 15000 });
  } catch (e) { check('5 offline soft navigation to another screen works', false, String(e).slice(0, 120)); }

  // back online
  await ctx.setOffline(false);
  await p.evaluate(() => window.dispatchEvent(new Event('online')));
  await p.goto(fileUrl);
  const t6 = Date.now();
  try {
    await until('reconnect', async () => { const r = await bugs(p); return r.length === 3 && r.every((t) => /BUG-\d{4}/.test(t)) && !/pending/.test(await pendingText(p)); }, 15000);
    check('6 after reconnect the offline bug gets its code within 15 s and nothing is pending', true, { ms: Date.now() - t6, list: await bugs(p) });
  } catch { check('6 after reconnect the offline bug gets its code within 15 s and nothing is pending', false, { ms: Date.now() - t6, list: await bugs(p), badge: await pendingText(p) }); }

  // second browser, same workspace: bootstrap and live refresh
  const ctx2 = await open('profile-b');
  const q = ctx2.pages()[0] || await ctx2.newPage();
  q.on('pageerror', (e) => errors.push(String(e)));
  await login(q, 'qa2@x.test', 'qapass1234');
  await q.goto(fileUrl);
  try {
    await until('bootstrap', async () => (await bugs(q)).length === 3, 30000);
    check('7 a second user in the same workspace bootstraps all three bugs', true, await bugs(q));
  } catch { check('7 a second user in the same workspace bootstraps all three bugs', false, await bugs(q)); }
  await addBug(p, 'live one');
  try {
    await until('live', async () => (await bugs(q)).some((t) => /live one/.test(t)), 15000);
    check('8 a bug created in browser A reaches browser B within 15 s (SSE or poll)', true);
  } catch { check('8 a bug created in browser A reaches browser B within 15 s (SSE or poll)', false, await bugs(q)); }

  // vendor isolation
  const ctx3 = await open('profile-c');
  const v = ctx3.pages()[0] || await ctx3.newPage();
  await login(v, 'vendor@x.test', 'vendorpass1');
  await v.goto(B + '/w/' + VENDOR + '/bugs');
  await v.waitForSelector('[data-testid=sync-badge]', { timeout: 30000 });
  await v.waitForTimeout(4000);
  const configText = await v.evaluate(async () => (await fetch('/api/config')).text());
  const vendorFiles = await V(v, '[data-testid=file-list] li').count();
  check('9 the vendor sees none of Alpha: no files and no workspace name in config', vendorFiles === 0 && !configText.includes('Alpha'), { vendorFiles });

  // user switch on the same device: the previous user's local database must really be gone
  const opfsNames = () => p.evaluate(async () => { const out = []; for await (const [n] of (await navigator.storage.getDirectory()).entries()) out.push(n); return out; });
  const userA = await p.evaluate(() => JSON.parse(localStorage.getItem('bugrail.currentUser')).id);
  check('11a before the switch, user A has local database files', (await opfsNames()).some((n) => n.startsWith('bugrail-' + userA)), await opfsNames());
  await p.getByRole('button', { name: 'Log out' }).click();
  await p.waitForURL(/\/login/, { timeout: 15000 });
  await p.waitForTimeout(1500);
  await login(p, 'qa2@x.test', 'qapass1234');
  await p.goto(fileUrl);
  await until('bootstrap B', async () => (await bugs(p)).length >= 3, 30000).catch(() => {});
  const after = await opfsNames();
  check('11b after user B signs in, user A local files are removed from OPFS', !after.some((n) => n.startsWith('bugrail-' + userA)), after);
  check('11c user B bootstraps the workspace data into their own database', (await bugs(p)).length >= 3);

  check('10 no uncaught page errors', errors.length === 0, errors.slice(0, 2));
  await ctx.close(); await ctx2.close(); await ctx3.close();
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('crash', e); process.exit(2); });
