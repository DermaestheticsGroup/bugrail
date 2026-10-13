// Slice 6d-1 browser check: master status, settings, users, roles, workspaces (admin) and the refusals for a QA role.
// PLAYWRIGHT_CORE=<path> node scripts/g6d1-e2e.cjs <outdir> <alphaWsId> <vendorWsId>   (server on :3200, seeded by scripts/e2e-seed.ts)
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
const page = (p, slug) => p.goto(`${B}/w/${ALPHA}/${slug}`);
const texts = (p, sel) => V(p, sel).allTextContents();

(async () => {
  const errors = [];
  const ad = await open('admin'), p = ad.pages()[0] || await ad.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('dialog', (d) => d.accept());
  await login(p, 'root@x.test', 'rootpass123');

  await step('A1 master status: defaults listed; add one; a duplicate name and a bad colour are refused; rename keeps the code; delete', async () => {
    await page(p, 'master/status');
    await V(p, '[data-testid=status-table]').waitFor({ timeout: 30000 });
    const first = await texts(p, '[data-testid=status-table] tbody tr');
    if (first.length !== 6) throw new Error('defaults: ' + first.length);
    await V(p, 'button:has-text("Tambah status")').click();
    const f = V(p, 'form[aria-label="Status form"]');
    await f.locator('[aria-label="Nama Status"]').fill('Closed');
    await f.locator('[aria-label="Warna Label"]').fill('red');
    await f.locator('button:has-text("Simpan")').click();
    await f.locator('[data-error=name]').waitFor({ timeout: 5000 });
    await f.locator('[data-error=color]').waitFor({ timeout: 5000 });
    await f.locator('[aria-label="Nama Status"]').fill('Ready for QA');
    await f.locator('[aria-label="Warna Label"]').fill('#123456');
    await f.locator('button:has-text("Simpan")').click();
    await V(p, 'tr[data-code=READY_FOR_QA]').waitFor({ timeout: 10000 });
    await V(p, 'tr[data-code=READY_FOR_QA] button:has-text("Edit")').click();
    await f.locator('[aria-label="Nama Status"]').fill('Ready to test');
    await f.locator('button:has-text("Simpan")').click();
    await until('renamed', async () => /Ready to test/.test(await V(p, 'tr[data-code=READY_FOR_QA]').first().textContent()));
    await V(p, 'tr[data-code=READY_FOR_QA] button:has-text("Hapus")').click();
    await until('deleted', async () => (await V(p, 'tr[data-code=READY_FOR_QA]').count()) === 0);
  });

  await step('A2/A6 settings: custom field add, duplicate refused, remove; key saved on the server; theme remembered', async () => {
    await page(p, 'settings');
    await V(p, 'form[aria-label="Custom field"]').waitFor({ timeout: 30000 });
    await V(p, '[aria-label="Custom field name"]').fill('Region');
    await V(p, 'button:has-text("Tambah field")').click();
    await V(p, '[data-testid=custom-fields] li:has-text("Region")').waitFor({ timeout: 10000 });
    await V(p, '[aria-label="Custom field name"]').fill('Region');
    await V(p, 'button:has-text("Tambah field")').click();
    await V(p, '[role=alert]:has-text("sudah ada")').waitFor({ timeout: 5000 });
    await V(p, '[data-testid=custom-fields] li:has-text("Region") button').click();
    await until('removed', async () => (await V(p, '[data-testid=custom-fields] li').count()) === 0);
    await V(p, '[aria-label="Gemini API key"]').fill('test-key-123');
    await V(p, 'button:has-text("Simpan key")').click();
    await until('key saved', async () => /disimpan/.test(await V(p, '[data-testid=key-status]').first().textContent()));
    await V(p, '[aria-label=Theme]').selectOption('dark');
    if ((await p.evaluate(() => localStorage.getItem('qa_theme'))) !== 'dark') throw new Error('theme not stored');
  });

  await step('A5 workspaces: add, rename, delete', async () => {
    await page(p, 'workspaces');
    await V(p, 'form[aria-label="Add workspace"]').waitFor({ timeout: 30000 });
    await V(p, '[aria-label="Workspace name"]').fill('Beta');
    await V(p, 'button:has-text("Tambah workspace")').click();
    await V(p, 'li[data-ws=Beta]').waitFor({ timeout: 10000 });
    await V(p, 'li[data-ws=Beta] button:has-text("Edit")').click();
    await V(p, '[aria-label="New name"]').fill('Gamma');
    await V(p, 'form[aria-label="Rename workspace"] button').click();
    await V(p, 'li[data-ws=Gamma]').waitFor({ timeout: 10000 });
    await V(p, 'li[data-ws=Gamma] button:has-text("Hapus")').click();
    await until('gone', async () => (await V(p, 'li[data-ws=Gamma]').count()) === 0);
  });

  await step('A3 users: create a user, it appears with its role, then it can log in; delete', async () => {
    await page(p, 'users');
    await V(p, '[data-testid=user-table]').waitFor({ timeout: 30000 });
    await V(p, 'button:has-text("Tambah user")').click();
    const f = V(p, 'form[aria-label="User form"]');
    await f.locator('[aria-label=Email]').fill('new@x.test');
    await f.locator('[aria-label=Nama]').fill('New Person');
    await f.locator('[aria-label=Role]').selectOption('qa_internal');
    await f.locator('label:has-text("Alpha") input').check();
    await f.locator('[aria-label=Password]').fill('newpass12345');
    await f.locator('button:has-text("Simpan")').click();
    await V(p, 'tr[data-email="new@x.test"]').waitFor({ timeout: 15000 });
    const q = await open('newuser'), qp = q.pages()[0] || await q.newPage();
    await login(qp, 'new@x.test', 'newpass12345');
    await q.close();
    await V(p, 'tr[data-email="new@x.test"] button:has-text("Hapus")').click();
    await until('user gone', async () => (await V(p, 'tr[data-email="new@x.test"]').count()) === 0);
  });

  await step('A4 roles: grant a permission to QA Vendor, save; it shows after a reload', async () => {
    await page(p, 'roles');
    await V(p, '[data-testid=role-matrix]').waitFor({ timeout: 30000 });
    const box = V(p, '[aria-label="qa_vendor dashboard"]');
    const before = await box.isChecked();
    if (before) throw new Error('precondition: vendor should not have dashboard');
    await box.check();
    await V(p, 'button:has-text("Simpan")').click();
    await V(p, '[data-testid=roles-saved]').waitFor({ timeout: 10000 });
    await page(p, 'roles');
    await V(p, '[data-testid=role-matrix]').waitFor({ timeout: 30000 });
    await until('persisted', async () => await V(p, '[aria-label="qa_vendor dashboard"]').isChecked());
  });

  await step('A3/A4/A5 a QA role is refused the admin screens', async () => {
    const q = await open('qa'), qp = q.pages()[0] || await q.newPage();
    qp.on('pageerror', (e) => errors.push(String(e)));
    await login(qp, 'qa@x.test', 'qapass1234');
    for (const slug of ['users', 'roles', 'workspaces', 'master/status']) {
      await page(qp, slug);
      await V(qp, '[data-testid=no-access]').waitFor({ timeout: 20000 });
    }
    await q.close();
  });

  check('no uncaught page errors', errors.length === 0, errors.slice(0, 2));
  await ad.close();
  const failed = results.filter((x) => !x).length;
  console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('crash', e); process.exit(2); });
