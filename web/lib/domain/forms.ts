// Ported verbatim from qa-app/js/utils.js; behavior unchanged. Typed loosely at the edges.
export const BUG_FORM = {
  PLATFORMS: ['Web', 'Mobile App', 'Desktop', 'API'],
  ENVIRONMENTS: ['Local', 'Development', 'Staging', 'UAT', 'Production'],
  PRIORITIES: ['Urgent', 'High', 'Medium', 'Low'],
  // Browser only matters on Web, Device only on Mobile App.
  conditionalFields(platform?: string){ return { browser: platform === 'Web', device: platform === 'Mobile App' }; },
  /* d: form values as plain text. full = create (every required field);
     edit keeps the old minimum so legacy bugs can still be saved.
     Returns { fieldName: message } — empty when valid. */
  errors(d: Record<string, unknown>, full = true){
    const e: Record<string, string> = {};
    const len = (v: unknown) => String(v || '').trim().length;
    const title = len(d.title);
    if (title < 5 || title > 150) e.title = 'Bug Title wajib diisi, 5–150 karakter.';
    if (len(d.actualResult) < 5) e.actualResult = 'Actual Result wajib diisi, minimal 5 karakter.';
    if (len(d.description) > 2000) e.description = 'Maksimal 2000 karakter.';
    const bad = String(d.attachments || '').split('\n').map(s => s.trim()).filter(Boolean).find((l: string) => {
      try{ return !/^https?:$/.test(new URL(l).protocol); }catch{ return true; }
    });
    if (bad) e.attachments = `Bukan URL http/https yang valid: ${bad.slice(0, 80)}`;
    if (!full) return e;
    if (!len(d.module)) e.module = 'Module wajib diisi.';
    if (len(d.steps) < 10) e.steps = 'Steps to Reproduce wajib diisi, minimal 10 karakter.';
    if (len(d.expectedResult) < 5) e.expectedResult = 'Expected Result wajib diisi, minimal 5 karakter.';
    if (!len(d.severity)) e.severity = 'Pilih Severity.';
    // Environment section (environment, build, platform, OS, browser, device) is optional.
    return e;
  },
  /* Open bugs whose title looks like `title`: word overlap ≥ 60% of the shorter
     title (words of 3+ letters), or one title contains the other. */
  similar<B extends { title?: string; status?: string }>(title: string, bugs: B[], closedStatuses: string[] = ['CLOSED']): B[]{
    const words = (s: unknown) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((w: string) => w.length >= 3));
    const norm = (s: unknown) => String(s || '').trim().toLowerCase();
    const t = norm(title), tw = words(title);
    if (t.length < 5) return [];
    return bugs.filter(b => !closedStatuses.includes(b.status as string)).filter(b => {
      const o = norm(b.title);
      if (!o) return false;
      if (o.includes(t) || t.includes(o)) return true;
      const ow = words(b.title), min = Math.min(tw.size, ow.size);
      return min > 0 && [...tw].filter(w => ow.has(w)).length / min >= 0.6;
    });
  }
};

export const TC_IMPORT = {
  ALIASES: <Record<string, string[]>>{
    module: ['module', 'modul', 'fitur', 'feature', 'menu'],
    roleUser: ['roleuser', 'role', 'userrole', 'aktor', 'actor'],
    scenario: ['scenario', 'skenario', 'testscenario', 'scenarioname', 'judul', 'title'],
    testCase: ['testcase', 'testcasename', 'testcasedescription', 'deskripsi', 'description', 'kasusuji'],
    preconditions: ['prekondisi', 'precondition', 'preconditions', 'prasyarat', 'kondisiawal'],
    steps: ['teststep', 'teststeps', 'step', 'steps', 'langkah', 'langkahlangkah', 'langkahpengujian'],
    testData: ['testdata', 'data', 'datauji'],
    expectedResult: ['expectedresult', 'expectedresults', 'expected', 'hasilyangdiharapkan', 'hasildiharapkan', 'ekspektasi'],
    typeTest: ['typetest', 'testtype', 'type', 'tipe', 'tipetest', 'jenistest'],
    evidence: ['evidence', 'bukti'],
    status: ['status', 'statustest', 'statuseksekusi'],
    actualResult: ['actualresult', 'actual', 'hasilaktual'],
    // Known columns that are never imported (ids are renumbered, date set on Run).
    _skip: ['testcaseid', 'id', 'no', 'executiondate']
  },
  field(header: unknown): string | null{
    const n = String(header).toLowerCase().replace(/[^a-z0-9]/g, '');
    return Object.keys(this.ALIASES).find(k => this.ALIASES[k].includes(n)) || null;
  },
  /* rawRows: XLSX sheet_to_json(..., { defval: '' }) output. Returns
     { rows: [test case fields], errors: ['Sheet "x" baris n: ...'], unknown: [header] }. */
  parseSheet(sheetName: string, rawRows: Record<string, unknown>[], sheetModule: string, typeTests: string[], statuses: string[] = []){
    const headers = rawRows.length ? Object.keys(rawRows[0]) : [];
    const map: Record<string, string> = {}, unknown: string[] = [], errors: string[] = [], rows: Record<string, string>[] = [];
    headers.forEach(h => {
      const f = this.field(h);
      if (!f){ if (!/^__EMPTY/.test(h)) unknown.push(h); }
      else if (f !== '_skip' && !map[f]) map[f] = h;
    });
    if (!rawRows.length) return { rows, errors, unknown };
    // Bug Report template (has "Bug Title *") shares Module / Scenario columns — refuse it outright.
    if (headers.some(h => /^bugtitle$/.test(String(h).toLowerCase().replace(/[^a-z0-9]/g, '')))){
      errors.push(`${sheetName}: ini template Bug Report, bukan Test Case`);
      return { rows, errors, unknown };
    }
    if (!map.scenario){
      errors.push(`${sheetName}: kolom Scenario tidak ada`);
      return { rows, errors, unknown };
    }
    const byProblem: Record<string, number[]> = {}; // problem -> sheet rows, so one line per problem
    rawRows.forEach((raw, i) => {
      if (!Object.values(raw).some(v => String(v).trim())) return; // blank row
      const tc: Record<string, string> = {};
      Object.keys(map).forEach(k => { tc[k] = String(raw[map[k]] ?? '').trim(); });
      tc.module = tc.module || sheetModule;
      const problems = [];
      if (!tc.module) problems.push('Module kosong');
      if (!tc.scenario) problems.push('Scenario kosong');
      if (tc.typeTest){
        const t = typeTests.find(x => x.toLowerCase() === tc.typeTest.toLowerCase());
        if (t) tc.typeTest = t; else problems.push(`Type Test harus ${typeTests.join('/')}`);
      }
      if (tc.status){
        const v = tc.status.toLowerCase() === 'not run' ? 'open' : tc.status.toLowerCase(); // old exports
        const st = statuses.find(x => x.toLowerCase() === v);
        if (st) tc.status = st; else problems.push(`Status harus ${statuses.join('/')}`);
      }
      // __rowNum__ is SheetJS's 0-based sheet row (survives skipped blank rows).
      problems.forEach(p => (byProblem[p] = byProblem[p] || []).push(((raw.__rowNum__ as number | undefined) ?? i + 1) + 1));
      if (!problems.length) rows.push(tc);
    });
    Object.entries(byProblem).forEach(([p, nums]) => {
      errors.push(`${sheetName} baris ${nums.slice(0, 5).join(', ')}${nums.length > 5 ? ` (+${nums.length - 5})` : ''}: ${p}`);
    });
    return { rows, errors, unknown };
  }
};
