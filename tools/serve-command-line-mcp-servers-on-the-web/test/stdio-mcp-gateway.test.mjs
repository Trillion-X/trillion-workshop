// The stdio→streamable-HTTP gateway (parts/stdio-mcp-gateway), against a fake stdio server and Trillion's own client.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGateway } from '../do-work/gateway.mjs';
import { toolServerSession } from '../../ai-tool-catalog/do-work/talk-to-a-tool-server.mjs';

const FAKE = new URL('./fixtures/fake-stdio-mcp.mjs', import.meta.url).pathname;
const apps = { one: { cli: process.execPath, args: [FAKE, 'one'] }, two: { cli: process.execPath, args: [FAKE, 'two'] }, broken: { cli: '/nonexistent/binary', args: [] } };

async function serving(options = {}) {
  const workRoot = mkdtempSync(join(tmpdir(), 'gateway-test-'));
  const gateway = createGateway({ apps, workRoot, ...options });
  const server = createServer((request, response) => { void gateway.handle(request, response); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = async () => { gateway.close(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); rmSync(workRoot, { recursive: true, force: true }); };
  return { gateway, base, workRoot, close };
}
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const post = (url, message, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(message) });
const INIT = rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
async function open(base, app = 'one') {
  const response = await post(`${base}/${app}/mcp`, INIT);
  return { response, id: response.headers.get('mcp-session-id'), body: await response.json() };
}
const plainPost = async ({ url, method, headers, body }) => { const r = await fetch(url, { method, headers, body }); return { status: r.status, headers: Object.fromEntries(r.headers.entries()), text: await r.text() }; };

test('initialize starts a session, answers JSON and names the session', async () => {
  const { base, close } = await serving();
  try {
    const { response, id, body } = await open(base);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.ok(id);
    assert.equal(body.result.serverInfo.name, 'one');
    assert.equal((await post(`${base}/one/mcp`, { jsonrpc: '2.0', method: 'notifications/initialized' }, { 'mcp-session-id': id })).status, 202);
    const tools = await (await post(`${base}/one/mcp`, rpc(2, 'tools/list'), { 'mcp-session-id': id })).json();
    assert.deepEqual(tools.result.tools.map(tool => tool.name), ['echo', 'whoami']);
    const called = await (await post(`${base}/one/mcp`, rpc(3, 'tools/call', { name: 'echo', arguments: { text: 'hi' } }), { 'mcp-session-id': id })).json();
    assert.deepEqual(JSON.parse(called.result.content[0].text), { said: 'hi', initialized: true });
  } finally { await close(); }
});

test("Trillion's own client lists and calls through the gateway, for two apps at once", async () => {
  const { base, close } = await serving();
  try {
    for (const app of ['one', 'two']) {
      const session = toolServerSession({ url: `${base}/${app}/mcp`, post: plainPost });
      assert.equal((await session.list()).length, 2);
      assert.match((await session.list())[0].description, new RegExp(app));
      assert.deepEqual(await session.call('echo', { text: app }), { said: app, initialized: true });
    }
  } finally { await close(); }
});

test('a call with no session is a one-off: started, initialized, asked and stopped', async () => {
  const { base, gateway, close } = await serving();
  try {
    const answer = await (await post(`${base}/one/mcp`, rpc(7, 'tools/list'))).json();
    assert.equal(answer.id, 7);
    assert.equal(answer.result.tools.length, 2);
    assert.equal(gateway.sessions().length, 0);
    assert.equal((await post(`${base}/one/mcp`, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  } finally { await close(); }
});

test('DELETE ends a session, which then answers 404; unknown and foreign sessions answer 404', async () => {
  const { base, gateway, close } = await serving();
  try {
    const { id } = await open(base);
    assert.equal(gateway.sessions().length, 1);
    assert.equal((await post(`${base}/two/mcp`, rpc(2, 'tools/list'), { 'mcp-session-id': id })).status, 404);
    assert.equal((await fetch(`${base}/one/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': id } })).status, 200);
    assert.equal(gateway.sessions().length, 0);
    assert.equal((await post(`${base}/one/mcp`, rpc(2, 'tools/list'), { 'mcp-session-id': id })).status, 404);
    assert.equal((await fetch(`${base}/one/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': 'nope' } })).status, 404);
    assert.equal((await post(`${base}/one/mcp`, rpc(2, 'tools/list'), { 'mcp-session-id': 'nope' })).status, 404);
  } finally { await close(); }
});

test('a session is bounded: the least recently used idle one is stopped to make room', async () => {
  const { base, gateway, close } = await serving({ maxSessions: 2 });
  try {
    const first = await open(base);
    const second = await open(base, 'two');
    await post(`${base}/two/mcp`, rpc(2, 'tools/list'), { 'mcp-session-id': second.id });
    const third = await open(base);
    assert.ok(third.id);
    const ids = gateway.sessions().map(session => session.id);
    assert.equal(ids.length, 2);
    assert.ok(!ids.includes(first.id));
    assert.equal((await post(`${base}/one/mcp`, rpc(3, 'tools/list'), { 'mcp-session-id': first.id })).status, 404);
  } finally { await close(); }
});

test('with every session busy, a new one waits queueMs and is then refused with 503', async () => {
  const { base, close } = await serving({ maxSessions: 1, queueMs: 300, requestTimeoutMs: 5000 });
  try {
    const { id } = await open(base);
    const stuck = post(`${base}/one/mcp`, rpc(2, 'tools/call', { name: 'slow', arguments: {} }), { 'mcp-session-id': id });
    await new Promise(resolve => setTimeout(resolve, 100));
    const refused = await post(`${base}/two/mcp`, INIT);
    assert.equal(refused.status, 503);
    assert.ok(refused.headers.get('retry-after'));
    await fetch(`${base}/one/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': id } });
    await stuck.catch(() => {});
  } finally { await close(); }
});

test('an idle session is stopped by the sweep, and a session older than the limit too', async () => {
  const { base, gateway, close } = await serving({ idleMs: 150, sweepMs: 50 });
  try {
    const { id } = await open(base);
    assert.equal(gateway.sessions().length, 1);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(gateway.sessions().length, 0);
    assert.equal((await post(`${base}/one/mcp`, rpc(2, 'tools/list'), { 'mcp-session-id': id })).status, 404);
  } finally { await close(); }
  const aged = await serving({ idleMs: 100000, maxAgeMs: 150, sweepMs: 50 });
  try {
    await open(aged.base);
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(aged.gateway.sessions().length, 0);
  } finally { await aged.close(); }
});

test('a caller that accepts only text/event-stream gets one event', async () => {
  const { base, close } = await serving();
  try {
    const response = await post(`${base}/one/mcp`, INIT, { accept: 'text/event-stream' });
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.match(await response.text(), /^data: \{.*"serverInfo"/);
  } finally { await close(); }
});

test('a request the server never answers gets an error reply after requestTimeoutMs', async () => {
  const { base, close } = await serving({ requestTimeoutMs: 1500 });
  try {
    const { id } = await open(base);
    const answer = await (await post(`${base}/one/mcp`, rpc(2, 'tools/call', { name: 'slow', arguments: {} }), { 'mcp-session-id': id })).json();
    assert.equal(answer.error.code, -32001);
    assert.match(answer.error.message, /did not answer/);
  } finally { await close(); }
});

test('the server gets only PATH, HOME, TMPDIR and LANG, in a folder of its own for each session that is removed after', async () => {
  const { base, workRoot, close } = await serving();
  try {
    const a = await open(base);
    const b = await open(base);
    const who = async id => JSON.parse((await (await post(`${base}/one/mcp`, rpc(5, 'tools/call', { name: 'whoami', arguments: {} }), { 'mcp-session-id': id })).json()).result.content[0].text);
    const [one, two] = [await who(a.id), await who(b.id)];
    assert.notEqual(one.cwd, two.cwd);
    assert.ok(one.cwd.startsWith(workRoot) || one.cwd.includes(workRoot.split('/').pop()));
    assert.deepEqual(one.env.filter(name => !['PWD', 'SHLVL', '_', 'OLDPWD', '__CF_USER_TEXT_ENCODING'].includes(name)), ['HOME', 'LANG', 'PATH', 'TMPDIR']);
    assert.equal(readdirSync(workRoot).length, 2);
    await fetch(`${base}/one/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': a.id } });
    await fetch(`${base}/one/mcp`, { method: 'DELETE', headers: { 'mcp-session-id': b.id } });
    assert.equal(readdirSync(workRoot).length, 0);
  } finally { await close(); }
});

test('a server that exits ends its session (404 after), and one that cannot start is a 502', async () => {
  const { base, gateway, close } = await serving();
  try {
    const { id } = await open(base);
    const died = await (await post(`${base}/one/mcp`, rpc(2, 'tools/call', { name: 'die', arguments: {} }), { 'mcp-session-id': id })).json();
    assert.match(died.error.message, /session ended/);
    assert.equal((await post(`${base}/one/mcp`, rpc(3, 'tools/list'), { 'mcp-session-id': id })).status, 404);
    assert.equal(gateway.sessions().length, 0);
    assert.equal((await post(`${base}/broken/mcp`, INIT)).status, 502);
    assert.equal(gateway.sessions().length, 0);
  } finally { await close(); }
});

test("the server's own requests are answered 'method not found', and its notifications reach a stream", async () => {
  const { base, close } = await serving();
  try {
    const { id } = await open(base);
    const asked = await (await post(`${base}/one/mcp`, rpc(2, 'tools/call', { name: 'ask-client', arguments: {} }), { 'mcp-session-id': id })).json();
    assert.equal(JSON.parse(asked.result.content[0].text).code, -32601);
    const stream = await fetch(`${base}/one/mcp`, { headers: { 'mcp-session-id': id, accept: 'text/event-stream' } });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    await reader.read();
    await post(`${base}/one/mcp`, rpc(3, 'tools/call', { name: 'notify', arguments: {} }), { 'mcp-session-id': id });
    const got = new TextDecoder().decode((await reader.read()).value);
    assert.match(got, /notifications\/message/);
    await reader.cancel();
    assert.equal((await fetch(`${base}/one/mcp`)).status, 405);
  } finally { await close(); }
});

test('a body over the cap is 413; bad JSON is 400; unknown apps and paths are 404; GET / lists the apps', async () => {
  const { base, close } = await serving({ maxBodyBytes: 200 });
  try {
    assert.equal((await post(`${base}/one/mcp`, rpc(1, 'tools/list', { pad: 'x'.repeat(500) }))).status, 413);
    assert.equal((await fetch(`${base}/one/mcp`, { method: 'POST', body: 'not json' })).status, 400);
    assert.equal((await post(`${base}/nope/mcp`, INIT)).status, 404);
    assert.equal((await fetch(`${base}/one/other`)).status, 404);
    assert.equal((await fetch(`${base}/one/mcp`, { method: 'PUT' })).status, 405);
    assert.deepEqual(await (await fetch(`${base}/`)).json(), { ok: true, apps: ['one', 'two', 'broken'], sessions: 0, max_sessions: 16 });
  } finally { await close(); }
});
