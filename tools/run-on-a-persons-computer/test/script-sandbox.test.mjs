// test/script-sandbox.test.mjs
//
// A person's script runs in a worker thread and a null-prototype vm context with no authority but what the host hands it
// (computer/script-sandbox.mjs: F-0516, F-0806). Real worker threads, real files, a real symlink.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHostCalls, runScript, sandboxSettings } from '../script-sandbox.mjs';

const base = sandboxSettings();
const withCaps = patch => ({ ...base, capabilities: { ...base.capabilities, ...patch } });

test('a script gets pm and nothing else: no process, no require, no host realm through any constructor chain', async () => {
  assert.deepEqual(await runScript({ code: 'return pm.input.a + 1', input: { a: 1 } }), { value: 2 });
  assert.deepEqual(await runScript({ code: 'return [typeof process, typeof require, typeof module, typeof fetch].join()' }), { value: 'undefined,undefined,undefined,undefined' });
  for (const attempt of ["this.constructor.constructor('return process')()", "pm.sendRequest.constructor('return process')()", "(async () => {}).constructor('return process')()",
    "Object.getPrototypeOf(pm).constructor('return process')()", "pm.files.read.constructor('return process.env')()", "(function(){ return arguments.callee.caller })()"]) {
    const answer = await runScript({ code: `try { const got = await ${attempt}; return got === undefined || got === null ? 'none' : typeof got.then === 'function' ? 'promise' : String(typeof got); } catch (error) { return 'blocked'; }` });
    assert.ok(['blocked', 'none'].includes(answer.value), `${attempt} -> ${JSON.stringify(answer)}`);
  }
  assert.equal(typeof process.versions.node, 'string', 'the host process is still there');
});

test('a script that does not stop is stopped at its wall clock, and a thrown error comes back as words', async () => {
  const started = Date.now();
  const stopped = await runScript({ code: 'while (true) {}', wall_ms: 300 });
  assert.match(stopped.error, /timed out|ran longer/);
  assert.ok(Date.now() - started < 5000);
  const hung = await runScript({ code: 'await new Promise(() => {})', wall_ms: 300 });
  assert.match(hung.error, /ran longer than 300 ms/);
  assert.match((await runScript({ code: "throw new Error('nope')" })).error, /stopped with an error: nope/);
  assert.match((await runScript({ code: "return 'x'.repeat(300000)" })).error, /result is larger/);
  assert.equal(base.limits.wall_ms, 30000, 'the default is finite');
});

test('files are read only below the one folder given: .., absolute paths and a symlink out are refused, and absent means no files at all', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sandbox-'));
  const outside = mkdtempSync(join(tmpdir(), 'sandbox-outside-'));
  mkdirSync(join(root, 'work'));
  writeFileSync(join(root, 'work', 'ok.txt'), 'inside');
  writeFileSync(join(outside, 'secret.txt'), 'outside');
  symlinkSync(join(outside, 'secret.txt'), join(root, 'work', 'link.txt'));
  const host = makeHostCalls({ settings: base, files: { folder: join(root, 'work') } });
  assert.deepEqual(await runScript({ code: "return await pm.files.read('ok.txt')", host }), { value: 'inside' });
  for (const path of ['../../' + outside.split('/').pop() + '/secret.txt', outside + '/secret.txt', 'link.txt', 'missing.txt']) {
    const answer = await runScript({ code: `try { return await pm.files.read(${JSON.stringify(path)}); } catch (error) { return 'refused: ' + error.message; }`, host });
    assert.match(answer.value, /^refused: .* is outside the folder/, path);
  }
  const none = await runScript({ code: "try { return await pm.files.read('ok.txt'); } catch (error) { return error.message; }", host: makeHostCalls({ settings: base }) });
  assert.equal(none.value, 'This script was not given any files.');
});

test('cookies need an allowlisted domain, packages an allowlisted name and a timeout, and a script request goes through the person\'s pipeline with file bodies removed', async () => {
  const settings = withCaps({ cookies: { domains: ['example.com'] }, packages: { allowed: ['left-pad', 'slow'], timeout_ms: 100 } });
  const jar = new Map([['example.com|sid', 'abc']]);
  const sent = [];
  const host = makeHostCalls({ settings, cookies: { get: (domain, name) => jar.get(`${domain}|${name}`), set: (domain, name, value) => jar.set(`${domain}|${name}`, value) && null },
    loadPackage: name => (name === 'slow' ? new Promise(() => {}) : `${name} loaded`), sendRequest: async request => { sent.push(request); return { status: 200 }; } });
  const code = `
    const out = {};
    out.cookie = await pm.cookies.get('api.example.com', 'sid').catch(e => e.message);
    out.own = await pm.cookies.get('example.com', 'sid');
    out.other = await pm.cookies.get('evil.test', 'sid').catch(e => e.message);
    out.pkg = await pm.require('left-pad');
    out.denied = await pm.require('fs').catch(e => e.message);
    out.slow = await pm.require('slow').catch(e => e.message);
    out.req = await pm.sendRequest({ url: 'https://x.test/', method: 'POST', body: { kind: 'file', path: '/etc/hosts' } });
    out.req2 = await pm.sendRequest({ url: 'https://x.test/', method: 'POST', body: { kind: 'raw', text: 'hi' } });
    return out;`;
  const { value } = await runScript({ code, settings, host });
  assert.equal(value.own, 'abc');
  assert.equal(value.other, 'This script may not use cookies for evil.test.');
  assert.equal(value.pkg, 'left-pad loaded');
  assert.equal(value.denied, 'The package fs is not one this script may load.');
  assert.match(value.slow, /did not load in 100 ms/);
  assert.deepEqual(sent.map(request => request.body), [undefined, { kind: 'raw', text: 'hi' }]);
  const without = await runScript({ code: "try { await pm.sendRequest({ url: 'https://x.test/' }); } catch (e) { return e.message; }", host: makeHostCalls({ settings: base }) });
  assert.equal(without.value, 'This script was not given a way to send requests.');
});
