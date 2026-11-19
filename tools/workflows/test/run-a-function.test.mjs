// tools/workflows/do-work/run-a-function.mjs: the door-free entry of a tool that keeps no rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const entry = new URL('../do-work/run-a-function.mjs', import.meta.url).pathname;
const module = join(mkdtempSync(join(tmpdir(), 'run-a-function-')), 'double.mjs');
writeFileSync(module, 'export const double = ({ n }) => ({ n: n * 2 });\nexport const names = (...given) => ({ given: given.length });\nexport const wake = () => ({ shown: 1, wake_effects: [{ kind: "x" }] });\nexport const boom = () => { throw new Error("it broke"); };\nexport const unsent = () => { throw Object.assign(new Error("not sent"), { not_sent: true, code: "held", result: 1, at: () => 1, cause: new Error("inner") }); };\n');
const run = (args, input) => {
  const done = spawnSync(process.execPath, [entry, module, ...args], { input: JSON.stringify(input), encoding: 'utf8' });
  return { code: done.status, last: JSON.parse(done.stdout.trim().split('\n').at(-1)) };
};

test('the function is called with the input and its answer is the result', () => {
  assert.deepEqual(run(['double'], { n: 21 }), { code: 0, last: { result: { n: 42 } } });
});

test('a function is handed its input and nothing else', () => {
  assert.deepEqual(run(['names'], {}).last, { result: { given: 1 } });
});

test('wake_effects are printed beside the result, not in it', () => {
  assert.deepEqual(run(['wake'], {}).last, { result: { shown: 1 }, wake_effects: [{ kind: 'x' }] });
});

test('a failure is the last line, with a failing exit', () => {
  assert.deepEqual(run(['boom'], {}), { code: 1, last: { error: 'it broke' } });
  assert.match(run(['missing'], {}).last.error, /has no function missing/);
  assert.match(run(['double', '--files-door-fd', '3'], { n: 1 }).last.error, /usage: run-a-function/);
});

test('the fields a function put on its error come out beside the message, never its stack or cause', () => {
  const { code, last } = run(['unsent'], {});
  assert.equal(code, 1);
  assert.deepEqual(last, { error: 'not sent', not_sent: true, code: 'held' });
});
