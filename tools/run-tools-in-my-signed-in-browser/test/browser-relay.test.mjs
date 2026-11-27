// test/browser-relay.test.mjs: a tool run on this computer reaches the person's browser through the native host's relay
// (native-host/browser-relay.mjs, native-host/browser-native-host.mjs serve, native-host/ask-my-browser.mjs,
// src/computer-relay.mjs). The browser is a fake extension speaking the native messaging framing over real streams; the
// relay listens on a real loopback port the test picks.
// test/browser-relay.test.mjs: a tool run on this computer reaches the person's browser through the relay door
// (browser-relay.mjs, ask-my-browser.mjs, computer-relay.mjs). The browser is a fake extension: it receives what the relay
// passes on and answers by name, over a real loopback port the test picks. The host's own framing is tested beside the host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import config from '../browser-relay.json' with { type: 'json' };
import rows from '../what-this-tool-does-and-how-to-run-it.json' with { type: 'json' };
import { makeRelay } from '../browser-relay.mjs';
import { askMyBrowser, signWithVault } from '../ask-my-browser.mjs';
import { makeComputerRelay } from '../computer-relay.mjs';

// The person's vault key, made once: the door knows its public half, a run can have the private half sign.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_HEX = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const vaultSign = payload => edSign(null, Buffer.from(payload, 'utf8'), privateKey).toString('hex');

/** A loopback port nothing listens on now: what this computer's report would name. */
const freePort = () => new Promise(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });

/** A relay on a free loopback port and a fake extension: `next()` is what the relay passes on, `answer(message)` is the extension's reply. */
async function connectedHost(overrides = {}) {
  const sent = [];
  const waiting = [];
  const reported = await freePort();
  const relay = makeRelay({
    config: { ...config, most_seconds: 5, ...overrides.config },
    send: message => { const next = waiting.shift(); if (next) next(message); else sent.push(message); },
    readPort: () => reported,
    readPublicKey: async () => PUBLIC_HEX,
  });
  const opened = await relay.open();
  return {
    relay, opened, sent,
    next: () => sent.length ? Promise.resolve(sent.shift()) : new Promise(resolve => waiting.push(resolve)),
    answer: message => relay.answer(message),
    close: () => relay.close(),
  };
}

const post = (port, body, headers = {}, path = config.path) => new Promise((resolve, reject) => {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  const sent = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, answer => {
    const chunks = [];
    answer.on('data', chunk => chunks.push(chunk));
    answer.on('end', () => resolve({ status: answer.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
  });
  sent.on('error', reject);
  sent.end(data);
});

/** A request the way a run makes it: a nonce from the door, signed in the vault, then the request with its proof. */
async function signed(port, body, headers = {}, path = config.path) {
  const { body: { nonce } } = await post(port, {}, {}, config.challenge_path);
  const text = `${nonce}\n${body.tool}\n${JSON.stringify(body.input ?? {})}`;
  return post(port, { ...body, nonce, signature: vaultSign(text) }, headers, path);
}

test('a request reaches the fake extension over the open connection and its answer comes back', async () => {
  const { answer, next, close, opened } = await connectedHost();
    assert.equal(opened.port_name, config.port_name);
  const asked = signed(opened.port, { tool: 'tool:read-a-page-in-my-browser', input: { url: 'https://example.com/' }, request_key: 'k1' });
  const relayed = await next();
  assert.deepEqual(relayed, { relay: { request_key: 'k1', tool: 'tool:read-a-page-in-my-browser', input: { url: 'https://example.com/' } } });
  answer({ relay_answer: { request_key: 'k1', result: { url: 'https://example.com/', title: 'Example', text: 'words', links: [] } } });
  assert.deepEqual(await asked, { status: 200, body: { result: { url: 'https://example.com/', title: 'Example', text: 'words', links: [] } } });
  close();
});

test('an answer of the browser\'s own error is passed on in words, and an answer past the limit is refused', async () => {
  const { answer, next, close, opened } = await connectedHost({ config: { most_answer_bytes: 200 } });
  let asked = signed(opened.port, { tool: 'tool:act-in-my-browser', input: {}, request_key: 'k2' });
  await next();
  answer({ relay_answer: { request_key: 'k2', error: 'Nothing on the page matched x.' } });
  assert.deepEqual(await asked, { status: 422, body: { error: 'Nothing on the page matched x.' } });
  asked = signed(opened.port, { tool: 'tool:act-in-my-browser', input: {}, request_key: 'k3' });
  await next();
  answer({ relay_answer: { request_key: 'k3', result: { text: 'x'.repeat(500) } } });
  const refused = await asked;
  assert.equal(refused.status, 413);
  assert.match(refused.body.error, /larger than 200 bytes/);
  close();
});

test('a request that is oversized, not json, not listed, from a web page or for another host name is refused', async () => {
  const { close, opened } = await connectedHost({ config: { most_request_bytes: 600 } });
  const url = { tool: 'tool:read-a-page-in-my-browser', input: { url: `https://example.com/${'a'.repeat(1000)}` } };
  assert.equal((await post(opened.port, url)).status, 413);
  assert.equal((await post(opened.port, 'not json')).status, 400);
  assert.equal((await post(opened.port, { tool: 'tool:read-a-page-in-my-browser' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await signed(opened.port, { tool: 'tool:run-anything', input: {} })).status, 404);
  assert.equal((await post(opened.port, { tool: 'tool:read-a-page-in-my-browser' }, { origin: 'https://evil.example' })).status, 404);
  assert.equal((await post(opened.port, { tool: 'tool:read-a-page-in-my-browser' }, { host: 'evil.example' })).status, 404);
  assert.equal((await post(opened.port, { tool: 'tool:read-a-page-in-my-browser' }, {}, '/other')).status, 404);
  close();
});

test('a request waits no longer than the limit, and one whose browser leaves is finished with why', async () => {
  const slow = await connectedHost({ config: { most_seconds: 0.2 } });
  const late = await signed(slow.opened.port, { tool: 'tool:drive-my-browser', input: { do: 'tabs' } });
  assert.equal(late.status, 504);
  assert.match(late.body.error, /did not answer within 0.2 seconds/);
  slow.close();

  const leaving = await connectedHost();
  const asked = signed(leaving.opened.port, { tool: 'tool:drive-my-browser', input: { do: 'tabs' } });
  await leaving.next();
  leaving.close();
  const left = await asked;
  assert.equal(left.status, 502);
  assert.equal(left.body.error, config.words.browser_left);
});

test('with no browser connected the tool run is refused with that reason', async () => {
  const answered = await askMyBrowser('tool:read-a-page-in-my-browser', { url: 'https://example.com/' }, { port: await freePort() });
  assert.deepEqual(answered, { error: config.words.no_browser });
  const refusedByDoor = await askMyBrowser('tool:read-a-page-in-my-browser', {}, { fetcher: async () => ({ text: async () => JSON.stringify({ error: 'x'.repeat(10) }) }), port: 47813, sign: vaultSign });
  assert.deepEqual(refusedByDoor, { error: 'xxxxxxxxxx' });
});

test('the tool run command reaches the door by the data port and returns the extension\'s answer', async () => {
  const { answer, next, close, opened } = await connectedHost();
  const run = askMyBrowser('tool:read-a-page-in-my-browser', { url: 'https://example.com/' }, { port: String(opened.port), sign: async payload => vaultSign(payload) });
  const relayed = await next();
  answer({ relay_answer: { request_key: relayed.relay.request_key, result: { title: 'Example' } } });
  assert.deepEqual(await run, { result: { title: 'Example' } });
  close();
});

test('the extension holds the connection only when the person allowed it, asks for the door, answers each request and reconnects', async () => {
  const posted = [];
  const ports = [];
  let allowed = false;
  const makePort = () => {
    const handlers = { message: [], disconnect: [] };
    const port = { postMessage: message => posted.push(message), onMessage: { addListener: fn => handlers.message.push(fn) }, onDisconnect: { addListener: fn => handlers.disconnect.push(fn) }, handlers };
    ports.push(port);
    return port;
  };
  const browser = { permissions: { contains: async () => allowed }, runtime: { connectNative: host => { assert.equal(host, 'test.example.computer'); return makePort(); }, lastError: undefined } };
  const run = async (tool, input) => tool === 'tool:read-a-page-in-my-browser' ? { result: { echoed: input } } : { error: 'This browser does not run x.' };
  const relay = makeComputerRelay({ browser, host: 'test.example.computer', run });
  assert.equal(await relay.check(), 'not_allowed');
  assert.equal(ports.length, 0);
  allowed = true;
  assert.equal(await relay.check(), 'connected');
  assert.deepEqual(posted, [{ action: 'relay_open' }]);
  ports[0].handlers.message.forEach(fn => fn({ ok: false, action: 'relay_open' }));
  await relay.check();
  assert.equal(posted.length, 2, 'asks again when the door is not open');
  ports[0].handlers.message.forEach(fn => fn({ ok: true, action: 'relay_open', port: 1 }));
  assert.equal(relay.opened, true);
  ports[0].handlers.message.forEach(fn => fn({ relay: { request_key: 'a', tool: 'tool:read-a-page-in-my-browser', input: { url: 'u' } } }));
  ports[0].handlers.message.forEach(fn => fn({ relay: { request_key: 'b', tool: 'tool:other', input: {} } }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(posted.slice(2), [{ relay_answer: { request_key: 'a', result: { echoed: { url: 'u' } } } }, { relay_answer: { request_key: 'b', error: 'This browser does not run x.' } }]);
  ports[0].handlers.disconnect.forEach(fn => fn());
  assert.equal(relay.connected, false);
  assert.equal(await relay.check(), 'connected');
  assert.equal(ports.length, 2);
});

test('a request without a proof, with a wrong one, with a spent nonce or for other words is refused, and the extension never sees it', async () => {
  const { close, sent, opened: { port } } = await connectedHost();
  const tool = 'tool:act-in-my-browser';
  const body = { tool, input: { url: 'https://bank.example/' } };
  const nonceFor = async () => (await post(port, {}, {}, config.challenge_path)).body.nonce;
  const proof = (nonce, other = body) => vaultSign(`${nonce}\n${other.tool}\n${JSON.stringify(other.input)}`);

  assert.equal((await post(port, body)).status, 401, 'no nonce, no signature');
  const nonce = await nonceFor();
  assert.equal((await post(port, { ...body, nonce })).status, 401, 'a nonce without a signature');
  const other = generateKeyPairSync('ed25519').privateKey;
  const wrong = edSign(null, Buffer.from(`${await nonceFor()}\n${tool}\n${JSON.stringify(body.input)}`), other).toString('hex');
  assert.equal((await post(port, { ...body, nonce: await nonceFor(), signature: wrong })).status, 401, 'a signature by another key');
  assert.equal((await post(port, { ...body, nonce: 'f'.repeat(64), signature: proof('f'.repeat(64)) })).status, 401, 'a nonce the door never issued');
  const fresh = await nonceFor();
  assert.equal((await post(port, { ...body, nonce: fresh, signature: proof(fresh, { tool, input: { url: 'https://other.example/' } }) })).status, 401, 'a proof for other input');
  assert.equal((await post(port, { ...body, nonce: fresh, signature: proof(fresh) })).status, 401, 'a nonce spent by a refused try cannot be tried again');
  assert.equal(sent.length, 0, 'the extension was never told of any of them');
  close();
});

test('a nonce is good once and only for its seconds, and a door with no key set up refuses everyone in words', async () => {
  let clock = 1_000;
  const reported = await freePort();
  const relay = makeRelay({ config: { ...config, challenge_seconds: 30 }, send: () => {}, readPort: () => reported, readPublicKey: async () => PUBLIC_HEX, now: () => clock });
  const { port } = await relay.open();
  const { body: { nonce } } = await post(port, {}, {}, config.challenge_path);
  clock += 31_000;
  const late = await post(port, { tool: 'tool:read-a-page-in-my-browser', input: {}, nonce, signature: vaultSign(`${nonce}\ntool:read-a-page-in-my-browser\n{}`) });
  assert.equal(late.status, 401);
  relay.close();

  let held = null;
  const bareAt = await freePort();
  const bare = makeRelay({ config, send: () => {}, readPort: () => bareAt, readPublicKey: async () => held });
  await bare.open();
  const refused = await post(bareAt, {}, {}, config.challenge_path);
  assert.equal(refused.status, 503);
  assert.match(refused.body.error, new RegExp(`make-a-signing-key-in-the-vault with the name ${config.key_name}`));
  assert.equal((await post(bareAt, { tool: 'tool:read-a-page-in-my-browser', input: {} })).status, 503);
  held = PUBLIC_HEX;
  const made = await post(bareAt, {}, {}, config.challenge_path);
  assert.equal(made.status, 200, 'a key made while the door is open is asked for again and used');
  assert.equal(typeof made.body.nonce, 'string');
  bare.close();
});

test('a computer that reports no port for the door opens nothing, and a run given no port is refused in words', async () => {
  assert.equal(Object.hasOwn(config, 'port'), false, 'the number has one home: the computer\'s report');
  let asked = 0;
  for (const reported of [null, undefined, 0, 80, 70000, '47813', 1.5]) {
    const relay = makeRelay({ config, send: () => {}, readPort: () => reported, readPublicKey: async () => { asked += 1; return PUBLIC_HEX; } });
    await assert.rejects(relay.open(), { message: config.words.no_port.replaceAll('{name}', config.port_name) });
    assert.equal(relay.open_now, false);
  }
  assert.equal(asked, 0, 'the vault is not asked for a door that cannot open');
  for (const port of [undefined, '', 'null', '0', '80', '70000', '4781x'])
    assert.deepEqual(await askMyBrowser('tool:read-a-page-in-my-browser', {}, { port, fetcher: async () => assert.fail('nothing is reached') }),
      { error: config.words.no_port.replaceAll('{name}', config.port_name) });
  for (const row of rows.records) {
    assert.ok(row.payload.invoke.local_doors.includes(config.port_name));
    assert.deepEqual(row.payload.invoke.run.at(-1), { fill: { from: 'computer', field: `local_ports.${config.port_name}` } });
  }
});

test('the run proves itself by the vault: its door signs the nonce, and the tool row names that one key and operation', async () => {
  const { answer, next, close, opened } = await connectedHost();
  const calls = [];
  const vaultDoor = { url: 'http://127.0.0.1:1/mcp', capability: 'cap' };
  const fetcher = async (url, options) => {
    if (url === vaultDoor.url) {
      calls.push(JSON.parse(options.body).params.arguments);
      return { ok: true, headers: new Headers({ 'content-type': 'application/json' }), text: async () => JSON.stringify({ result: { structuredContent: { signature: vaultSign(calls.at(-1).input.payload) } } }) };
    }
    return fetch(url, options);
  };
  const run = askMyBrowser('tool:read-a-page-in-my-browser', { url: 'https://example.com/' }, { port: String(opened.port), sign: payload => signWithVault(payload, { door: vaultDoor, fetcher }), fetcher });
  const relayed = await next();
  answer({ relay_answer: { request_key: relayed.relay.request_key, result: { title: 'Example' } } });
  assert.deepEqual(await run, { result: { title: 'Example' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].address, '@secrets');
  assert.equal(calls[0].method, 'secrets:sign');
  assert.equal(calls[0].input.name, config.key_name);
  for (const row of rows.records) assert.deepEqual(row.payload.invoke.records, { fd: 3, rights: [{ at: '@secrets', id: config.key_name, operations: ['secrets:sign'] }] });
  close();
});

test('a run handed no records door cannot ask, and says so', async () => {
  const { close, opened } = await connectedHost();
  const answered = await askMyBrowser('tool:read-a-page-in-my-browser', {}, { port: String(opened.port) });
  assert.match(answered.error, /Send the nonce/);
  close();
});
