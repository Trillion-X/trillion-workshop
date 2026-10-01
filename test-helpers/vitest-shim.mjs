// The part of vitest's API the tools' .test.ts files use, on node:test, so they run with `node --test` unchanged.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

export { test, describe, test as it };

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
export const expect = actual => ({ ...matchers(actual, false), not: matchers(actual, true) });
