// Rewind inside BugRail: the sign-in gate, links both ways, routes under /rewind, local-first persistence and offline use.
// Ported from the Rewind repo's e2e/local-first.spec.ts.
// PLAYWRIGHT_CORE=<path> node scripts/rewind-e2e.cjs <outdir> <alphaWsId> <vendorWsId>   (server on :3200 via `next start`, seeded by scripts/e2e-seed.ts)
const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
const [SC, ALPHA] = process.argv.slice(2);
const B = 'http://localhost:3200';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 240))); };
const open = (name) => chromium.launchPersistentContext(`${SC}/${name}`, { executablePath: CHROME, headless: true, args: ['--no-first-run'] });
const until = async (what, fn, ms = 15000) => { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return Date.now() - t; } catch { /* retry */ } if (Date.now() - t > ms) throw new Error('timeout: ' + what); await new Promise((r) => setTimeout(r, 250)); } };
const step = async (name, fn) => { try { const d = await fn(); check(name, true, d); } catch (e) { check(name, false, String(e.message || e).slice(0, 220)); } };
const path = (p) => new URL(p.url()).pathname;
const CARD = 'Checkout fails after applying coupon';
const boardColumn = (p) => p.getByText(/^Triaging\s*\d+$/);

(async () => {
  const errors = [];
  const ctx = await open('qa'), p = ctx.pages()[0] || await ctx.newPage();
  p.on('pageerror', (e) => errors.push(path(p) + ' ' + String(e)));

  await step('R1 signed out: /rewind goes to /login and the Rewind APIs answer 401', async () => {
    await p.goto(B + '/rewind');
    await until('login', async () => path(p) === '/login');
    const api = (await p.request.get(B + '/api/rewind/rewinds')).status();
    const sync = (await p.request.post(B + '/api/rewind/sync/pull-updates')).status();
    if (api !== 401 || sync !== 401) throw new Error(JSON.stringify({ api, sync }));
    return { api, sync };
  });

  await p.fill('input[name=email]', 'qa@x.test');
  await p.fill('input[name=password]', 'qapass1234');
  await Promise.all([p.waitForURL(/\/w\//, { timeout: 30000 }), p.click('button[type=submit]')]);

  await step('R2 BugRail sidebar opens Rewind, Rewind sidebar returns to BugRail', async () => {
    await p.goto(`${B}/w/${ALPHA}/dashboard`);
    await p.getByRole('link', { name: 'Rewind' }).click();
    await p.waitForURL(/\/rewind$/, { timeout: 15000 });
    await p.getByText(CARD).first().waitFor({ timeout: 15000 });
    await p.getByText('BugRail', { exact: true }).first().click();
    await p.waitForURL(/\/w\//, { timeout: 15000 });
    return path(p);
  });

  await step('R3 routes live under /rewind and back/forward restore them', async () => {
    await p.goto(B + '/rewind');
    await p.getByText('Recording links').first().click();
    await p.waitForURL(/\/rewind\/links$/);
    await p.goBack();
    await p.waitForURL(/\/rewind$/);
    await p.getByText(CARD).first().click();
    await p.waitForURL(/\/rewind\/r\/r1$/);
    return path(p);
  });

  await step('R4 a change persists in the local database across a reload', async () => {
    await p.goto(B + '/rewind');
    await p.locator('html[data-db=ready]').waitFor({ state: 'attached', timeout: 20000 });
    await p.getByText('Board', { exact: true }).click();
    await boardColumn(p).waitFor({ timeout: 10000 });
    await p.waitForTimeout(500);
    await p.reload();
    await boardColumn(p).waitFor({ timeout: 20000 });
  });

  await step('R5 offline: navigation, reload and a full load of /rewind keep working', async () => {
    await until('service worker controls the page', () => p.evaluate(() => !!navigator.serviceWorker?.controller), 20000);
    await ctx.setOffline(true);
    await p.getByText('Grid', { exact: true }).click();
    await p.getByText('Recording links').first().click();
    await p.waitForURL(/\/rewind\/links$/);
    await p.waitForTimeout(500);
    await p.reload();
    await p.getByText("Dhiaz's Workspace").first().waitFor({ timeout: 15000 });
    await p.goto(B + '/rewind').catch(() => {}); // offline full load, served by the service worker
    await p.getByText('Group duplicates').waitFor({ timeout: 15000 });
    if (await boardColumn(p).count()) throw new Error('board view came back after switching to grid');
    await ctx.setOffline(false);
  });

  check('no uncaught page errors', errors.length === 0, errors.slice(0, 2));
  await ctx.close();
  const failed = results.filter((x) => !x).length;
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('crash', e); process.exit(2); });
