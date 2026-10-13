import type { KvBlobs, Rec } from '../../lib/migrate/kv';

// Seeded so a failure reproduces. Mirrors the legacy shapes, including the awkward ones: a status only the history knows,
// 'Not Run' test cases, 'Highest' priority, files with no workspace, orphan rows, duplicate codes, legacy single workspaceId,
// and fields the inventory never named.
export function legacyKv(seed = 1, bugCount = 60): KvBlobs {
  let s = seed;
  const rnd = (n: number) => { s = (s * 1664525 + 1013904223) % 4294967296; return s % n; };
  const pick = <T,>(a: T[]) => a[rnd(a.length)];
  const ts = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString();

  const files: Rec[] = [
    { id: 'FILE-A1', name: 'Alpha core', workspaceId: 'ws-a', createdBy: 'ann@x.test', createdAt: ts(1), sharedWith: ['ws-v'] },
    { id: 'FILE-V1', name: 'Vendor pass', workspaceId: 'ws-v', createdBy: 'vic@v.test', createdAt: ts(2) },
    { id: 'FILE-OLD', name: 'Pre-workspace file', createdAt: ts(3) }, // no workspaceId: visible to everyone today
  ];
  const testcases: Rec[] = [];
  for (let i = 1; i <= 25; i++) {
    testcases.push({
      id: `TC-${i}`, code: `LOG-${String(i).padStart(4, '0')}`, fileId: pick(['FILE-A1', 'FILE-V1', 'FILE-OLD']), module: 'Login',
      roleUser: 'User', scenario: `Scenario ${i}`, testCase: `Case ${i}`, preconditions: '', steps: `<ol><li>step ${i}</li></ol>`, testData: '',
      expectedResult: 'ok', typeTest: pick(['Positive', 'Negative']), status: pick(['Not Run', 'Passed', 'Failed', 'Blocked', 'Retest']),
      actualResult: i % 3 ? '' : 'broken', evidence: '', executionDate: i % 2 ? ts(i) : '', customFields: i % 4 ? {} : { Sprint: '12' },
      createdBy: 'ann@x.test', createdAt: ts(i), legacyFlag: i % 5 === 0 ? true : undefined,
    });
  }
  testcases.push({ id: 'TC-ORPHAN', code: '', module: 'Misc', scenario: 'no file', testCase: 'x', status: 'Open' });
  testcases.push({ id: 'TC-DUP', code: 'LOG-0001', fileId: 'FILE-A1', module: 'Login', scenario: 'dup code', testCase: 'x', status: 'Open' });
  testcases.push({ id: 'TC-DUP2', code: 'LOG-0001', fileId: 'FILE-A1', module: 'Login', scenario: 'dup code too', testCase: 'x', status: 'Open' });

  const statuses = ['Open', 'In Progress', 'Retest', 'Resolved', 'Closed', 'Rejected'];
  const bugs: Rec[] = [];
  for (let i = 1; i <= bugCount; i++) {
    const id = `BUG-${i}`;
    const status = pick(statuses);
    const activity: Rec[] = [];
    for (let k = 0; k < rnd(4); k++) activity.push({ at: ts(i * 10 + k), from: pick(statuses), to: k === 2 ? 'Reopened' : pick(statuses), note: `note ${k}`, attachment: '', email: 'ann@x.test' });
    bugs.push({
      id, code: i === 7 ? 'BUG-0003' : `BUG-${String(i).padStart(4, '0')}`, fileId: i === 2 ? undefined : i === 3 || i === 7 ? 'FILE-A1' : pick(['FILE-A1', 'FILE-V1', 'FILE-OLD']),
      testCaseId: `TC-${1 + rnd(25)}`, title: `Bug ${i} 🐞`, module: pick(['Login', 'Pay']), severity: pick(['Critical', 'High', 'Medium', 'Low']),
      priority: pick(['Highest', 'Critical', 'Urgent', 'High', 'Medium', 'Low']), status, description: `<p>desc ${i}</p>`, steps: `1. a\n2. b`,
      expectedResult: 'ok', actualResult: 'bad', platform: 'Web', environment: 'UAT', browser: 'Chrome 126', device: '', buildVersion: '1.2.3',
      attachments: i % 2 ? 'https://x/a.png\nhttps://x/b.png' : '', tester: 'ann@x.test', assignee: i % 3 ? 'bob@x.test' : '', reportDate: ts(i),
      os: 'Android 14', // not in the inventory: must land in extra and come back
      estimate: i % 6 === 0 ? 5 : undefined, // non-string in a field the inventory does not know
      activity,
      comments: i % 4 ? [{ at: ts(i * 10 + 5), email: 'bob@x.test', text: `comment ${i}` }] : [],
      assignments: i % 3 ? [{ at: ts(i * 10 + 6), to: 'bob@x.test', by: 'ann@x.test' }] : [],
    });
  }

  return {
    qa_files: files,
    qa_testcases: testcases,
    qa_bugs: bugs,
    qa_activity_log: Array.from({ length: 12 }, (_, i) => ({ id: `LOG-${i}`, ts: ts(i), actorEmail: 'ann@x.test', actorRole: 'qa_internal', workspaceId: 'ws-a', action: 'bug.create', label: `Bug ${i}` })),
    qa_counters: { bug: 99 },
    qa_settings: {
      users: [
        { email: 'Root@x.test', password: 'rootpw', role: 'admin', workspaceIds: [] },
        { email: 'ann@x.test', password: 'annpw-1', role: 'qa_internal', workspaceIds: ['ws-a'] },
        { email: 'bob@x.test', password: 'bobpw-2', role: 'pm_ba', workspaceId: 'ws-a' }, // legacy single workspaceId
        { email: 'vic@v.test', password: 'vicpw-3', role: 'qa_vendor', workspaceIds: ['ws-v'] },
        { email: 'old@x.test', password: 'oldpw-4', role: 'user', workspaceIds: [], lastSeen: 'yesterday' },
        { email: 'nopw@x.test', role: 'user_umum', workspaceIds: [] },
      ],
      workspaces: [{ id: 'ws-a', name: 'Alpha' }, { id: 'ws-v', name: 'Vendor' }],
      roles: [{ value: 'pm_ba', label: 'PM & BA' }, { value: 'qa_internal', label: 'QA Internal' }, { value: 'qa_vendor', label: 'QA Vendor' }, { value: 'user_umum', label: 'User Umum' }],
      rolePermissions: { qa_vendor: { bugreport_create: true } },
      customFieldDefs: [{ label: 'Sprint' }, { label: 'Squad' }],
      geminiApiKey: ' gem-key ',
      theme: 'dark',
    },
  };
}
