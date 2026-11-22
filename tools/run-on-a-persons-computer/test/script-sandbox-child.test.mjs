// The child-process runner of computer/script-sandbox.mjs: the permission model refuses what a script could reach through the
// process, the child has no host environment, and two host calls can be chained with a filter between them.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { childArguments, makeHostCalls, runScript, sandboxSettings } from '../script-sandbox.mjs';

const settings = sandboxSettings();
const fast = { ...settings, limits: { ...settings.limits, wall_ms: 3000 } };

test('a script chains two host calls with a filter between them', async () => {
  const asked = [];
  const host = makeHostCalls({ settings, sendRequest: async request => {
    asked.push(request.url);
    if (request.url === 'https://rows.test/list') return { items: [{ id: 'a', open: true }, { id: 'b', open: false }] };
    return { id: request.id, name: 'First open row' };
  } });
  const result = await runScript({ settings, host, code: `
    const rows = await pm.sendRequest({ url: 'https://rows.test/list' });
    const open = rows.items.filter(row => row.open);
    const named = await pm.sendRequest({ url: 'https://rows.test/get', id: open[0].id });
    return { count: open.length, name: named.name };` });
  assert.deepEqual(result, { value: { count: 1, name: 'First open row' } });
  assert.deepEqual(asked, ['https://rows.test/list', 'https://rows.test/get']);
});

test('the child process has no environment of the host, so no key from the host reaches the script', () => {
  // macOS's CoreFoundation sets __CF_USER_TEXT_ENCODING in every process it starts; the host passes nothing of its own.
  const probe = "process.stdout.write(JSON.stringify(Object.keys(process.env).filter(name => !name.startsWith('__CF_'))));";
  const run = spawnSync(process.execPath, [...childArguments(128).slice(0, 2), '--input-type=module', '--eval', probe], { env: {}, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(run.stdout), []);
});

test('the process refuses a file read of the home .ssh folder, a fetch, and a child process', () => {
  const probe = `
    const out = {};
    const fs = await import('node:fs');
    try { out.read = fs.readdirSync(process.env.HOME + '/.ssh').length; } catch (error) { out.fs = error.code; }
    try { await fetch('https://example.com/'); out.net = 'reached'; } catch (error) { out.net = error.code ?? 'refused'; }
    try { (await import('node:child_process')).execFileSync('/bin/echo', ['hi']); out.child = 'ran'; } catch (error) { out.child = error.code; }
    process.stdout.write(JSON.stringify(out));`;
  const run = spawnSync(process.execPath, [...childArguments(128).slice(0, 2), '--input-type=module', '--eval', probe], { env: {}, encoding: 'utf8' });
  const out = JSON.parse(run.stdout);
  assert.equal(out.read, undefined, 'the .ssh folder must not be read');
  assert.equal(out.fs, 'ERR_ACCESS_DENIED');
  assert.notEqual(out.net, 'reached', 'example.com must not be reached');
  assert.equal(out.child, 'ERR_ACCESS_DENIED');
});

test('a script cannot reach process, fs or a constructor escape to process', async () => {
  const result = await runScript({ settings: fast, code: `
    const found = [typeof process, typeof require, typeof fetch];
    try { found.push(String((async () => {}).constructor('return process')().binding('fs'))); } catch (error) { found.push('refused'); }
    return found.join();` });
  assert.equal(result.value.startsWith('undefined,undefined,undefined'), true, result.value);
  assert.match(result.value, /refused$/);
});

test('a heap that grows past the cap ends the child, and the host survives', async () => {
  const result = await runScript({ settings: fast, code: 'const kept = []; while (true) kept.push(new Array(1e6).fill(0));' });
  assert.ok(result.error, 'the run must be refused');
});

test('an infinite loop is stopped by the wall clock, and the host answers', async () => {
  const result = await runScript({ settings: fast, code: 'while (true) {}' });
  assert.match(result.error, /ran longer than|timed out/);
});
