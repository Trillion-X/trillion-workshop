// The part of vitest's API the tools' .test.ts files use, on node:test, so they run with `node --test` unchanged.
import { test as nodeTest, describe as nodeDescribe, beforeEach, afterEach, before, after } from 'node:test';
import { format } from 'node:util';
import assert from 'node:assert/strict';

export { beforeEach, afterEach, before as beforeAll, after as afterAll };

// A case's test name, as vitest names it: printf-style %s %d %i %f %j %o %O take the case's arguments in order, %# is
// the case's index, %% is a percent sign, and "$field" is that field of an object case ("$0" an array case's first item).
const caseName = (name, args, index) => {
  let at = 0;
  const named = name.replace(/%([sdifjoO#%])/g, (match, flag) => {
    if (flag === '%') return '%';
    if (flag === '#') return String(index);
    if (at >= args.length) return match;
    const value = args[at++];
    if (flag === 'j') return JSON.stringify(value);
    return format(`%${flag}`, value);
  });
  const fields = args.length === 1 && args[0] !== null && typeof args[0] === 'object' ? args[0] : args;
  return named.replace(/\$(\w+)/g, (match, key) => (key in Object(fields) ? String(fields[key]) : match));
};

// each(cases)(name, fn): one test per case. A case that is a list is spread into the function's arguments
// (it.each([[1, 2], [3, 4]])('%d + %d', (a, b) => ...)); any other case is its one argument.
const withEach = run => {
  const each = cases => (name, fn) => {
    cases.forEach((item, index) => {
      const args = Array.isArray(item) ? item : [item];
      run(caseName(name, args, index), () => fn(...args));
    });
  };
  return Object.assign((...args) => run(...args), { each, skip: run.skip, only: run.only, todo: run.todo });
};
export const it = withEach(nodeTest);
export const test = withEach(nodeTest);
export const describe = withEach(nodeDescribe);

// vitest's toMatchObject: every field the expected object names matches, recursively; a list matches item by item.
const matches = (actual, expected) => {
  if (isAsymmetric(expected)) return expected.asymmetricMatch(actual);
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => matches(actual[index], item));
  if (expected !== null && typeof expected === 'object') return actual !== null && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => matches(actual[key], value));
  return Object.is(actual, expected);
};

// Asymmetric matchers (expect.objectContaining, expect.any) stand inside an expected value and decide that place.
class Asymmetric {
  constructor(asymmetricMatch, description) { this.asymmetricMatch = asymmetricMatch; this.description = description; }
  toJSON() { return this.description; }
}
const isAsymmetric = value => value instanceof Asymmetric;
const hasAsymmetric = value => isAsymmetric(value)
  || (Array.isArray(value) ? value.some(hasAsymmetric) : value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).some(hasAsymmetric));

// vitest's toEqual where an expected value holds an asymmetric matcher: that place is the matcher's to decide, every
// other place is equal recursively, and a field whose value is undefined counts as absent.
const equalWith = (actual, expected) => {
  if (isAsymmetric(expected)) return expected.asymmetricMatch(actual);
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => equalWith(actual[index], item));
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
    const keys = value => Object.keys(value).filter(key => value[key] !== undefined).sort();
    const [mine, theirs] = [keys(actual), keys(expected)];
    return mine.length === theirs.length && mine.every((key, index) => key === theirs[index] && equalWith(actual[key], expected[key]));
  }
  return Object.is(actual, expected);
};

const matchers = (actual, negate) => {
  const check = (pass, message) => assert.ok(negate ? !pass : pass, negate ? `not: ${message}` : message);
  const same = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch { return false; } };
  const equal = (a, b) => (hasAsymmetric(b) ? equalWith(a, b) : same(JSON.parse(JSON.stringify(a ?? null)), JSON.parse(JSON.stringify(b ?? null))));
  return {
    toBe: expected => check(Object.is(actual, expected), `${JSON.stringify(actual)} to be ${JSON.stringify(expected)}`),
    toEqual: expected => check(equal(actual, expected), `${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`),
    toContainEqual: expected => check(Array.isArray(actual) && actual.some(item => equal(item, expected)), `${JSON.stringify(actual)} to contain an item equal to ${JSON.stringify(expected)}`),
    toBeTypeOf: type => check(typeof actual === type, `${JSON.stringify(actual)} to be of type ${type} (is ${typeof actual})`),
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
  if (isAsymmetric(expected)) return expected.asymmetricMatch(actual);
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
  // expect(promise).resolves.<matcher>(...): the matcher, on what the promise resolves to (a rejection fails it).
  resolves: Object.fromEntries(Object.keys(matchers(undefined, false)).map(name => [name, async (...args) => matchers(await actual, false)[name](...args)])),
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
// expect.objectContaining(fields): an object holding at least these fields, each matched as toMatchObject matches it.
expect.objectContaining = fields => new Asymmetric(actual => actual !== null && typeof actual === 'object' && matches(actual, fields), `ObjectContaining ${JSON.stringify(fields)}`);
