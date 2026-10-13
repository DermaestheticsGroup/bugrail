// Legacy priority values (form used "Critical", dashboard "Highest") read as the current top level.
export const normPriority = (p: string): string => (p === 'Highest' || p === 'Critical' ? 'Urgent' : p);

/* Bug status rules, by status code (Master Status). Dev flow OPEN / IN_PROGRESS /
   RETEST moves freely without a note. QA (permission bugreport_statusQA) may only
   take a bug out of RETEST, to OPEN/BLOCKED/RESOLVED/CLOSED, always with a note.
   Any other move needs a note. */
export function statusTransitionRule(from: string, to: string, isQA: boolean): { ok: boolean; needNote: boolean } {
  const DEV_FLOW = ['OPEN', 'IN_PROGRESS', 'RETEST'];
  const QA_TARGETS = ['OPEN', 'BLOCKED', 'RESOLVED', 'CLOSED'];
  if (isQA) return { ok: from === 'RETEST' && QA_TARGETS.includes(to), needNote: true };
  return { ok: true, needNote: !(DEV_FLOW.includes(from) && DEV_FLOW.includes(to)) };
}

type ResolvedBug = { status?: string; reportDate?: string; activity?: { to?: string; at: string }[] };

/* Dev team metric: hours from reported to CLOSED, from the status-change log. Only
   CLOSED bugs with a logged "-> CLOSED" move count; bugs without activity are skipped. */
export function computeBugResolutionStats(bugs?: ResolvedBug[] | null): { resolvedCount: number; avgHours: number } {
  const durations: number[] = [];
  (bugs || []).forEach(b => {
    if (b.status !== 'CLOSED' || !b.reportDate) return;
    const closed = (b.activity || []).filter(a => a.to === 'CLOSED');
    if (!closed.length) return;
    const ms = new Date(closed[closed.length - 1].at).getTime() - new Date(b.reportDate).getTime();
    if (ms > 0) durations.push(ms);
  });
  const avgHours = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length / 3600000 : 0;
  return { resolvedCount: durations.length, avgHours };
}
