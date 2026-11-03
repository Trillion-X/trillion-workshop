// test/graph-author-input.test.mjs
//
// What leaves the machine when a model is asked for a graph document (parts/ui/show/layer-diagram/author-input.mjs):
// secret-bearing and churn files never leave, source goes before lock-file-sized noise, one file at most is cut, and the
// list of what leaves is exact.
import assert from 'node:assert/strict';
import test from 'node:test';
import rules from '../parts/ui/show/layer-diagram/author-input.json' with { type: 'json' };
import { boundAuthorInput, outboundList } from '../parts/ui/show/layer-diagram/author-input.mjs';
import { selectorTest } from '../parts/ui/show/layer-diagram/select-glob.mjs';

const file = (path, size, fill = 'a') => ({ path, text: fill.repeat(size) });

test('excluded paths never leave and say why, whatever the budget', () => {
  const bounded = boundAuthorInput([file('src/a.mjs', 10), file('.env.production', 10), file('package-lock.json', 10), file('config/credentials.json', 10), file('logo.png', 10)]);
  assert.deepEqual(bounded.sent.map((sent) => sent.path), ['src/a.mjs']);
  assert.deepEqual(bounded.left_out.map((out) => [out.path, out.reason]), [['.env.production', 'secret-file'], ['package-lock.json', 'lock-file'], ['config/credentials.json', 'secret-file'], ['logo.png', 'binary-or-minified']]);
  assert.equal(bounded.left_out[0].why, 'may hold a secret');
});

test('rank decides who is sent first, so generated churn cannot push source out of the budget', () => {
  const small = { ...rules, budget_bytes: 5000, min_cut_bytes: 2000 };
  const bounded = boundAuthorInput([file('gen/generated-api.ts.snap', 4000), file('src/core.mjs', 3000), file('docs/notes.txt', 1500), file('schema.json', 1000)], small);
  assert.deepEqual(bounded.sent.map((sent) => [sent.path, sent.class, sent.cut]), [['src/core.mjs', 'source', false], ['schema.json', 'contract', false]]);
  assert.deepEqual(bounded.left_out.map((out) => [out.path, out.reason]), [['docs/notes.txt', 'budget'], ['gen/generated-api.ts.snap', 'budget']]);
  assert.equal(bounded.bytes, 4000);
  assert.ok(bounded.bytes <= small.budget_bytes);
});

test('only the file that straddles the budget is cut, and only when enough of it fits', () => {
  const small = { ...rules, budget_bytes: 5000, min_cut_bytes: 1000 };
  const bounded = boundAuthorInput([file('a.mjs', 3000), file('b.mjs', 4000), file('c.mjs', 500)], small);
  assert.deepEqual(bounded.sent.map((sent) => [sent.path, sent.bytes, sent.cut]), [['a.mjs', 3000, false], ['b.mjs', 2000, true]]);
  assert.deepEqual(bounded.left_out.map((out) => out.path), ['c.mjs']);
  assert.equal(bounded.bytes, 5000);
  const none = boundAuthorInput([file('a.mjs', 4500), file('b.mjs', 4000)], { ...small, min_cut_bytes: 1000 });
  assert.deepEqual(none.sent.map((sent) => sent.path), ['a.mjs']);
  assert.deepEqual(none.left_out.map((out) => out.path), ['b.mjs']);
});

test('a cut never splits a character and sizes are UTF-8 bytes', () => {
  const small = { ...rules, budget_bytes: 11, min_cut_bytes: 1 };
  const bounded = boundAuthorInput([{ path: 'a.mjs', text: 'é'.repeat(20) }], small);
  assert.equal(bounded.sent[0].bytes, 10);
  assert.equal(bounded.sent[0].text, 'é'.repeat(5));
});

test('the list says exactly what leaves and what stays, from DATA words', () => {
  const small = { ...rules, budget_bytes: 2500, min_cut_bytes: 2000 };
  const bounded = boundAuthorInput([file('src/a.mjs', 2000), file('.env', 5), file('src/b.mjs', 600)], small);
  assert.deepEqual(outboundList(bounded, small), [
    'Sent to the model (1 files, 2000 bytes of 2500):',
    '  src/a.mjs (2000 bytes)',
    'Not sent (2 files):',
    '  .env: may hold a secret',
    '  src/b.mjs: over the budget',
  ]);
});

test('the same input gives the same answer, and the selector test is whole-text with a wildcard', () => {
  const input = [file('x.mjs', 10), file('y.json', 10)];
  assert.deepEqual(boundAuthorInput(input), boundAuthorInput(input));
  const test = selectorTest('a*c.d');
  assert.deepEqual(['abc.d', 'ac.d', 'abc.dd', 'abcxd'].map(test), [true, true, false, false]);
});
