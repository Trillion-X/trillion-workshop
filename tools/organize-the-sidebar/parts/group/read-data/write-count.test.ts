// packages/group/read-data/write-count.test.ts
import { describe, expect, it } from '../../../../../test-helpers/vitest-shim.mjs';
import { writeCountOf } from '../../../read-data/write-count.ts';

describe('writeCountOf — every write-batch reply shape', () => {
  it('object with write_count / writeCount (and nested payload)', () => {
    expect(writeCountOf({ write_count: 1 })).toBe(1);
    expect(writeCountOf({ writeCount: 3 })).toBe(3);
    expect(writeCountOf({ payload: { write_count: 2 } })).toBe(2);
  });
  it('8-byte u64 little-endian buffer (the real live front-door shape)', () => {
    const bytes = new Uint8Array(8);
    bytes[0] = 1; // 1 LE
    expect(writeCountOf(bytes)).toBe(1);
    const two = new Uint8Array(8); two[0] = 2;
    expect(writeCountOf(two)).toBe(2);
  });
  it('JSON / number string', () => {
    expect(writeCountOf('{"write_count":1}')).toBe(1);
  });
  it('unrecognized shapes → 0 (never throws)', () => {
    expect(writeCountOf(null)).toBe(0);
    expect(writeCountOf(undefined)).toBe(0);
    expect(writeCountOf([1, 2])).toBe(0);
    expect(writeCountOf('nonsense')).toBe(0);
  });
});
