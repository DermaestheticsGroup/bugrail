import { test } from 'bun:test';
import assert from 'node:assert';
import { BUG_FORM } from '../lib/domain/forms';
import { normPriority } from '../lib/domain/status';


test('bug form rules, similar bugs, priority normalisation', () => {
  const valid = {
    title: 'Login gagal dengan password valid', module: 'Login', steps: '1. Buka login 2. Klik', expectedResult: 'Masuk dashboard',
    actualResult: 'Error invalid', description: '', severity: 'High', attachments: 'https://prnt.sc/abc'
  };
  const keys = (o: object) => Object.keys(o).sort().join(',');

  assert.strictEqual(keys(BUG_FORM.errors(valid)), '', 'complete form is valid');
  assert.strictEqual(keys(BUG_FORM.errors({})), 'actualResult,expectedResult,module,severity,steps,title', 'Environment fields are optional');
  assert.strictEqual(keys(BUG_FORM.errors({}, false)), 'actualResult,title', 'edit keeps the old minimum');

  assert.ok(BUG_FORM.errors({ ...valid, title: 'abcd' }).title, 'title < 5');
  assert.ok(BUG_FORM.errors({ ...valid, title: 'x'.repeat(151) }).title, 'title > 150');
  assert.ok(!BUG_FORM.errors({ ...valid, title: '  abcde  ' }).title, 'title is trimmed');
  assert.ok(BUG_FORM.errors({ ...valid, steps: 'short' }).steps, 'steps < 10');
  assert.ok(BUG_FORM.errors({ ...valid, description: 'x'.repeat(2001) }).description, 'notes > 2000');

  // Conditional Browser / Device (shown, not required)
  assert.strictEqual(keys(BUG_FORM.errors({ ...valid, platform: 'Web', browser: '' })), '', 'Browser optional');
  assert.strictEqual(JSON.stringify(BUG_FORM.conditionalFields('Web')), '{"browser":true,"device":false}');
  assert.strictEqual(JSON.stringify(BUG_FORM.conditionalFields('Mobile App')), '{"browser":false,"device":true}');
  assert.strictEqual(JSON.stringify(BUG_FORM.conditionalFields('Desktop')), '{"browser":false,"device":false}');
  assert.strictEqual(JSON.stringify(BUG_FORM.conditionalFields('')), '{"browser":false,"device":false}');

  // Attachment links: each line an http(s) URL
  assert.ok(!BUG_FORM.errors({ ...valid, attachments: 'https://a.com/x\n\nhttp://b.id' }).attachments);
  assert.ok(BUG_FORM.errors({ ...valid, attachments: 'https://a.com\nprnt.sc/abc' }).attachments, 'missing scheme');
  assert.ok(BUG_FORM.errors({ ...valid, attachments: 'javascript:alert(1)' }).attachments, 'non-http scheme');

  // Similar open bugs by title
  const bugs = [
    { id: 1, title: 'Login gagal dengan password valid', status: 'OPEN' },
    { id: 2, title: 'Login gagal dengan password valid', status: 'CLOSED' },
    { id: 3, title: 'Tombol simpan tidak muncul', status: 'OPEN' },
    { id: 4, title: 'Gagal login walau password benar dan valid', status: 'RETEST' }
  ];
  assert.strictEqual(JSON.stringify(BUG_FORM.similar('login gagal password', bugs).map(b => b.id)), JSON.stringify([1, 4]), 'closed bugs skipped');
  assert.strictEqual(JSON.stringify(BUG_FORM.similar('abc', bugs).map(b => b.id)), JSON.stringify([]), 'min 5 chars');
  assert.strictEqual(JSON.stringify(BUG_FORM.similar('Export excel error', bugs).map(b => b.id)), JSON.stringify([]));

  assert.strictEqual(normPriority('Highest'), 'Urgent');
  assert.strictEqual(normPriority('Critical'), 'Urgent');
  assert.strictEqual(normPriority('High'), 'High');

});
