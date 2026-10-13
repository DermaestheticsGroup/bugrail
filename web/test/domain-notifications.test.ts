import { test } from 'bun:test';
import assert from 'node:assert';
import { NotifCalc } from '../lib/domain/notifications';

test('NotifCalc: bug events, involvement, permissions, test case reminders', () => {
  const texts = (r: { events: Record<string, unknown>[] }) => r.events.map(e => e.text as string);

  const bugs = [{
    id: 'BUG-1', title: 'Gagal bayar', tester: 'qa@x.com', assignee: 'dev@x.com', fileId: 'F1',
    reportDate: '2026-01-01T00:00:00Z',
    assignments: [{ at: '2026-01-01T00:00:10Z', to: 'dev@x.com', by: 'qa@x.com' }],
    activity: [
      { at: '2026-01-02T00:00:00Z', from: 'OPEN', to: 'IN_PROGRESS', email: 'dev@x.com', note: 'mulai' },
      { at: '2026-01-03T00:00:00Z', from: 'IN_PROGRESS', to: 'CLOSED', email: 'dev@x.com', note: 'fixed' }
    ]
  }, {
    id: 'BUG-2', title: 'Orang lain', tester: 'other@x.com', assignee: 'other2@x.com',
    activity: [{ at: '2026-01-02T00:00:00Z', from: 'OPEN', to: 'CLOSED', email: 'other2@x.com' }]
  }];

  // Creator gets the status changes made by others, never BUG-2 (not involved)
  const qa = NotifCalc.build({ bugs, me: 'QA@x.com' });
  assert.strictEqual(qa.events.length, 2);
  assert.ok(texts(qa)[0].includes('CLOSED (diperbaiki)'), 'newest first + fixed label');
  assert.strictEqual(qa.events[0].target.fileId, 'F1');

  // Assignee gets "new bug assigned", but not their own status changes
  const dev = NotifCalc.build({ bugs, me: 'dev@x.com' });
  assert.strictEqual(dev.events.length, 1);
  assert.ok(texts(dev)[0].startsWith('Bug baru BUG-1 dibuat & di-assign ke Anda'));

  // Uninvolved user: nothing; no user: nothing
  assert.strictEqual(NotifCalc.build({ bugs, me: 'nobody@x.com' }).events.length, 0);
  assert.strictEqual(NotifCalc.build({ bugs, me: '' }).events.length, 0);
  assert.strictEqual(NotifCalc.build({ bugs, me: 'qa@x.com', canBug: false }).events.length, 0, 'respects bugreport_read');

  // Test cases: per-file reminder for the creator/uploader only
  const testcases = [
    { id: 'TC-1', status: 'Open', createdBy: 'dev@x.com', fileId: 'F1' },
    { id: 'TC-2', status: 'Open', createdBy: 'DEV@x.com', fileId: 'F1' },
    { id: 'TC-3', status: 'Open', createdBy: 'dev@x.com', fileId: 'F2' },
    { id: 'TC-4', status: 'Passed', createdBy: 'dev@x.com', fileId: 'F1' },  // already run: no reminder
    { id: 'TC-5', status: 'Open', createdBy: 'qa@x.com', fileId: 'F1' }       // someone else's
  ];
  const devTc = NotifCalc.build({ testcases, me: 'dev@x.com' });
  assert.strictEqual(devTc.events.length, 0, 'no test case events, reminders only');
  assert.strictEqual(JSON.stringify(devTc.reminders), JSON.stringify([{ fileId: 'F1', count: 2 }, { fileId: 'F2', count: 1 }]));
  assert.strictEqual(NotifCalc.build({ testcases, me: 'qa@x.com' }).reminders.length, 1);
  assert.strictEqual(NotifCalc.build({ testcases, me: 'dev@x.com', canTc: false }).reminders.length, 0);

});
