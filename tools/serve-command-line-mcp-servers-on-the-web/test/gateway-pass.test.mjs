// The gateway's pass: read from descriptor 4 within a bound, no pass refused, a bad pass and a good pass at the port
// (do-work/gateway-pass.mjs, do-work/serve.mjs).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createGateway } from '../do-work/gateway.mjs';
import { gatewayPass, guarded, heldPass } from '../do-work/gateway-pass.mjs';

const FAKE = new URL('./fixtures/fake-stdio-mcp.mjs', import.meta.url).pathname;
const SERVE = new URL('../do-work/serve.mjs', import.meta.url).pathname;
const apps = { one: { cli: process.execPath, args: [FAKE, 'one'] } };
const PASS = 'a-pass-for-the-test';
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
const pipe = { isFIFO: () => true };

test('descriptor 4 must be a pipe, and the pass is what it carries, trimmed', async () => {
  assert.equal(await heldPass({ stat: () => pipe, open: () => Readable.from([' from-the-vault \n']) }), 'from-the-vault');
  assert.equal(await heldPass({ stat: () => ({ isFIFO: () => false }), open: () => Readable.from(['a file']) }), '', 'a file on descriptor 4 is refused');
  assert.equal(await heldPass({ stat: () => { throw Object.assign(new Error('bad fd'), { code: 'EBADF' }); } }), '', 'a closed descriptor is no pass');
});

test('a pipe that never ends gives up at the bound, with no pass', async () => {
  const started = Date.now();
  const never = new Readable({ read() {} });
  assert.equal(await heldPass({ timeoutMs: 80, stat: () => pipe, open: () => never }), '');
  assert.ok(Date.now() - started < 1500, 'the read was bounded');
});

test('serve.mjs with nothing on descriptor 4 refuses to start, with a plain message and a nonzero code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-pass-serve-'));
  const config = join(dir, 'config.json');
  writeFileSync(config, JSON.stringify({ apps: { one: { cli: '/bin/cat', args: [] } }, port: 0 }));
  const child = spawn(process.execPath, [SERVE, config], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill(); resolve('still running'); }, 8000);
    child.on('exit', exitCode => { clearTimeout(timer); resolve(exitCode); });
  });
  rmSync(dir, { recursive: true, force: true });
  assert.notEqual(code, 'still running', 'it must not hang');
  assert.notEqual(code, 0);
  assert.match(stderr, /no pass was given on descriptor 4, so the gateway does not start/);
});

test('only the exact bearer pass is allowed', () => {
  const pass = gatewayPass(PASS);
  const asked = authorization => ({ headers: authorization === undefined ? {} : { authorization } });
  assert.equal(pass.allows(asked(`Bearer ${PASS}`)), true);
  assert.equal(pass.allows(asked(undefined)), false, 'no pass');
  assert.equal(pass.allows(asked('Bearer wrong')), false, 'a bad pass');
  assert.equal(pass.allows(asked(`Basic ${PASS}`)), false, 'another scheme');
  assert.equal(pass.allows(asked(`Bearer ${PASS}x`)), false, 'a longer pass');
  assert.throws(() => gatewayPass('   '), /no pass was given on descriptor 4/);
});

test('at the port, a request without the pass gets 401 and reaches no app; the good pass gets the gateway', async () => {
  const workRoot = mkdtempSync(join(tmpdir(), 'gateway-pass-test-'));
  const gateway = createGateway({ apps, workRoot });
  const server = createServer(guarded(gateway, gatewayPass(PASS)));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const none = await fetch(`${base}/`);
    assert.equal(none.status, 401);
    assert.equal(none.headers.get('www-authenticate'), 'Bearer');
    assert.equal((await fetch(`${base}/one/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(INIT) })).status, 401);
    assert.equal((await fetch(`${base}/`, { headers: { authorization: 'Bearer wrong' } })).status, 401);

    const good = await fetch(`${base}/`, { headers: { authorization: `Bearer ${PASS}` } });
    assert.equal(good.status, 200);
    assert.equal((await good.json()).ok, true);
    const init = await fetch(`${base}/one/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${PASS}` }, body: JSON.stringify(INIT) });
    assert.equal(init.status, 200);
    assert.ok(init.headers.get('mcp-session-id'));
    assert.equal((await init.json()).result.serverInfo.name, 'one');
  } finally {
    gateway.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    rmSync(workRoot, { recursive: true, force: true });
  }
});
