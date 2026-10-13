import { expect, test } from 'bun:test';
import { nextInScope } from '../lib/id-gen';

test('empty scope starts at 0001', () => expect(nextInScope('BUG', [])).toBe('BUG-0001'));
test('highest in use + 1, gaps stay', () => expect(nextInScope('BUG', ['BUG-0001', 'BUG-0007', 'BUG-0003'])).toBe('BUG-0008'));
test('other prefixes and junk are ignored', () => expect(nextInScope('BUG', ['LOG-0042', 'BUG-x', null, 'BUG-0002'])).toBe('BUG-0003'));
test('grows past 4 digits', () => expect(nextInScope('BUG', ['BUG-9999'])).toBe('BUG-10000'));

import { nextInScope as nextLiteral } from '../lib/id-gen';
import { test as t2, expect as e2 } from 'bun:test';
t2('server nextInScope matches regex metacharacters in the prefix literally', () => {
  e2(nextLiteral('C++', ['C++-0004', 'CCC-0009'])).toBe('C++-0005');
  e2(nextLiteral('A.B', ['A.B-0001', 'AXB-0007'])).toBe('A.B-0002');
});
