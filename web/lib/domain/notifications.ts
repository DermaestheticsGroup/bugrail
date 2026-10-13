// Ported from qa-app/js/notifications.js (NotifCalc only). Bug statuses are codes; test case status 'Open' keeps its name.
// Rows come from the DB layer as loose records until Phase 3 types them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = Record<string, any>;

export const NotifCalc = {
  LIMIT: 50,
  FIXED: ['RESOLVED', 'CLOSED'],
  REOPENED: ['REOPENED', 'RETEST'],

  build({ bugs = [], testcases = [], me, canBug = true, canTc = true }: { bugs?: Rec[]; testcases?: Rec[]; me?: string; canBug?: boolean; canTc?: boolean }){
    const norm = (e: unknown) => String(e || '').trim().toLowerCase();
    const meNorm = norm(me);
    const events: Rec[] = [];
    if (!meNorm) return { events, reminders: [] };

    if (canBug) bugs.forEach((b: Rec) => {
      const target = { type: 'bug', id: b.id, fileId: b.fileId };
      const code = b.code || b.id; // display number (see bugCode in utils.js)
      const title = b.title ? `: ${b.title}` : '';
      (b.assignments || []).forEach((a: Rec) => {
        if (norm(a.to) !== meNorm || norm(a.by) === meNorm) return;
        const isNew = b.reportDate && Math.abs(new Date(a.at).getTime() - new Date(b.reportDate).getTime()) < 60000;
        events.push({ at: a.at, icon: '🐞', target,
          text: isNew ? `Bug baru ${code} dibuat & di-assign ke Anda oleh ${a.by}${title}` : `${code} di-assign ke Anda oleh ${a.by}${title}` });
      });
      const involved = norm(b.tester) === meNorm || norm(b.assignee) === meNorm;
      if (!involved) return;
      (b.activity || []).forEach((a: Rec) => {
        if (norm(a.email) === meNorm) return;
        const icon = this.FIXED.includes(a.to) ? '✅' : this.REOPENED.includes(a.to) ? '🔁' : '🔄';
        const label = this.FIXED.includes(a.to) ? ' (diperbaiki)' : '';
        events.push({ at: a.at, icon, target, note: a.note || '',
          text: `${code}: ${a.from} → ${a.to}${label}${a.email ? ` oleh ${a.email}` : ''}${title}` });
      });
    });

    events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    // Reminder for whoever created / uploaded (imported) the test cases: one
    // line per file that still has Open (not run) test cases — not one per test case.
    const byFile = new Map<string, number>();
    if (canTc) testcases.forEach(t => {
      if (t.status !== 'Open') return;
      if (norm(t.createdBy) !== meNorm) return;
      const key = t.fileId || '';
      byFile.set(key, (byFile.get(key) || 0) + 1);
    });
    const reminders = [...byFile].map(([fileId, count]) => ({ fileId, count })).sort((a, b) => b.count - a.count);

    return { events: events.slice(0, this.LIMIT), reminders };
  }
};
