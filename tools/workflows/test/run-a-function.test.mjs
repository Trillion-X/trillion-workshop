// tools/workflows/do-work/run-a-function.mjs: the door-free entry of a tool that keeps no rows.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const entry = new URL('../do-work/run-a-function.mjs', import.meta.url).pathname;
const module = join(tempFolder(join(tmpdir(), 'run-a-function-')), 'double.mjs');
writeFileSync(module, 'export const double = ({ n }) => ({ n: n * 2 });\nexport const names = (...given) => ({ given: given.length, host: Object.keys(given[1] ?? {}) });\nexport const defaults = (input, { env = process.env, fetchImpl = fetch } = {}) => ({ key: env.RUN_A_FUNCTION_TEST_KEY ?? null, fetch_is_global: fetchImpl === fetch });\nexport const wake = () => ({ shown: 1, wake_effects: [{ kind: "x" }] });\nexport const boom = () => { throw new Error("it broke"); };\nexport const unsent = () => { throw Object.assign(new Error("not sent"), { not_sent: true, code: "held", result: 1, at: () => 1, cause: new Error("inner") }); };\nexport const leaky = () => { throw Object.assign(new Error("leaky"), { host: { parentActions: 1 }, bytes: Buffer.from("secret file"), code: "kept" }); };\nexport const read = async (input, host) => {\n  try { return { file: await host.readWholeFile("notes.txt") }; } catch (error) { return { code: error.code, outcome: error.outcome }; }\n};\nexport const trash = async (input, host) => {\n  try { return { moved: await host.parentActions.trashSource(input) }; } catch (error) { return { code: error.code, outcome: error.outcome }; }\n};\n');
const run = (args, input, stdio) => {
  const done = spawnSync(process.execPath, [entry, module, ...args], { input: JSON.stringify(input), encoding: 'utf8', ...(stdio ? { stdio: ['pipe', 'pipe', 'pipe', stdio] } : {}) });
  return { code: done.status, last: JSON.parse(done.stdout.trim().split('\n').at(-1)) };
};
const routeFile = route => { const file = join(tempFolder(join(tmpdir(), 'run-a-function-route-')), 'route.json'); writeFileSync(file, JSON.stringify(route)); return file; };

test('the function is called with the input and its answer is the result', () => {
  assert.deepEqual(run(['double'], { n: 21 }), { code: 0, last: { result: { n: 42 } } });
});

test('a function is handed its input and the host actions, which read nothing until used', () => {
  assert.deepEqual(run(['names'], {}).last, { result: { given: 2, host: ['files', 'run', 'operation', 'writeLarge', 'parentActions', 'readWholeFile'] } });
});

test('a function whose second argument has defaults keeps them: the host answers only its own names', () => {
  const done = spawnSync(process.execPath, [entry, module, 'defaults'], { input: '{}', encoding: 'utf8', env: { ...process.env, RUN_A_FUNCTION_TEST_KEY: 'k1' } });
  assert.deepEqual(JSON.parse(done.stdout.trim().split('\n').at(-1)), { result: { key: 'k1', fetch_is_global: true } });
});

test('a run without its private descriptor refuses a host action as not handed, and reads no door', () => {
  assert.deepEqual(run(['trash'], { path: '/x', expected_generation: '1' }).last, { result: { code: 'no_host_actions', outcome: 'not_started' } });
});

test('a file read is refused as no_files when the row declares no files right, before any call', () => {
  const handle = openSync(routeFile({ url: 'http://127.0.0.1:9/mcp', capability: 'synthetic' }), 'r');
  try {
    const done = spawnSync(process.execPath, [entry, module, 'read', '--parent-actions-fd', '3'], { input: '{}', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe', handle] });
    assert.deepEqual(JSON.parse(done.stdout.trim().split('\n').at(-1)), { result: { code: 'no_files', outcome: 'not_started' } });
  } finally { closeSync(handle); }
});

test('a host action is refused before any call when its input is not the exact path and generation', () => {
  assert.deepEqual(run(['trash'], { path: 'relative' }).last, { result: { code: 'original_input_refused', outcome: 'not_started' } });
});

test('the descriptor named by --parent-actions-fd is the route: an unreachable parent is unknown, never retried', () => {
  const handle = openSync(routeFile({ url: 'http://127.0.0.1:9/mcp', capability: 'synthetic', computer_actions: { resource: '@parent', trash_source: 'trash' } }), 'r');
  try {
    const done = spawnSync(process.execPath, [entry, module, 'trash', '--parent-actions-fd', '3'], { input: JSON.stringify({ path: '/x', expected_generation: '1' }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe', handle] });
    assert.deepEqual(JSON.parse(done.stdout.trim().split('\n').at(-1)), { result: { code: 'computer_action_unknown', outcome: 'unknown' } });
  } finally { closeSync(handle); }
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

test('an error line never carries the host actions or a binary file content', () => {
  assert.deepEqual(run(['leaky'], {}).last, { error: 'leaky', code: 'kept' });
});

test('a row that packed only the runner starts it: the host actions load only when a function uses one', async () => {
  const { cpSync, mkdirSync } = await import('node:fs');
  const packed = tempFolder(join(tmpdir(), 'run-a-function-packed-'));
  mkdirSync(join(packed, 'workflows/do-work'), { recursive: true });
  const alone = join(packed, 'workflows/do-work/run-a-function.mjs');
  cpSync(entry, alone);
  const runAlone = (name, input) => {
    const done = spawnSync(process.execPath, [alone, module, name], { input: JSON.stringify(input), encoding: 'utf8' });
    return { code: done.status, last: JSON.parse(done.stdout.trim().split('\n').at(-1)) };
  };
  assert.deepEqual(runAlone('double', { n: 21 }), { code: 0, last: { result: { n: 42 } } });
  assert.deepEqual(runAlone('names', {}).last, { result: { given: 2, host: ['files', 'run', 'operation', 'writeLarge', 'parentActions', 'readWholeFile'] } });
  assert.match(String(runAlone('trash', { path: '/x', expected_generation: '1' }).last.result.code ?? ''), /ERR_MODULE_NOT_FOUND/);
});
