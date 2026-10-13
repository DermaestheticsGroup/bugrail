import { expect, test } from 'bun:test';
import { nextInScope } from '../lib/id-gen';

test('empty scope starts at 0001', () => expect(nextInScope('BUG', [])).toBe('BUG-0001'));
test('highest in use + 1, gaps stay', () => expect(nextInScope('BUG', ['BUG-0001', 'BUG-0007', 'BUG-0003'])).toBe('BUG-0008'));
test('other prefixes and junk are ignored', () => expect(nextInScope('BUG', ['LOG-0042', 'BUG-x', null, 'BUG-0002'])).toBe('BUG-0003'));
test('grows past 4 digits', () => expect(nextInScope('BUG', ['BUG-9999'])).toBe('BUG-10000'));
