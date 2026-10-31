// The spies and call matchers that tools' .test.ts files bring over from vitest.
import { describe, expect, it, vi } from '../test-helpers/vitest-shim.mjs';
import assert from 'node:assert/strict';

describe('vi.fn', () => {
  it('records calls and returns what it was set to return', async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true });
    expect(await spy('a', { n: 1 })).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('a', { n: 1 });
    expect(spy.mock.calls[0][0]).toBe('a');
  });

  it('matches expect.any and refuses a call that did not happen', () => {
    const spy = vi.fn();
    expect(spy).not.toHaveBeenCalled();
    spy('venue', { x: 1 });
    expect(spy).toHaveBeenCalledWith('venue', expect.any(Object));
    expect(spy).not.toHaveBeenCalledWith('other', expect.any(Object));
    assert.throws(() => expect(spy).toHaveBeenCalledTimes(2));
  });

  it('takes an implementation and forgets calls on restore', () => {
    const spy = vi.fn().mockImplementation(value => value * 2);
    expect(spy(4)).toBe(8);
    vi.restoreAllMocks();
    expect(spy.mock.calls).toHaveLength(0);
  });

  it('answers one call at a time with Once values, then falls back, and clears calls', async () => {
    const spy = vi.fn().mockResolvedValue('later').mockResolvedValueOnce('first');
    expect(await spy()).toBe('first');
    expect(await spy()).toBe('later');
    spy.mockClear();
    expect(spy.mock.calls).toHaveLength(0);
    expect(await spy()).toBe('later');
  });

  it('stubs and unstubs a global', () => {
    const before = globalThis.fetch;
    vi.stubGlobal('fetch', () => 'stubbed');
    expect(globalThis.fetch()).toBe('stubbed');
    vi.unstubAllGlobals();
    expect(globalThis.fetch).toBe(before);
  });
});

describe('it.each', () => {
  const seen = [];
  it.each([{ title: 'one', n: 1 }, { title: 'two', n: 2 }])('runs the "$title" case', item => { seen.push(item.n); });
  it('ran one test per case', () => { expect(seen).toEqual([1, 2]); });
});

describe('matchers', () => {
  it('compares numbers and awaits a rejection', async () => {
    expect(1).toBeLessThan(2);
    expect(3).not.toBeLessThan(2);
    await expect(Promise.reject(new Error('refused: no key'))).rejects.toThrow('refused');
    await assert.rejects(expect(Promise.resolve(1)).rejects.toThrow());
  });
});
