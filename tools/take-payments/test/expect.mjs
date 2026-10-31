// tools/take-payments/test/expect.mjs
//
// The part of vitest's API these tests use, on node:test, so the ported test files run with `node --test` unchanged.
// It compares whole-cent amounts held as bigint (the shared helper turns values into JSON first, which refuses a
// bigint), and it has `it.each`, `expect.objectContaining` and `.rejects`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

export { describe };

const isObject = value => value !== null && typeof value === 'object';
const MATCHER = Symbol('matcher');

// Equality as vitest reads it: fields that are undefined do not count, a matcher stands for any value it accepts, and
// whole-cent amounts held as bigint compare by value.
const equal = (actual, expected) => {
  if (isObject(expected) && expected[MATCHER]) return expected.test(actual);
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => equal(actual[index], item));
  if (isObject(expected)) {
    if (!isObject(actual) || Array.isArray(actual)) return false;
    const keys = object => Object.keys(object).filter(key => object[key] !== undefined);
    return keys(actual).length === keys(expected).length && keys(expected).every(key => equal(actual[key], expected[key]));
  }
  return Object.is(actual, expected);
};

const matches = (actual, expected) => {
  if (isObject(expected) && expected[MATCHER]) return expected.test(actual);
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => matches(actual[index], item));
  if (isObject(expected)) return isObject(actual) && Object.entries(expected).every(([key, value]) => matches(actual[key], value));
  return Object.is(actual, expected);
};

const said = (error, expected) => {
  const message = error instanceof Error ? error.message : String(error);
  return expected === undefined || (expected instanceof RegExp ? expected.test(message) : message.includes(expected));
};

const describeValue = value => JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? `${item}n` : item));

const matchers = (actual, negate) => {
  const check = (pass, message) => assert.ok(negate ? !pass : pass, negate ? `not: ${message}` : message);
  const same = equal;
  return {
    toBe: expected => check(Object.is(actual, expected), `${describeValue(actual)} to be ${describeValue(expected)}`),
    toEqual: expected => check(same(actual, expected), `${describeValue(actual)} to equal ${describeValue(expected)}`),
    toBeNull: () => check(actual === null, `${describeValue(actual)} to be null`),
    toBeUndefined: () => check(actual === undefined, `${describeValue(actual)} to be undefined`),
    toBeTruthy: () => check(Boolean(actual), `${describeValue(actual)} to be truthy`),
    toHaveLength: expected => check(actual?.length === expected, `length ${actual?.length} to be ${expected}`),
    toContain: expected => check(Array.isArray(actual) ? actual.some(item => same(item, expected)) : String(actual).includes(expected), `${describeValue(actual)} to contain ${describeValue(expected)}`),
    toMatchObject: expected => check(matches(actual, expected), `${describeValue(actual)} to match ${describeValue(expected)}`),
    toMatch: expected => check(typeof actual === 'string' && (expected instanceof RegExp ? expected.test(actual) : actual.includes(expected)), `${describeValue(actual)} to match ${expected}`),
    toThrow: expected => {
      let thrown = null;
      try { actual(); } catch (error) { thrown = error ?? new Error('thrown'); }
      check(thrown !== null && said(thrown, expected), `to throw ${expected ?? ''}${thrown ? ` (threw: ${thrown.message})` : ''}`);
    },
  };
};

export const expect = actual => ({
  ...matchers(actual, false),
  not: matchers(actual, true),
  rejects: {
    toThrow: async expected => {
      let thrown = null;
      try { await actual; } catch (error) { thrown = error ?? new Error('thrown'); }
      assert.ok(thrown !== null && said(thrown, expected), `to reject with ${expected ?? ''}${thrown ? ` (rejected: ${thrown.message})` : ''}`);
    },
  },
});
expect.objectContaining = fields => ({ [MATCHER]: true, test: actual => isObject(actual) && Object.entries(fields).every(([key, value]) => matches(actual[key], value)) });

export const it = (name, run) => test(name, run);
// it.each(cases)(name, fn): one test per case; each case that is a list is spread into the function's arguments.
it.each = cases => (name, run) => {
  for (const item of cases) {
    const args = Array.isArray(item) ? item : [item];
    let index = 0;
    const title = name.replace(/%[sid]/g, () => String(args[index++]));
    test(title, () => run(...args));
  }
};
