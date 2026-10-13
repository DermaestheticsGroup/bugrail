import { test } from 'bun:test';
import assert from 'node:assert';
import { ReportCalc } from '../lib/domain/report';

test('ReportCalc: go-live verdicts, per-module, reasons, filters, reopen, speed, summary', () => {
  const tcs = (passed: number, other: Record<string, number> = {}) => [
    ...Array(passed).fill({ status: 'Passed' }),
    ...Object.entries(other).flatMap(([status, n]) => Array(n).fill({ status }))
  ];
  const bug = (severity: string, status: string, extra: Record<string, unknown> = {}) => ({ id: 'B', title: 't', severity, status, ...extra });

  // Go-live verdicts
  assert.strictEqual(ReportCalc.goLive([], []).verdict, 'EMPTY', 'no test cases = waiting for data, never NO GO');
  assert.strictEqual(ReportCalc.goLive([], [bug('Critical', 'OPEN')]).verdict, 'EMPTY', 'bugs alone still = waiting for data');
  assert.strictEqual(ReportCalc.goLive(tcs(100), [bug('Critical', 'CLOSED'), bug('High', 'REJECTED')]).verdict, 'GO');
  assert.strictEqual(ReportCalc.goLive(tcs(100), [bug('High', 'RESOLVED')]).verdict, 'CONDITIONAL', 'Resolved still counts as open');
  assert.strictEqual(ReportCalc.goLive(tcs(92, { Failed: 8 }), [bug('High', 'OPEN'), bug('High', 'OPEN')]).verdict, 'CONDITIONAL');
  assert.strictEqual(ReportCalc.goLive(tcs(92, { Failed: 8 }), [bug('High', 'OPEN'), bug('High', 'OPEN'), bug('High', 'OPEN')]).verdict, 'NO_GO', '3 High open');
  assert.strictEqual(ReportCalc.goLive(tcs(100), [bug('Critical', 'IN_PROGRESS')]).verdict, 'NO_GO', 'Critical open');
  assert.strictEqual(ReportCalc.goLive(tcs(89, { Failed: 11 }), []).verdict, 'NO_GO', 'pass rate < 90');
  assert.strictEqual(ReportCalc.goLive(tcs(99, { Open: 1 }), []).verdict, 'CONDITIONAL', 'not-run blocks GO only');

  // Per module: app verdict = worst module
  const mod = (m: string, list: object[]) => list.map(x => ({ ...x, module: m }));
  const two = ReportCalc.goLive([...mod('A', tcs(100)), ...mod('B', tcs(80, { Failed: 20 }))], []);
  assert.strictEqual(JSON.stringify(two.modules.map(m => [m.module, m.verdict])), JSON.stringify([['B', 'NO_GO'], ['A', 'GO']]), 'riskiest module first');
  assert.strictEqual(two.verdict, 'NO_GO', 'one NO GO module = app NO GO');
  assert.strictEqual(two.passRate, 90, 'totals still across all modules');
  assert.strictEqual(ReportCalc.goLive([...mod('A', tcs(100)), ...mod('B', tcs(100))], mod('B', [bug('High', 'OPEN')])).verdict, 'CONDITIONAL');
  const partial = ReportCalc.goLive(mod('A', tcs(100)), mod('C', [bug('Low', 'CLOSED')]));
  assert.strictEqual(partial.verdict, 'INCOMPLETE', 'module with bugs but no test case = report incomplete');
  assert.strictEqual(partial.provisional, 'GO', 'provisional verdict from rated modules only');
  assert.strictEqual(partial.modules[0].module, 'C', 'unrated module listed first');
  assert.strictEqual(partial.modules[0].verdict, 'UNRATED');
  assert.strictEqual(partial.counts.UNRATED, 1);

  // Pass rate = passed / executed; no executed test = no rate ("—"), not 0
  const pr = ReportCalc.evaluate(tcs(45, { Failed: 5, Open: 50 }), []);
  assert.strictEqual(pr.executed, 50);
  assert.strictEqual(pr.passRate, 90, 'not-run tests are excluded from pass rate');
  assert.strictEqual(ReportCalc.evaluate(tcs(0, { Open: 3 }), []).passRate, null);
  assert.strictEqual(ReportCalc.evaluate([], []).verdict, 'UNRATED');

  // Reason sentence: fixed priority order, GO has its own sentence
  const why = ReportCalc.evaluate(tcs(80, { Failed: 10, Blocked: 2, Open: 3 }), [bug('High', 'OPEN'), bug('Critical', 'OPEN')]);
  assert.strictEqual(why.reason, 'Tertahan karena 1 bug Critical terbuka, pass rate 87% (target 95%), 2 test Blocked, 1 bug High terbuka, 3 test belum jalan.');
  assert.strictEqual(ReportCalc.evaluate(tcs(10), []).reason, 'Semua kriteria GO terpenuhi.');

  // Riskiest first: NO GO -> CONDITIONAL -> GO, then lowest pass rate
  const order = ReportCalc.goLive([...mod('Go', tcs(100)), ...mod('Cond', tcs(99, { Open: 1 })), ...mod('No1', tcs(85, { Failed: 15 })), ...mod('No2', tcs(80, { Failed: 20 }))], []);
  assert.strictEqual(JSON.stringify(order.modules.map(m => m.module)), JSON.stringify(['No2', 'No1', 'Cond', 'Go']));

  // Must-fix list comes from the worst modules, capped
  const fix = ReportCalc.mustFix(ReportCalc.goLive(mod('Pay', tcs(85, { Failed: 13, Blocked: 2 })), mod('Pay', [bug('Critical', 'OPEN', { code: 'BUG-112', title: 'Total salah' })])), b => b.code);
  assert.strictEqual(fix.items[0], 'Tutup BUG-112 (Critical) — Total salah');
  assert.ok(fix.items.some(x => x.includes('2 test Blocked di Pay')));
  assert.ok(fix.items.some(x => x.includes('Naikkan pass rate Pay dari 85% ke ≥ 90%')));

  // Contextual filter options: combos without test cases are disabled
  const files = [{ id: 'f1', name: 'Sprint 1' }, { id: 'f2', name: 'Sprint 2' }];
  const scoped = [{ status: 'Passed', module: 'Login', fileId: 'f1' }, { status: 'Passed', module: 'Pay', fileId: 'f2' }];
  const opt = ReportCalc.scopeOptions(scoped, [{ module: 'Report', fileId: 'f1', status: 'OPEN' }], files, { fileId: 'f1', module: '' });
  const byName = (n: string) => opt.modules.find(m => m.name === n);
  assert.strictEqual(byName('Login')!.disabled, false);
  assert.strictEqual(byName('Login')!.count, 1);
  assert.strictEqual(byName('Pay')!.disabled, true, 'module not in the chosen round');
  assert.strictEqual(byName('Report')!.disabled, true, 'module with bugs only has no test case');
  const opt2 = ReportCalc.scopeOptions(scoped, [], files, { fileId: '', module: 'Pay' });
  assert.strictEqual(opt2.rounds.find(r => r.id === 'f1')!.disabled, true, 'round without the chosen module');
  assert.strictEqual(opt2.rounds.find(r => r.id === 'f2')!.count, 1);

  // Reopen ranking
  const reo = ReportCalc.reopenStats([
    bug('Low', 'OPEN', { id: 'A', module: 'Login', activity: [{ to: 'REOPENED', note: 'x' }] }),
    bug('Low', 'OPEN', { id: 'B', module: 'Login', activity: [{ to: 'RETEST' }, { to: 'REOPENED', note: 'last' }, { to: 'CLOSED' }] }),
    bug('Low', 'OPEN', { id: 'C', module: 'Pay', activity: [{ to: 'CLOSED' }] })
  ]);
  assert.strictEqual(JSON.stringify(reo.rows.map(r => [r.bug.id, r.count])), JSON.stringify([['B', 2], ['A', 1]]));
  assert.strictEqual(reo.rows[0].lastNote, 'last');
  assert.strictEqual(reo.totalReopens, 3);
  assert.strictEqual(reo.byModule[0].module, 'Login');

  // Speed vs SLA
  const day = 864e5, t0 = Date.parse('2026-01-01T00:00:00Z');
  const at = (d: number) => new Date(t0 + d * day).toISOString();
  const sp = ReportCalc.speedStats([
    bug('Critical', 'CLOSED', { reportDate: at(0), activity: [{ to: 'CLOSED', at: at(0.5) }] }), // on time
    bug('High', 'CLOSED', { reportDate: at(0), activity: [{ to: 'CLOSED', at: at(5) }] }),       // late (SLA 3)
    bug('Low', 'CLOSED', { reportDate: at(0) }),                                                   // unmeasured
    bug('Medium', 'OPEN', { reportDate: at(0) }),                                                  // overdue at day 10
    bug('Low', 'OPEN', { reportDate: at(0) })                                                      // within 14d
  ], t0 + 10 * day);
  assert.strictEqual(sp.measured, 2);
  assert.strictEqual(sp.unmeasured, 1);
  assert.strictEqual(sp.onTimePct, 50);
  assert.strictEqual(sp.verdict, 'WATCH');
  assert.strictEqual(sp.overdueOpen.length, 1);
  assert.strictEqual(ReportCalc.speedStats([]).verdict, 'NA');

  // Business summary always gives a verdict + at least one next step
  const biz = ReportCalc.businessSummary(ReportCalc.goLive([], []), ReportCalc.reopenStats([]), ReportCalc.speedStats([]));
  assert.ok(biz.verdictText.includes('BELUM BISA DINILAI'), 'empty data is not "not ready"');
  assert.ok(biz.nextSteps.length >= 1);
  const bizPartial = ReportCalc.businessSummary(partial, ReportCalc.reopenStats([]), ReportCalc.speedStats([]));
  assert.ok(bizPartial.verdictText.includes('BELUM LENGKAP'));
  assert.ok(bizPartial.points.some(p => p.includes('C')), 'unrated module named');

});
