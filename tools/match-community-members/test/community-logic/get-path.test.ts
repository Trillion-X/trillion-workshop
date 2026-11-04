// Vendored unchanged except for import paths from bitfield-packages/packages/progression-evaluator/read-data/get-path.test.ts.
// packages/progression-evaluator/read-data/get-path.test.ts
//
// Pins the ONE canonical path-walk semantics now shared by derive-measure's
// consumers, measure-ops, the measure-projection shaper, and cohort-stitch — so a
// path walk cannot silently drift into a bug the way the `band` primitive did.

import { describe, expect, it } from '../vitest-shim.mjs';
import { getPath } from '../../src/community-logic/get-path.ts';

describe('get-path — canonical machine-readable path walk (SSOT)', () => {
  it('reads a nested value by path array', () => {
    expect(getPath({ a: { b: { c: 7 } } }, ['a', 'b', 'c'])).toBe(7);
    expect(getPath({ fields: { flow: { value: 0.9 } } }, ['fields', 'flow', 'value'])).toBe(0.9);
  });

  it('empty or omitted path returns the object itself', () => {
    const o = { x: 1 };
    expect(getPath(o, [])).toBe(o);
    expect(getPath(o, undefined)).toBe(o);
    expect(getPath(42, [])).toBe(42);
  });

  it('a missing segment -> undefined (no throw)', () => {
    expect(getPath({ a: { b: 1 } }, ['a', 'z'])).toBeUndefined();
    expect(getPath({ a: { b: 1 } }, ['a', 'b', 'c'])).toBeUndefined(); // b is 1, not an object
  });

  it('a null/undefined/non-object cursor mid-walk -> undefined', () => {
    expect(getPath({ a: null }, ['a', 'b'])).toBeUndefined();
    expect(getPath({ a: undefined }, ['a', 'b'])).toBeUndefined();
    expect(getPath(null, ['a'])).toBeUndefined();
    expect(getPath(undefined, ['a'])).toBeUndefined();
    expect(getPath('str', ['length'])).toBeUndefined(); // primitive cursor, not traversed
  });

  it('accepts a readonly path array (both mutable and readonly callers pass)', () => {
    const path: readonly string[] = ['a', 'b'];
    expect(getPath({ a: { b: 'ok' } }, path)).toBe('ok');
  });
});
