const { chromium } = require(process.env.PLAYWRIGHT_CORE || 'playwright-core');
// Usage: PLAYWRIGHT_CORE=<path to playwright-core> node scripts/g06-offline.cjs <outdir>  (server on :3100 via next start)
const SC = process.argv[2];
const B = 'http://localhost:3100';
const log = (k, v) => console.log(k.padEnd(34), JSON.stringify(v));
(async () => {
  const ctx = await chromium.launchPersistentContext(SC + '/profile', { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const p = ctx.pages()[0] || await ctx.newPage();
  const conn = () => p.getByTestId('conn').textContent();
  await p.goto(B + '/'); log('ua', await p.evaluate(() => navigator.userAgent));
  await p.evaluate(() => navigator.serviceWorker.ready.then(r => !!r.active));
  await p.reload(); await p.waitForTimeout(1500);
  log('sw controlling', await p.evaluate(() => !!navigator.serviceWorker.controller));
  log('1 badge online', await conn());
  await p.goto(B + '/opfs'); await p.waitForFunction(() => document.body.innerText.includes('wasmMerge'), null, { timeout: 20000 }); await p.waitForTimeout(3000);
  const t = async () => (await p.locator('body').innerText()).split('\n').filter(l => /boots|wasmMerge|crossOrigin/.test(l)).join(' | ');
  log('opfs online', await t());
  log('cache entries', await p.evaluate(async () => { const c = await caches.open('bugrail-spike-v1'); return (await c.keys()).map(r => new URL(r.url).pathname); }));
  await p.goto(B + '/'); await p.waitForTimeout(1500);
  await ctx.setOffline(true);
  await p.waitForTimeout(500);
  // 4 first: soft nav in the same page session that prefetched online
  try {
    await p.locator('a[href="/other"]').click();
    await p.waitForSelector('h1:has-text("Other page")', { timeout: 15000 });
    log('4 soft nav /other (same session)', { h1: await p.locator('h1:visible').textContent(), url: p.url(), badge: await conn() });
    await p.screenshot({ path: SC + '/s4.png' });
    await p.locator('a[href="/"]').click();
    await p.waitForSelector('h1:has-text("BugRail G0 spike")', { timeout: 8000 });
    log('4b soft nav back / (same session)', p.url());
  } catch (e) { log('4/4b soft nav FAIL', { err: e.message.split('\n')[0], url: p.url(), h1: await p.locator('h1').allTextContents() }); }
  await p.goto(B + '/');
  try { await p.reload({ timeout: 15000 }); await p.waitForTimeout(2000); log('3 reload / offline', { h1: await p.locator('h1').textContent(), badge: await conn() }); await p.screenshot({ path: SC + '/s3.png' }); } catch (e) { log('3 reload FAIL', e.message.split('\n')[0]); }
  try {
    await p.locator('a[href="/other"]').click();
    await p.waitForSelector('h1:has-text("Other page")', { timeout: 8000 });
    log('4c soft nav after offline reload', { url: p.url(), badge: await conn() });
  } catch (e) { log('4c soft nav after offline reload FAIL', { err: e.message.split('\n')[0], url: p.url(), badge: await conn() }); }
  try {
    await p.goto(B + '/opfs', { timeout: 15000 }); await p.waitForFunction(() => document.body.innerText.includes('wasmMerge'), null, { timeout: 20000 }); await p.waitForTimeout(3000);
    log('5 opfs goto offline', await t());
    await p.reload({ timeout: 15000 }); await p.waitForFunction(() => document.body.innerText.includes('wasmMerge'), null, { timeout: 20000 }); await p.waitForTimeout(3000);
    log('5 opfs reload offline', await t()); log('5 badge', await conn());
    await p.screenshot({ path: SC + '/s5.png' });
  } catch (e) { log('5 FAIL', e.message.split('\n')[0]); }
  await ctx.setOffline(false);
  const t0 = Date.now();
  try { await p.waitForFunction(() => document.querySelector('[data-testid=conn]').textContent === 'online', null, { timeout: 15000 }); log('6 back online ms', Date.now() - t0); } catch { log('6 FAIL still', await conn()); }
  await p.screenshot({ path: SC + '/s6.png' });
  await ctx.close();
})();
