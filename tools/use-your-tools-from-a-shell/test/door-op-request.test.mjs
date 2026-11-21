// tools/use-your-tools-from-a-shell/test/door-op-request.test.mjs
// The request door-op.mjs reads on standard input: its shape is checked before anything is sent, and importing the module
// starts nothing (the program runs only when it is started as a program).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requestOf } from '../do-work/door-op.mjs';

test('an op request names its command, kind and method', () => {
  const request = requestOf('{"cli":"example","kind":"op","method":"tools:run","input":{"tool":"tool:x"},"pins":["abc"]}');
  assert.equal(request.method, 'tools:run');
  assert.deepEqual(request.pins, ['abc']);
});

test('a call request names its tool', () => {
  assert.equal(requestOf('{"cli":"example","kind":"call","tool":"tool:x"}').tool, 'tool:x');
});

test('a request that is not JSON, or not one object, is refused with status 2', () => {
  for (const text of ['not json', '[1]', 'null']) {
    assert.throws(() => requestOf(text), error => error.status === 2);
  }
});

test('a request without its command name, or with an unknown kind, is refused', () => {
  assert.throws(() => requestOf('{"kind":"op","method":"tools:run"}'), /names the command/);
  assert.throws(() => requestOf('{"cli":"example","kind":"sql"}'), /"op" or "call"/);
});

test('an op names its method and a call names its tool', () => {
  assert.throws(() => requestOf('{"cli":"example","kind":"op"}'), /names its method/);
  assert.throws(() => requestOf('{"cli":"example","kind":"call"}'), /names its tool/);
});
