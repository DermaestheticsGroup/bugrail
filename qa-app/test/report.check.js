// Run: node qa-app/test/report.check.js
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/report.js'), 'utf8') + '\nthis.ReportCalc = ReportCalc;', ctx);
const R = ctx.ReportCalc;

const tcs = (passed, other = {}) => [
  ...Array(passed).fill({ status: 'Passed' }),
  ...Object.entries(other).flatMap(([status, n]) => Array(n).fill({ status }))
];
const bug = (severity, status, extra = {}) => ({ id: 'B', title: 't', severity, status, ...extra });

// Go-live verdicts
assert.strictEqual(R.goLive([], []).verdict, 'EMPTY', 'no test cases = waiting for data, never NO GO');
assert.strictEqual(R.goLive([], [bug('Critical', 'Open')]).verdict, 'EMPTY', 'bugs alone still = waiting for data');
assert.strictEqual(R.goLive(tcs(100), [bug('Critical', 'Closed'), bug('High', 'Rejected')]).verdict, 'GO');
assert.strictEqual(R.goLive(tcs(100), [bug('High', 'Resolved')]).verdict, 'CONDITIONAL', 'Resolved still counts as open');
assert.strictEqual(R.goLive(tcs(92, { Failed: 8 }), [bug('High', 'Open'), bug('High', 'Open')]).verdict, 'CONDITIONAL');
assert.strictEqual(R.goLive(tcs(92, { Failed: 8 }), [bug('High', 'Open'), bug('High', 'Open'), bug('High', 'Open')]).verdict, 'NO_GO', '3 High open');
assert.strictEqual(R.goLive(tcs(100), [bug('Critical', 'In Progress')]).verdict, 'NO_GO', 'Critical open');
assert.strictEqual(R.goLive(tcs(89, { Failed: 11 }), []).verdict, 'NO_GO', 'pass rate < 90');
assert.strictEqual(R.goLive(tcs(99, { Open: 1 }), []).verdict, 'CONDITIONAL', 'not-run blocks GO only');

// Per module: app verdict = worst module
const mod = (m, list) => list.map(x => ({ ...x, module: m }));
const two = R.goLive([...mod('A', tcs(100)), ...mod('B', tcs(80, { Failed: 20 }))], []);
assert.strictEqual(JSON.stringify(two.modules.map(m => [m.module, m.verdict])), JSON.stringify([['B', 'NO_GO'], ['A', 'GO']]), 'riskiest module first');
assert.strictEqual(two.verdict, 'NO_GO', 'one NO GO module = app NO GO');
assert.strictEqual(two.passRate, 90, 'totals still across all modules');
assert.strictEqual(R.goLive([...mod('A', tcs(100)), ...mod('B', tcs(100))], mod('B', [bug('High', 'Open')])).verdict, 'CONDITIONAL');
const partial = R.goLive(mod('A', tcs(100)), mod('C', [bug('Low', 'Closed')]));
assert.strictEqual(partial.verdict, 'INCOMPLETE', 'module with bugs but no test case = report incomplete');
assert.strictEqual(partial.provisional, 'GO', 'provisional verdict from rated modules only');
assert.strictEqual(partial.modules[0].module, 'C', 'unrated module listed first');
assert.strictEqual(partial.modules[0].verdict, 'UNRATED');
assert.strictEqual(partial.counts.UNRATED, 1);

// Pass rate = passed / executed; no executed test = no rate ("—"), not 0
const pr = R.evaluate(tcs(45, { Failed: 5, Open: 50 }), []);
assert.strictEqual(pr.executed, 50);
assert.strictEqual(pr.passRate, 90, 'not-run tests are excluded from pass rate');
assert.strictEqual(R.evaluate(tcs(0, { Open: 3 }), []).passRate, null);
assert.strictEqual(R.evaluate([], []).verdict, 'UNRATED');

// Reason sentence: fixed priority order, GO has its own sentence
const why = R.evaluate(tcs(80, { Failed: 10, Blocked: 2, Open: 3 }), [bug('High', 'Open'), bug('Critical', 'Open')]);
assert.strictEqual(why.reason, 'Tertahan karena 1 bug Critical terbuka, pass rate 87% (target 95%), 2 test Blocked, 1 bug High terbuka, 3 test belum jalan.');
assert.strictEqual(R.evaluate(tcs(10), []).reason, 'Semua kriteria GO terpenuhi.');

// Riskiest first: NO GO -> CONDITIONAL -> GO, then lowest pass rate
const order = R.goLive([...mod('Go', tcs(100)), ...mod('Cond', tcs(99, { Open: 1 })), ...mod('No1', tcs(85, { Failed: 15 })), ...mod('No2', tcs(80, { Failed: 20 }))], []);
assert.strictEqual(JSON.stringify(order.modules.map(m => m.module)), JSON.stringify(['No2', 'No1', 'Cond', 'Go']));

// Must-fix list comes from the worst modules, capped
const fix = R.mustFix(R.goLive(mod('Pay', tcs(85, { Failed: 13, Blocked: 2 })), mod('Pay', [bug('Critical', 'Open', { code: 'BUG-112', title: 'Total salah' })])), b => b.code);
assert.strictEqual(fix.items[0], 'Tutup BUG-112 (Critical) — Total salah');
assert.ok(fix.items.some(x => x.includes('2 test Blocked di Pay')));
assert.ok(fix.items.some(x => x.includes('Naikkan pass rate Pay dari 85% ke ≥ 90%')));

// Contextual filter options: combos without test cases are disabled
const files = [{ id: 'f1', name: 'Sprint 1' }, { id: 'f2', name: 'Sprint 2' }];
const scoped = [{ status: 'Passed', module: 'Login', fileId: 'f1' }, { status: 'Passed', module: 'Pay', fileId: 'f2' }];
const opt = R.scopeOptions(scoped, [{ module: 'Report', fileId: 'f1', status: 'Open' }], files, { fileId: 'f1', module: '' });
const byName = n => opt.modules.find(m => m.name === n);
assert.strictEqual(byName('Login').disabled, false);
assert.strictEqual(byName('Login').count, 1);
assert.strictEqual(byName('Pay').disabled, true, 'module not in the chosen round');
assert.strictEqual(byName('Report').disabled, true, 'module with bugs only has no test case');
const opt2 = R.scopeOptions(scoped, [], files, { fileId: '', module: 'Pay' });
assert.strictEqual(opt2.rounds.find(r => r.id === 'f1').disabled, true, 'round without the chosen module');
assert.strictEqual(opt2.rounds.find(r => r.id === 'f2').count, 1);

// Reopen ranking
const reo = R.reopenStats([
  bug('Low', 'Open', { id: 'A', module: 'Login', activity: [{ to: 'Reopened', note: 'x' }] }),
  bug('Low', 'Open', { id: 'B', module: 'Login', activity: [{ to: 'Retest' }, { to: 'Reopened', note: 'last' }, { to: 'Closed' }] }),
  bug('Low', 'Open', { id: 'C', module: 'Pay', activity: [{ to: 'Closed' }] })
]);
assert.strictEqual(JSON.stringify(reo.rows.map(r => [r.bug.id, r.count])), JSON.stringify([['B', 2], ['A', 1]]));
assert.strictEqual(reo.rows[0].lastNote, 'last');
assert.strictEqual(reo.totalReopens, 3);
assert.strictEqual(reo.byModule[0].module, 'Login');

// Speed vs SLA
const day = 864e5, t0 = Date.parse('2026-01-01T00:00:00Z');
const at = d => new Date(t0 + d * day).toISOString();
const sp = R.speedStats([
  bug('Critical', 'Closed', { reportDate: at(0), activity: [{ to: 'Closed', at: at(0.5) }] }), // on time
  bug('High', 'Closed', { reportDate: at(0), activity: [{ to: 'Closed', at: at(5) }] }),       // late (SLA 3)
  bug('Low', 'Closed', { reportDate: at(0) }),                                                   // unmeasured
  bug('Medium', 'Open', { reportDate: at(0) }),                                                  // overdue at day 10
  bug('Low', 'Open', { reportDate: at(0) })                                                      // within 14d
], t0 + 10 * day);
assert.strictEqual(sp.measured, 2);
assert.strictEqual(sp.unmeasured, 1);
assert.strictEqual(sp.onTimePct, 50);
assert.strictEqual(sp.verdict, 'WATCH');
assert.strictEqual(sp.overdueOpen.length, 1);
assert.strictEqual(R.speedStats([]).verdict, 'NA');

// Business summary always gives a verdict + at least one next step
const biz = R.businessSummary(R.goLive([], []), R.reopenStats([]), R.speedStats([]));
assert.ok(biz.verdictText.includes('BELUM BISA DINILAI'), 'empty data is not "not ready"');
assert.ok(biz.nextSteps.length >= 1);
const bizPartial = R.businessSummary(partial, R.reopenStats([]), R.speedStats([]));
assert.ok(bizPartial.verdictText.includes('BELUM LENGKAP'));
assert.ok(bizPartial.points.some(p => p.includes('C')), 'unrated module named');

console.log('report.check.js: all checks passed');
