// tools/workflows/do-work/run-a-function.mjs: the door-free entry of a tool that keeps no rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const entry = new URL('../do-work/run-a-function.mjs', import.meta.url).pathname;
const module = join(mkdtempSync(join(tmpdir(), 'run-a-function-')), 'double.mjs');
writeFileSync(module, 'export const double = ({ n }) => ({ n: n * 2 });\nexport const names = (input, context) => ({ keys: Object.keys(context).filter(key => context[key] !== undefined) });\nexport const wake = () => ({ shown: 1, wake_effects: [{ kind: "x" }] });\nexport const boom = () => { throw new Error("it broke"); };\n');
const run = (args, input) => {
  const done = spawnSync(process.execPath, [entry, module, ...args], { input: JSON.stringify(input), encoding: 'utf8' });
  return { code: done.status, last: JSON.parse(done.stdout.trim().split('\n').at(-1)) };
};

test('the function is called with the input and its answer is the result', () => {
  assert.deepEqual(run(['double'], { n: 21 }), { code: 0, last: { result: { n: 42 } } });
});

test('a function with no files right is handed no door', () => {
  assert.deepEqual(run(['names'], {}).last, { result: { keys: [] } });
});

test('wake_effects are printed beside the result, not in it', () => {
  assert.deepEqual(run(['wake'], {}).last, { result: { shown: 1 }, wake_effects: [{ kind: 'x' }] });
});

test('a failure is the last line, with a failing exit', () => {
  assert.deepEqual(run(['boom'], {}), { code: 1, last: { error: 'it broke' } });
  assert.match(run(['missing'], {}).last.error, /has no function missing/);
  assert.match(run(['double', '--files-door-fd', '2'], { n: 1 }).last.error, /usage: run-a-function/);
});
