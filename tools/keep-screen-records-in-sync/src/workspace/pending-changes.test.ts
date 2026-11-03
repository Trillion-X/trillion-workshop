import { describe, expect, it } from '../../../../test-helpers/vitest-shim.mjs';
import { addPending, applyPending, hasPending, optimistic } from './pending-changes.ts';

describe('pending changes laid over a read', () => {
  it('apply in order to the named read only, until taken off', () => {
    const off = addPending<number[]>('rows', 'a', rows => [...rows, 1]);
    addPending<number[]>('rows', 'b', rows => rows.map(row => row * 10));
    expect(applyPending('rows', [5])).toEqual([50, 10]);
    expect(applyPending('other', [5])).toEqual([5]);
    off();
    expect(applyPending('rows', [5])).toEqual([50]);
  });

  it('the same key replaces the earlier change, and a change that throws is skipped', () => {
    addPending<number>('n', 'move', value => value + 1);
    addPending<number>('n', 'move', value => value + 100);
    addPending<number>('n', 'bad', () => { throw new Error('x'); });
    expect(applyPending('n', 0)).toBe(100);
  });

  it('stay over every read while the write is out and are gone when it ends, acknowledged or refused', async () => {
    let during = -1;
    await optimistic<number, void>('score', 'k', value => value + 1, async () => { during = applyPending('score', 1); });
    expect(during).toBe(2);
    expect(hasPending('score')).toBe(false);
    let refused = '';
    try { await optimistic<number, void>('score', 'k', value => value + 1, async () => { throw new Error('refused'); }); } catch (error) { refused = (error as Error).message; }
    expect(refused).toBe('refused');
    expect(applyPending('score', 1)).toBe(1);
  });

  it('sit in layers, lowest first whatever order they were added, and one the store already shows is dropped', () => {
    addPending<string>('title', 'now', value => `${value}+local`, 'local');
    addPending<string>('title', 'sent', value => `${value}+sent`, 'optimistic');
    addPending<string>('title', 'seen', value => `${value}+snap`, 'snapshot');
    expect(applyPending('title', 'a')).toBe('a+snap+sent+local');
    addPending<string>('same', 'k', () => 'x');
    expect(applyPending('same', 'x')).toBe('x');
    expect(hasPending('same')).toBe(false);
  });
});
