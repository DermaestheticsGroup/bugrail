import { describe, expect, test } from 'bun:test';
import { switchUser, type SwitchDeps } from '../lib/client/boot';

function deps(over: Partial<SwitchDeps> = {}) {
  const calls: string[] = [];
  const d: SwitchDeps = {
    previous: 'old',
    open: async () => { calls.push('open'); return {}; },
    outboxSize: async () => 0,
    close: async () => { calls.push('close'); },
    wipe: async () => { calls.push('wipe'); },
    confirm: () => true,
    alert: () => { calls.push('alert'); },
    remember: () => { calls.push('remember'); },
    ...over,
  };
  return { d, calls };
}

describe('switchUser', () => {
  test('closes the old database before wiping it, then remembers the new user', async () => {
    const { d, calls } = deps();
    expect(await switchUser('new', d)).toBe(true);
    expect(calls).toEqual(['open', 'close', 'wipe', 'remember']);
  });

  test('a failed wipe alerts and aborts without remembering the user', async () => {
    const { d, calls } = deps({ wipe: async () => { throw new Error('could not remove local data: x.db'); } });
    expect(await switchUser('new', d)).toBe(false);
    expect(calls).toContain('alert');
    expect(calls).not.toContain('remember');
  });

  test('declining the unsent-changes warning leaves everything in place', async () => {
    const { d, calls } = deps({ outboxSize: async () => 2, confirm: () => false });
    expect(await switchUser('new', d)).toBe(false);
    expect(calls).toEqual(['open']);
  });

  test('same user does not wipe', async () => {
    const { d, calls } = deps({ previous: 'new' });
    expect(await switchUser('new', d)).toBe(true);
    expect(calls).toEqual(['remember']);
  });
});
