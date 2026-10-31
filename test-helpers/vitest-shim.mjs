// The part of vitest's API the tools' .test.ts files use, on node:test, so they run with `node --test` unchanged.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

export { test, describe };

// it.each(cases)(name, fn): one test per case; "$field" in the name is that case's field.
export const it = (...args) => test(...args);
it.each = cases => (name, run) => {
  for (const item of cases) test(name.replace(/\$(\w+)/g, (_, key) => String(item?.[key])), () => run(item));
};

// vitest's toMatchObject: every field the expected object names matches, recursively; a list matches item by item.
const matches = (actual, expected) => {
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => matches(actual[index], item));
  if (expected !== null && typeof expected === 'object') return actual !== null && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => matches(actual[key], value));
  return Object.is(actual, expected);
};

const matchers = (actual, negate) => {
  const check = (pass, message) => assert.ok(negate ? !pass : pass, negate ? `not: ${message}` : message);
  const same = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
  return {
    toBe: expected => check(Object.is(actual, expected), `${JSON.stringify(actual)} to be ${JSON.stringify(expected)}`),
    toEqual: expected => check(same(JSON.parse(JSON.stringify(actual ?? null)), JSON.parse(JSON.stringify(expected ?? null))), `${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`),
    toBeNull: () => check(actual === null, `${JSON.stringify(actual)} to be null`),
    toBeUndefined: () => check(actual === undefined, `${JSON.stringify(actual)} to be undefined`),
    toBeDefined: () => check(actual !== undefined, 'to be defined'),
    toBeTruthy: () => check(Boolean(actual), `${JSON.stringify(actual)} to be truthy`),
    toBeFalsy: () => check(!actual, `${JSON.stringify(actual)} to be falsy`),
    toBeCloseTo: (expected, digits = 2) => check(Math.abs(expected - actual) < 10 ** -digits / 2, `${actual} to be close to ${expected}`),
    toBeGreaterThanOrEqual: expected => check(actual >= expected, `${actual} >= ${expected}`),
    toBeLessThanOrEqual: expected => check(actual <= expected, `${actual} <= ${expected}`),
    toHaveLength: expected => check(actual?.length === expected, `length ${actual?.length} to be ${expected}`),
    toContain: expected => check(Array.isArray(actual) ? actual.some(item => same(item, expected)) : String(actual).includes(expected), `${JSON.stringify(actual)} to contain ${JSON.stringify(expected)}`),
    toMatchObject: expected => check(matches(actual, expected), `${JSON.stringify(actual)} to match ${JSON.stringify(expected)}`),
    toBeGreaterThan: expected => check(actual > expected, `${actual} > ${expected}`),
    toBeLessThan: expected => check(actual < expected, `${actual} < ${expected}`),
    toMatch: expected => check(typeof actual === 'string' && (expected instanceof RegExp ? expected.test(actual) : actual.includes(expected)), `${JSON.stringify(actual)} to match ${expected}`),
    toHaveProperty: key => check(actual !== null && actual !== undefined && Object.hasOwn(Object(actual), key), `${JSON.stringify(actual)} to have ${key}`),
    toThrow: expected => {
      let thrown = null;
      try { actual(); } catch (error) { thrown = error ?? new Error('thrown'); }
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      check(thrown !== null && (expected === undefined || (expected instanceof RegExp ? expected.test(message) : message.includes(expected))), `to throw ${expected ?? ''}${thrown ? ` (threw: ${message})` : ''}`);
    },
  };
};

// Spies: vitest's vi.fn with the mock calls and the implementations the tests set.
const spies = [];
const makeSpy = (implementation = () => undefined) => {
  let current = implementation;
  const once = [];
  const spy = (...args) => {
    spy.mock.calls.push(args);
    const result = (once.length ? once.shift() : current)(...args);
    spy.mock.results.push(result);
    return result;
  };
  spy.mock = { calls: [], results: [] };
  spy.mockImplementation = next => { current = next; return spy; };
  spy.mockReturnValue = value => { current = () => value; return spy; };
  spy.mockResolvedValue = value => { current = async () => value; return spy; };
  spy.mockResolvedValueOnce = value => { once.push(async () => value); return spy; };
  spy.mockReturnValueOnce = value => { once.push(() => value); return spy; };
  spy.mockClear = () => { spy.mock.calls.length = 0; spy.mock.results.length = 0; return spy; };
  spy.mockReset = () => { spy.mock.calls.length = 0; spy.mock.results.length = 0; once.length = 0; current = () => undefined; return spy; };
  spies.push(spy);
  return spy;
};
const stubbed = [];
export const vi = {
  fn: makeSpy,
  stubGlobal: (name, value) => {
    stubbed.push([name, Object.getOwnPropertyDescriptor(globalThis, name)]);
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  },
  unstubAllGlobals: () => {
    while (stubbed.length) {
      const [name, descriptor] = stubbed.pop();
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
    }
  },
  restoreAllMocks: () => { for (const spy of spies) spy.mockReset(); },
};

// expect.any(Constructor): matches a value of that type inside the arguments a spy was called with.
const anyOf = constructor => ({ anyOf: constructor });
const argumentMatches = (actual, expected) => {
  if (expected !== null && typeof expected === 'object' && 'anyOf' in expected && Object.keys(expected).length === 1) {
    const constructor = expected.anyOf;
    if (constructor === String) return typeof actual === 'string';
    if (constructor === Number) return typeof actual === 'number';
    if (constructor === Boolean) return typeof actual === 'boolean';
    if (constructor === Function) return typeof actual === 'function';
    return actual instanceof constructor;
  }
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => argumentMatches(actual[index], item));
  if (expected !== null && typeof expected === 'object') {
    return actual !== null && typeof actual === 'object' && Object.keys(expected).length === Object.keys(actual).length
      && Object.entries(expected).every(([key, value]) => argumentMatches(actual[key], value));
  }
  return Object.is(actual, expected);
};

const spyMatchers = (actual, negate) => {
  const check = (pass, message) => assert.ok(negate ? !pass : pass, negate ? `not: ${message}` : message);
  const calls = () => {
    assert.ok(actual?.mock?.calls, 'a spy made with vi.fn()');
    return actual.mock.calls;
  };
  return {
    toHaveBeenCalled: () => check(calls().length > 0, 'to have been called'),
    toHaveBeenCalledOnce: () => check(calls().length === 1, `to have been called once (called ${calls().length} times)`),
    toHaveBeenCalledTimes: times => check(calls().length === times, `to have been called ${times} times (called ${calls().length})`),
    toHaveBeenCalledWith: (...expected) => check(calls().some(args => argumentMatches(args, expected)), `to have been called with ${JSON.stringify(expected)}`),
  };
};

export const expect = actual => ({
  ...matchers(actual, false),
  ...spyMatchers(actual, false),
  not: { ...matchers(actual, true), ...spyMatchers(actual, true) },
  rejects: {
    toThrow: async expected => {
      let thrown = null;
      try { await actual; } catch (error) { thrown = error ?? new Error('thrown'); }
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      assert.ok(thrown !== null && (expected === undefined || (expected instanceof RegExp ? expected.test(message) : message.includes(expected))), `to reject with ${expected ?? ''}${thrown ? ` (rejected with: ${message})` : ''}`);
    },
  },
});
expect.any = anyOf;
