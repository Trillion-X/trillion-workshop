import test from 'node:test';
import assert from 'node:assert/strict';
import { makeScheduler } from '../src/scheduler.mjs';
import settings from '../src/scheduler.json' with { type: 'json' };

function make(policy = settings) {
  return makeScheduler({
    alarm: { setAlarm() {}, deleteAlarm() {} },
    sources: [],
    builtIn: { run: async () => ({}) },
    policy,
  });
}

test('scheduler accepts its shipped retry ranges', () => {
  assert.doesNotThrow(() => make());
  assert.doesNotThrow(() => make({ ...settings, retry: {
    first_after_seconds: 1,
    factor: 1,
    longest_after_seconds: 1,
    attempts_before_held: 1,
  } }));
});

test('scheduler rejects invalid retry values before it can run work', () => {
  const invalid = [
    ['first_after_seconds', 0],
    ['first_after_seconds', Infinity],
    ['first_after_seconds', 86401],
    ['factor', 0],
    ['factor', 0.5],
    ['factor', 11],
    ['longest_after_seconds', 0],
    ['longest_after_seconds', 604801],
    ['attempts_before_held', 0],
    ['attempts_before_held', 1.5],
    ['attempts_before_held', 101],
  ];
  for (const [key, value] of invalid) {
    const retry = { ...settings.retry, [key]: value };
    assert.throws(
      () => make({ ...settings, retry }),
      { name: 'RangeError' },
      `retry.${key}=${value} must be rejected`,
    );
  }
});

test('scheduler rejects a cap below its first retry delay', () => {
  assert.throws(
    () => make({ ...settings, retry: { ...settings.retry, first_after_seconds: 120, longest_after_seconds: 60 } }),
    /longest_after_seconds must be at least retry.first_after_seconds/,
  );
});

test('scheduler rejects a missing retry policy', () => {
  assert.throws(() => make({ ...settings, retry: null }), /retry policy must be an object/);
});
