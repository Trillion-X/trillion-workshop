// tools/keep-answers-on-this-device/test/client-data-layer.test.mjs: moved from old trillion test/client-data-layer.test.mjs
// lines 111-128 with their assertions unchanged: answers kept in memory stay within a budget, and a store held by a stuck
// tab gives up instead of freezing the page. Old trillion bundled the modules with esbuild and swapped kept-values.json
// for { open_timeout_ms: 20 }; here a module hook does the same swap. The tab-leader tests moved to
// tools/keep-open-screens-in-step-with-changes; the Retry-After test stays with src/workspace/quiet-writes.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  load(url, context, nextLoad) {
    if (/kept-values\.json(\?|$)/.test(url)) return { format: 'json', source: JSON.stringify({ open_timeout_ms: 20 }), shortCircuit: true };
    return nextLoad(url, context);
  },
});
const { touch, trimToBudget } = await import('../src/workspace/memory-budget.ts');
const { createKeptValues, keptValuesProblems } = await import('../parts/ui/show/request/kept-values.ts');

test('answers kept in memory are let go least recently used first, within the budget, and only those that may go', () => {
  const answers = new Map([['a', { text: 'x'.repeat(40), keep: false }], ['b', { text: 'y'.repeat(40), keep: true }], ['c', { text: 'z'.repeat(40), keep: false }], ['d', { text: 'w'.repeat(40), keep: false }]]);
  touch(answers, 'a');
  const gone = trimToBudget(answers, value => value.text.length, value => !value.keep, 100);
  console.log('BUDGET READBACK:', JSON.stringify({ gone, left: [...answers.keys()] }));
  assert.equal(gone, 2);
  assert.deepEqual([...answers.keys()], ['b', 'a'], 'c and d went first (a was used last, b may not go)');
  assert.equal(trimToBudget(answers, value => value.text.length, () => true, 1000), 0);
});

test('a store held by a stuck tab gives up reading as nothing kept, and says why', async () => {
  globalThis.indexedDB = { open: () => ({}) };
  const kept = createKeptValues('trillion-kept-stuck');
  assert.equal(await kept.read('anything'), null);
  console.log('STUCK OPEN READBACK:', JSON.stringify(keptValuesProblems().map(item => ({ name: item.name, reason: item.reason }))));
  assert.deepEqual(keptValuesProblems().map(item => item.reason), ['open_timed_out']);
  delete globalThis.indexedDB;
});
