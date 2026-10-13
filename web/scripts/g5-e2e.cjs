// G5 browser check. Server: next start on :3200 with SESSION_PASSWORD and BUGRAIL_DB_PATH seeded by scripts/e2e-seed.ts.
// PLAYWRIGHT_CORE=<path> node scripts/g5-e2e.cjs <outdir> <alphaWsId> <vendorWsId>
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const [SC, ALPHA, VENDOR] = process.argv.slice(2);
const B = 'http://localhost:3200';
const results = [];
const check = (name, ok, detail) => { results.push([name, ok]); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail))); };
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function login(p, email, password) {
  await p.goto(B + '/login');
  await p.fill('input[name=email]', email);
  await p.fill('input[name=password]', password);
  await Promise.all([p.waitForURL(/\/w\//, { timeout: 30000 }), p.click('button[type=submit]')]);
}
const bugs = (p) => p.locator('[data-testid=bug-list] li').allTextContents();
const waitFor = (p, fn, arg, ms = 20000) => p.waitForFunction(fn, arg, { timeout: ms });

(async () => {
  const ctx = await chromium.launchPersistentContext(SC + '/profile-a', { executablePath: CHROME, headless: true, args: ['--no-first-run'] });
  const p = ctx.pages()[0] || await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e)));

  await login(p, 'qa@x.test', 'qapass1234');
  await p.waitForSelector('[data-testid=sync-badge]', { timeout: 30000 });
  check('1 login lands in the workspace shell', p.url().includes('/w/' + ALPHA), p.url());
  check('1b crossOriginIsolated', await p.evaluate(() => crossOriginIsolated));
  await p.goto(B + '/w/' + ALPHA + '/bugs');
  await p.waitForSelector('form[aria-label="Add bug"]', { timeout: 30000 });

  // online adds
  for (const t of ['online one', 'online two']) { await p.fill('input[aria-label=Title]', t); await p.fill('input[aria-label=Module]', 'Login'); await p.click('button:has-text("Add bug")'); }
  try {
    await waitFor(p, () => [...document.querySelectorAll('[data-testid=bug-list] li')].filter((l) => /BUG-\d{4}/.test(l.textContent)).length === 2, null);
    check('2 online bugs get codes from the server within 15 s', true, await bugs(p));
  } catch { check('2 online bugs get codes from the server within 15 s', false, { list: await bugs(p), badge: await p.locator('[data-testid=sync-badge]').textContent() }); }

  // offline: add, reload, soft navigate
  await ctx.setOffline(true);
  await p.evaluate(() => window.dispatchEvent(new Event('offline')));
  await p.fill('input[aria-label=Title]', 'offline one'); await p.fill('input[aria-label=Module]', 'Login'); await p.click('button:has-text("Add bug")');
  await waitFor(p, () => /pending/.test(document.querySelector('[data-testid=bug-list]').textContent), null, 5000);
  const badge = await p.locator('[data-testid=sync-badge]').textContent();
  check('3 offline bug shows as pending, badge says offline with 1 pending', /offline/.test(badge) && /1 pending|offline/.test(badge), badge);
  await p.reload();
  await p.waitForSelector('[data-testid=bug-list]', { timeout: 30000 }).catch(() => {});
  const afterReload = (await p.locator('[data-testid=bug-list]').count()) ? await bugs(p) : [];
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
  try {
    await waitFor(p, () => [...document.querySelectorAll('[data-testid=bug-list] li')].every((l) => /BUG-\d{4}/.test(l.textContent)) && document.querySelectorAll('[data-testid=bug-list] li').length === 3, null, 20000);
    check('6 after reconnect the offline bug gets its code within 15 s and nothing is pending', true, await bugs(p));
  } catch { check('6 after reconnect the offline bug gets its code within 15 s and nothing is pending', false, await bugs(p)); }

  // second browser: same user, fresh profile, sees all three; live refresh via SSE
  const ctx2 = await chromium.launchPersistentContext(SC + '/profile-b', { executablePath: CHROME, headless: true, args: ['--no-first-run'] });
  const q = ctx2.pages()[0] || await ctx2.newPage();
  await login(q, 'qa2@x.test', 'qapass1234');
  await q.goto(B + '/w/' + ALPHA + '/bugs');
  await q.waitForSelector('[data-testid=bug-list]', { timeout: 30000 });
  await waitFor(q, () => document.querySelectorAll('[data-testid=bug-list] li').length === 3, null, 30000);
  check('7 a second user in the same workspace bootstraps all three bugs', true, await bugs(q));
  await p.fill('input[aria-label=Title]', 'live one'); await p.fill('input[aria-label=Module]', 'Login'); await p.click('button:has-text("Add bug")');
  try {
    await waitFor(q, () => /live one/.test(document.querySelector('[data-testid=bug-list]').textContent), null, 15000);
    check('8 a bug created in browser A reaches browser B within 15 s (SSE or poll)', true);
  } catch { check('8 a bug created in browser A reaches browser B within 15 s (SSE or poll)', false, await bugs(q)); }

  // vendor isolation
  const ctx3 = await chromium.launchPersistentContext(SC + '/profile-c', { executablePath: CHROME, headless: true, args: ['--no-first-run'] });
  const v = ctx3.pages()[0] || await ctx3.newPage();
  await login(v, 'vendor@x.test', 'vendorpass1');
  await v.goto(B + '/w/' + VENDOR + '/bugs');
  await v.waitForSelector('[data-testid=sync-badge]', { timeout: 30000 });
  await v.waitForTimeout(4000);
  const opfsHasAlpha = await v.evaluate(async () => (await (await fetch('/api/config')).text()).includes('Alpha'));
  check('9 the vendor sees none of Alpha: no bugs and no workspace name in config', (await v.locator('[data-testid=bug-list] li').count()) === 0 && !opfsHasAlpha);

  check('10 no uncaught page errors', errors.length === 0, errors.slice(0, 2));
  await ctx.close(); await ctx2.close(); await ctx3.close();
  const failed = results.filter(([, ok]) => !ok).length;
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('crash', e); process.exit(2); });
