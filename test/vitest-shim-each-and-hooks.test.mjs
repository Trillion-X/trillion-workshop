// The rest of vitest the tools' .test.ts files bring over: each with list and object cases, the hooks, toBeTypeOf,
// toContainEqual, expect.objectContaining and .resolves.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test } from '../test-helpers/vitest-shim.mjs';
import assert from 'node:assert/strict';

const seen = [];

describe('it.each', () => {
  it.each([[1, 2, 3], [2, 3, 5]])('adds %d and %d to %d', (a, b, sum) => {
    seen.push(`${a}+${b}`);
    assert.equal(a + b, sum);
  });

  it.each(['address_bytes', 'addressed_chunks'])('takes %s as its one argument', mode => {
    assert.equal(typeof mode, 'string');
    seen.push(mode);
  });

  test.each([{ name: 'first', n: 1 }, { name: 'second', n: 2 }])('names $name from the case (%#)', ({ n }) => {
    seen.push(`case ${n}`);
  });
});

describe.each([['outer', 7]])('describe.each %s', (label, value) => {
  it('spreads the list case into the block', () => {
    assert.equal(label, 'outer');
    assert.equal(value, 7);
  });
});

describe('hooks', () => {
  const order = [];
  beforeAll(() => order.push('beforeAll'));
  beforeEach(() => order.push('beforeEach'));
  afterEach(() => order.push('afterEach'));
  afterAll(() => {
    assert.deepEqual(order, ['beforeAll', 'beforeEach', 'first', 'afterEach', 'beforeEach', 'second', 'afterEach']);
  });
  it('runs beforeAll then beforeEach first', () => order.push('first'));
  it('runs afterEach between tests', () => order.push('second'));
});

describe('matchers', () => {
  it('ran every each case with its own arguments', () => {
    assert.deepEqual(seen, ['1+2', '2+3', 'address_bytes', 'addressed_chunks', 'case 1', 'case 2']);
  });

  it('toBeTypeOf is typeof, and fails on another type', () => {
    expect('a').toBeTypeOf('string');
    expect(1).toBeTypeOf('number');
    expect([]).toBeTypeOf('object');
    expect(1).not.toBeTypeOf('string');
    assert.throws(() => expect(1).toBeTypeOf('string'));
  });

  it('toContainEqual finds an equal item, not only the same one', () => {
    expect([{ a: 1 }, { b: [2] }]).toContainEqual({ b: [2] });
    expect([{ a: 1 }]).not.toContainEqual({ a: 2 });
    assert.throws(() => expect([{ a: 1 }]).toContainEqual({ a: 1, b: 2 }));
  });

  it('expect.objectContaining matches inside toEqual and spy arguments, and refuses a field that differs', () => {
    expect([{ a: 1, b: { c: 2, d: 3 }, e: 4 }]).toEqual([expect.objectContaining({ a: 1, b: { c: 2, d: 3 } })]);
    expect({ outer: { a: 1, extra: true }, n: 2 }).toEqual({ outer: expect.objectContaining({ a: 1 }), n: 2 });
    assert.throws(() => expect([{ a: 1 }]).toEqual([expect.objectContaining({ a: 2 })]));
    assert.throws(() => expect({ outer: { a: 1 }, n: 2 }).toEqual({ outer: expect.objectContaining({ a: 1 }), n: 3 }));
    assert.throws(() => expect({ outer: { a: 1 }, n: 2, more: 1 }).toEqual({ outer: expect.objectContaining({ a: 1 }), n: 2 }));
    assert.throws(() => expect([null]).toEqual([expect.objectContaining({})]));
  });

  it('.resolves applies the matcher to the resolved value, and fails when it does not hold', async () => {
    await expect(Promise.resolve('look-1-id')).resolves.toContain('look-1');
    await expect(Promise.resolve({ a: 1 })).resolves.toEqual({ a: 1 });
    await assert.rejects(expect(Promise.resolve('other')).resolves.toContain('look-1'));
    await assert.rejects(expect(Promise.reject(new Error('no'))).resolves.toBeDefined());
  });
});
