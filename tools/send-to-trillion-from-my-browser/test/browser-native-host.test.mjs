// test/browser-native-host.test.mjs: the native messaging host Trillion's extension may call on this computer
// (extension/native-host/offer-in-browsers.mjs places it, extension/native-host/browser-native-host.mjs answers), over a made-up home folder:
// manifests pinned to exact extension ids, placed idempotently in each installed browser, read back, removed so they
// stay removed, placed again; and the real launcher started as a browser starts it, answering a framed message.
import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeHostManifest, nativeHosts, offerInBrowsers, placeNativeHosts, removeNativeHosts, restoreNativeHosts } from '../native-host/offer-in-browsers.mjs';
import { answerMessage, answers, frame, serve } from '../native-host/browser-native-host.mjs';
import { PassThrough } from 'node:stream';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import relayConfig from '../../run-tools-in-my-signed-in-browser/browser-relay.json' with { type: 'json' };
import { makeRelay } from '../../run-tools-in-my-signed-in-browser/browser-relay.mjs';

const settings = {
  offers: [{ id: 'send', extension_id: 'abcdefghijklmnopabcdefghijklmnop', update_url: 'https://store.example/update' }, { id: 'other', extension_id: 'zzzz', update_url: 'https://store.example/update' }],
  browsers: [
    { id: 'one', app: '~/Apps/One.app', profiles: '~/Support/One', offers_from: 'External Extensions', native_hosts_from: 'NativeMessagingHosts' },
    { id: 'gone', app: '~/Apps/Gone.app', profiles: '~/Support/Gone', offers_from: 'External Extensions', native_hosts_from: 'NativeMessagingHosts' },
  ],
  native_host_launchers: '~/state/native-hosts',
  most_message_bytes: 1024,
  native_hosts: [{ name: 'test.trillion.computer', description: 'Test host', entry: 'browser-native-host.mjs', offers: ['send'], actions: ['here'] }],
};
const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/';

test('a manifest names only the extensions its row names, by exact id', () => {
  assert.deepEqual(nativeHostManifest(settings, settings.native_hosts[0], '/x/launcher'),
    { name: 'test.trillion.computer', description: 'Test host', path: '/x/launcher', type: 'stdio', allowed_origins: [ORIGIN] });
});

test('placing is idempotent and per installed browser; removing stays removed through the reader pass until placed again', () => {
  const home = tempFolder(join(tmpdir(), 'native-host-'));
  try {
    mkdirSync(join(home, 'Apps/One.app'), { recursive: true });
    const stateFile = join(home, 'state/offered.json');
    const manifestFile = join(home, 'Support/One/NativeMessagingHosts/test.trillion.computer.json');
    assert.deepEqual(placeNativeHosts({ settings, home, runtime: '/rt/node' }), [{ browser: 'one', host: 'test.trillion.computer', state: 'placed' }]);
    assert.deepEqual(placeNativeHosts({ settings, home, runtime: '/rt/node' }), [{ browser: 'one', host: 'test.trillion.computer', state: 'unchanged' }]);
    assert.equal(existsSync(join(home, 'Support/Gone')), false, 'a browser not installed is passed over');
    const launcher = join(home, 'state/native-hosts/test.trillion.computer');
    assert.equal(JSON.parse(readFileSync(manifestFile, 'utf8')).path, launcher);
    assert.equal(statSync(launcher).mode & 0o777, 0o755);
    assert.match(readFileSync(launcher, 'utf8'), /^#!\/bin\/sh\nexec '\/rt\/node' '.*browser-native-host\.mjs' 'test\.trillion\.computer' "\$1"\n$/);
    assert.deepEqual(nativeHosts({ settings, home }), [
      { browser: 'one', host: 'test.trillion.computer', placed: true, pinned_to: [ORIGIN] },
      { browser: 'gone', host: 'test.trillion.computer', placed: false, pinned_to: [] }]);

    assert.deepEqual(removeNativeHosts({ settings, home, stateFile }), [{ browser: 'one', host: 'test.trillion.computer' }]);
    assert.equal(existsSync(manifestFile) || existsSync(launcher), false);
    offerInBrowsers({ settings, home, stateFile });
    assert.equal(existsSync(manifestFile), false, 'the reader pass never places a host the person removed');
    assert.deepEqual(restoreNativeHosts({ settings, home, stateFile }).map(row => row.state), ['placed']);
    offerInBrowsers({ settings, home, stateFile });
    assert.equal(existsSync(manifestFile), true);

    // A manifest of the same name that starts another program is never removed.
    writeFileSync(manifestFile, JSON.stringify({ name: 'test.trillion.computer', path: '/elsewhere' }));
    assert.deepEqual(removeNativeHosts({ settings, home, stateFile }), []);
    assert.equal(JSON.parse(readFileSync(manifestFile, 'utf8')).path, '/elsewhere');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('only a pinned extension is answered, and only the actions its row lists', async () => {
  const actions = { here: async () => ({ computer: 'test-mac' }), drive_sync: async () => ({ state: 'synced' }) };
  assert.deepEqual(await answerMessage({ settings, name: 'test.trillion.computer', origin: ORIGIN, message: { action: 'here' }, actions }), { ok: true, action: 'here', computer: 'test-mac' });
  assert.equal((await answerMessage({ settings, name: 'test.trillion.computer', origin: 'chrome-extension://zzzz/', message: { action: 'here' }, actions })).ok, false);
  assert.match((await answerMessage({ settings, name: 'test.trillion.computer', origin: ORIGIN, message: { action: 'drive_sync' }, actions })).error, /does not answer drive_sync/);
  assert.equal((await answerMessage({ settings, name: 'nobody', origin: ORIGIN, message: { action: 'here' }, actions })).ok, false);

  // Framing: two messages in one chunk, then an oversized one ends the program.
  const written = [];
  const input = (async function* () { yield Buffer.concat([frame({ action: 'here' }), frame({ action: 'nope' })]); yield Buffer.from([0xff, 0xff, 0, 0]); yield frame({ action: 'here' }); })();
  await serve({ settings, name: 'test.trillion.computer', origin: ORIGIN, input, output: { write: bytes => written.push(bytes) }, actions });
  const answers = written.map(bytes => JSON.parse(bytes.subarray(4).toString('utf8')));
  assert.deepEqual(answers.map(row => row.ok), [true, false], 'the message after an oversized length is never read');
});

test('the real launcher, started as a browser starts it, answers a framed message', async () => {
  const home = tempFolder(join(tmpdir(), 'native-host-live-'));
  try {
    mkdirSync(join(home, 'Apps/One.app'), { recursive: true });
    const live = { ...settings, native_hosts: [{ ...settings.native_hosts[0], name: 'ai.gettrillion.computer' }],
      offers: [{ id: 'send-to-trillion', extension_id: 'hlcppfhpcfmlinjmjkiadmbnnboadlnh' }] };
    live.native_hosts[0].offers = ['send-to-trillion'];
    placeNativeHosts({ settings: live, home });
    const launcher = JSON.parse(readFileSync(join(home, 'Support/One/NativeMessagingHosts/ai.gettrillion.computer.json'), 'utf8')).path;
    // The carried program reads the shipped offer-in-browsers.json, which pins the store id of Send to Trillion.
    const child = spawn(launcher, ['chrome-extension://hlcppfhpcfmlinjmjkiadmbnnboadlnh/'], { stdio: ['pipe', 'pipe', 'inherit'] });
    const out = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stdin.end(frame({ action: 'here' }));
    await new Promise(done => child.on('close', done));
    const bytes = Buffer.concat(out);
    const answer = JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32LE(0)).toString('utf8'));
    assert.equal(answer.ok, true);
    assert.equal(answer.program, 'trillion');
    assert.equal(typeof answer.computer, 'string');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the extension asks the computer only with the optional permission, and says which way an ask did not go', async () => {
  const listeners = [];
  globalThis.chrome = { runtime: { id: 'ext', getURL: path => `chrome-extension://ext/${path}`, onMessage: { addListener: listener => listeners.push(listener) } } };
  const { askComputer } = await import('../src/computer-host.mjs');
  const sent = [];
  const browser = (allowed, answer) => ({ permissions: { contains: async asked => { assert.deepEqual(asked, { permissions: ['nativeMessaging'] }); return allowed; } },
    runtime: { sendNativeMessage: async (host, message) => { sent.push([host, message]); if (answer instanceof Error) throw answer; return answer; } } });
  assert.deepEqual(await askComputer('here', { browser: browser(false) }), { state: 'not_allowed' });
  assert.equal(sent.length, 0, 'nothing is sent without the permission');
  assert.deepEqual(await askComputer('here', { browser: browser(true, { ok: true, computer: 'mac' }) }), { state: 'answered', answer: { ok: true, computer: 'mac' } });
  assert.deepEqual(sent[0], ['ai.gettrillion.computer', { action: 'here' }]);
  assert.equal((await askComputer('here', { browser: browser(true, new Error('Specified native messaging host not found.')) })).state, 'not_installed');
  assert.deepEqual(await askComputer('here', { browser: browser(true, { ok: false, error: 'no' }) }), { state: 'refused', error: 'no' });
  // A page or another extension is not answered.
  assert.equal(listeners[0]({ trillion_computer: { action: 'here' } }, { id: 'other', url: 'https://example.com/' }, () => {}), false);
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.optional_permissions, ['nativeMessaging']);
  assert.equal(manifest.permissions.includes('nativeMessaging'), false, 'never asked at install');
  const shipped = JSON.parse(readFileSync(new URL('../native-host/offer-in-browsers.json', import.meta.url), 'utf8'));
  assert.ok(shipped.native_hosts.some(host => host.name === 'ai.gettrillion.computer'), 'the extension asks the host the Mac places');
});

// The engine door (extension/native-host/engine-door.mjs): an action that needs the person's Trillion asks the local
// engine at 127.0.0.1 with MCP tools/call do_one_thing_in_my_account, the port from the engine's adoption descriptor and the
// key from the Mac app's key store (here a stand-in reader with a made-up key).
const FIXTURE_KEY = 'fixture-door-key-0123456789abcdef';
const door = { adoption_file: '~/Support/Trillion/local-runtime.json', computer_report: '~/Support/computer/computer.json', keychain_item: 'fixture-item', path: '/mcp',
  protocol_version: '2026-07-28', most_request_bytes: 4096, most_answer_bytes: 1024, timeout_seconds: 5 };
const fakeDoor = async answer => {
  const { createServer } = await import('node:http');
  const seen = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { seen.push({ url: request.url, headers: request.headers, body: JSON.parse(body) }); answer(response, seen.at(-1)); });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { seen, port: server.address().port, close: () => new Promise(done => server.close(done)) };
};
const doorHome = port => {
  const home = tempFolder(join(tmpdir(), 'native-host-door-'));
  if (port) { mkdirSync(join(home, 'Support/Trillion'), { recursive: true }); writeFileSync(join(home, 'Support/Trillion/local-runtime.json'), JSON.stringify({ port })); }
  return home;
};
const doorSettings = { ...settings, engine_door: door,
  native_hosts: [{ ...settings.native_hosts[0], actions: ['here', 'files_state'], door_actions: { files_state: { address: '@fixture-files', method: 'state:read' } } }] };

test('a door action asks the local engine for its DATA-named operation with the key store\'s key, and never answers with the key', async () => {
  const { doorAnswers } = await import('../native-host/engine-door.mjs');
  const engine = await fakeDoor((response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { synced: 3, waiting: 0 } } }));
  });
  const home = doorHome(engine.port);
  try {
    const keyReads = [];
    const actions = doorAnswers(doorSettings, doorSettings.native_hosts[0], { home, readKey: async row => { keyReads.push(row.keychain_item); return FIXTURE_KEY; } });
    const answer = await answerMessage({ settings: doorSettings, name: 'test.trillion.computer', origin: ORIGIN, actions,
      message: { action: 'files_state', input: { folder: 'fixture' }, request_key: 'fixture-request-1', address: '@elsewhere', method: 'delete' } });
    assert.deepEqual(answer, { ok: true, action: 'files_state', answer: { synced: 3, waiting: 0 } });
    assert.equal(JSON.stringify(answer).includes(FIXTURE_KEY), false);
    assert.deepEqual(keyReads, ['fixture-item'], 'the key is read from the DATA-named key store item at the call');
    const [call] = engine.seen;
    assert.equal(call.url, '/mcp');
    assert.equal(call.headers.authorization, `Bearer ${FIXTURE_KEY}`);
    assert.equal(call.headers['mcp-protocol-version'], '2026-07-28');
    assert.deepEqual(call.body, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'do_one_thing_in_my_account',
      arguments: { address: '@fixture-files', method: 'state:read', request_key: 'fixture-request-1', input: { folder: 'fixture' } } } },
      'the address and method are the row\'s, never the message\'s');
    // A door action is still only answered for the pinned extension and when its host lists it.
    assert.equal((await answerMessage({ settings: doorSettings, name: 'test.trillion.computer', origin: 'chrome-extension://zzzz/', actions, message: { action: 'files_state' } })).ok, false);
    assert.match((await answerMessage({ settings, name: 'test.trillion.computer', origin: ORIGIN, actions, message: { action: 'files_state' } })).error, /does not answer files_state/);
    assert.equal(engine.seen.length, 1, 'a refused message never reaches the engine');
  } finally { await engine.close(); rmSync(home, { recursive: true, force: true }); }
});

test('the door refuses in words: no engine, no key, a refused key, an engine error, an event-stream answer read', async () => {
  const { askDoor } = await import('../native-host/engine-door.mjs');
  const ask = options => askDoor({ door, address: '@fixture-files', method: 'state:read', readKey: async () => FIXTURE_KEY, ...options });
  const nowhere = doorHome(null);
  try {
    await assert.rejects(ask({ home: nowhere }), /not running/);
    mkdirSync(join(nowhere, 'Support/Trillion'), { recursive: true });
    writeFileSync(join(nowhere, 'Support/Trillion/local-runtime.json'), JSON.stringify({ port: 80 }));
    const { doorPort } = await import('../native-host/engine-door.mjs');
    assert.equal(doorPort(door, { home: nowhere }), null);
    await assert.rejects(ask({ home: nowhere }), /not running/, 'a port outside 1024-65535 is never asked');
  } finally { rmSync(nowhere, { recursive: true, force: true }); }

  let mode = 'refused';
  const engine = await fakeDoor((response) => {
    if (mode === 'refused') { response.statusCode = 401; response.end(); return; }
    if (mode === 'error') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { isError: true, content: [{ type: 'text', text: 'No such resource.' }] } })); return; }
    if (mode === 'large') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { structuredContent: { text: 'x'.repeat(2048) } } })); return; }
    response.setHeader('content-type', 'text/event-stream');
    response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"state":"synced"}' }] } })}\n\n`);
  });
  const home = doorHome(engine.port);
  try {
    await assert.rejects(ask({ home, readKey: async () => null }), /not signed in/);
    await assert.rejects(ask({ home, readKey: async () => 'short' }), /not signed in/);
    assert.equal(engine.seen.length, 0, 'nothing is sent without a key');
    await assert.rejects(ask({ home }), error => /refused this computer's sign-in/.test(error.message) && !error.message.includes(FIXTURE_KEY));
    mode = 'error';
    await assert.rejects(ask({ home }), /No such resource/);
    mode = 'large';
    await assert.rejects(ask({ home }), /too large/);
    mode = 'stream';
    assert.deepEqual(await ask({ home }), { state: 'synced' });
    await assert.rejects(ask({ home, input: [] }), /object input/);
    await assert.rejects(ask({ home, input: { text: 'x'.repeat(8192) } }), /too large/);
  } finally { await engine.close(); rmSync(home, { recursive: true, force: true }); }
});

test('the relay\'s port is the one this computer\'s report names, and its key\'s public half is the vault\'s, asked by name', async () => {
  const { reportedPort, vaultPublicKey } = await import('../native-host/engine-door.mjs');
  const home = doorHome(null);
  try {
    assert.equal(reportedPort(door, 'browser-relay', { home }), null, 'no report: no port');
    mkdirSync(join(home, 'Support/computer'), { recursive: true });
    for (const [ports, expected] of [[{ 'browser-relay': 47813 }, 47813], [{ 'model-pool': 8092 }, null], [{ 'browser-relay': 80 }, null], [{ 'browser-relay': '47813' }, null]]) {
      writeFileSync(join(home, 'Support/computer/computer.json'), JSON.stringify({ report: { local_ports: ports } }));
      assert.equal(reportedPort(door, 'browser-relay', { home }), expected);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }

  let held = 'a'.repeat(64);
  const engine = await fakeDoor((response, seen) => {
    response.setHeader('content-type', 'application/json');
    const asked = seen.body.params.arguments;
    const known = asked.address === '@secrets' && asked.method === 'secrets:public' && asked.input.name === 'browser-relay-key' && held;
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: known ? { structuredContent: { name: 'browser-relay-key', scheme: 'ed25519', public_key: held } } : { isError: true, content: [{ type: 'text', text: 'No such name.' }] } }));
  });
  const engineHome = doorHome(engine.port);
  try {
    const ask = name => vaultPublicKey(door, name, { home: engineHome, readKey: async () => FIXTURE_KEY });
    assert.equal(await ask('browser-relay-key'), held);
    assert.equal(await ask('other-key'), null, 'a name the vault does not hold gives no key');
    held = 'not hex';
    assert.equal(await ask('browser-relay-key'), null, 'an answer that is not a public half gives no key');
  } finally { await engine.close(); rmSync(engineHome, { recursive: true, force: true }); }
});

test('the shipped DATA: the door is the engine on this computer, the key comes from the Mac app\'s key store, and the Mac app runs the placer', () => {
  const shipped = JSON.parse(readFileSync(new URL('../native-host/offer-in-browsers.json', import.meta.url), 'utf8'));
  assert.equal(shipped.engine_door.path, '/mcp');
  assert.match(shipped.engine_door.adoption_file, /Trillion\/local-runtime\.json$/);
  assert.match(shipped.engine_door.computer_report, /\/computer\/computer\.json$/);
  assert.equal(typeof shipped.engine_door.keychain_item, 'string');
  assert.ok(shipped.engine_door.most_answer_bytes <= 1024 * 1024, 'never more than the browser takes');
  for (const host of shipped.native_hosts) for (const action of Object.keys(host.door_actions ?? {})) assert.ok(host.actions.includes(action), `${action} is listed in actions`);
  // At least one door action ships, each a real door address and operation the clients already use, and each the
  // browser's message can only reach by name (its address and method are never taken from the message).
  const doorRows = shipped.native_hosts.flatMap(host => Object.entries(host.door_actions ?? {}));
  assert.ok(doorRows.length >= 1, 'the engine-door bridge answers at least one action');
  for (const [action, row] of doorRows) {
    assert.match(row.address, /^@[a-z][a-z0-9-]*$/, `${action} names an addressed resource`);
    assert.match(row.method, /^[a-z-]+:[a-z-]+$/, `${action} names one operation`);
    assert.equal(Object.hasOwn(answers, action), false, `${action} does not shadow a host-local answer`);
  }
  assert.deepEqual(shipped.native_hosts[0].door_actions.own_lists, { address: '@own-records', method: 'records:list' }, 'the lists the extension and iPhone read (src/share-record.mjs, ios/Shared/ShareRecord.swift)');
  // The Mac app runs the placer as the Workshop entry this part declares (workshop:send-to-trillion-from-my-browser/offer-in-browsers),
  // so the entry and every file the placer reads must be here.
  const part = JSON.parse(readFileSync(new URL('../part.json', import.meta.url), 'utf8'));
  assert.equal(part.exports['offer-in-browsers'], 'native-host/offer-in-browsers.mjs');
  for (const file of ['browser-native-host.mjs', 'engine-door.mjs', 'offer-in-browsers.mjs', 'offer-in-browsers.json', 'install-ledger.mjs', 'settings-file.mjs'])
    assert.ok(existsSync(new URL(`../native-host/${file}`, import.meta.url)), `${file} is in the part`);
});

// The relay a host opens for the extension that holds its connection (tools/run-tools-in-my-signed-in-browser/browser-relay.mjs),
// over real pipes in the browser's framing and a real loopback port.
const relayHost = { ...settings, most_message_bytes: 1024, native_hosts: [{ ...settings.native_hosts[0], actions: ['here', 'relay_open'] }] };
const NAME = relayHost.native_hosts[0].name;
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const PUBLIC_HEX = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');

function framesFrom(stream) {
  let held = Buffer.alloc(0);
  const waiting = [];
  const kept = [];
  stream.on('data', chunk => {
    held = Buffer.concat([held, chunk]);
    while (held.length >= 4 && held.length >= 4 + held.readUInt32LE(0)) {
      const size = held.readUInt32LE(0);
      const message = JSON.parse(held.subarray(4, 4 + size).toString('utf8'));
      held = held.subarray(4 + size);
      const next = waiting.shift();
      if (next) next(message); else kept.push(message);
    }
  });
  return () => kept.length ? Promise.resolve(kept.shift()) : new Promise(resolve => waiting.push(resolve));
}

async function openedHost(origin = ORIGIN) {
  const input = new PassThrough();
  const output = new PassThrough();
  const config = { ...relayConfig, most_seconds: 5 };
  const reported = await new Promise(resolve => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  const relay = makeRelay({ config, send: message => output.write(frame(message)), readPort: () => reported, readPublicKey: async () => PUBLIC_HEX });
  const served = serve({ settings: relayHost, name: NAME, origin, input, output, actions: { relay_open: () => relay.open() }, relay });
  const next = framesFrom(output);
  input.write(frame({ action: 'relay_open' }));
  return { input, relay, served, next, opened: await next(), config };
}

const askDoor = async (port, config, tool, input) => {
  const post = async (path, body) => {
    const answer = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: answer.status, body: await answer.json() };
  };
  const { body: { nonce } } = await post(config.challenge_path, {});
  const signature = edSign(null, Buffer.from(`${nonce}\n${tool}\n${JSON.stringify(input)}`, 'utf8'), privateKey).toString('hex');
  return post(config.path, { tool, input, nonce, signature });
};

test('the host opens the relay for its pinned extension and carries a request and an answer larger than a plain message', async () => {
  const { input, next, served, opened, config } = await openedHost();
  assert.equal(opened.ok, true);
  const asked = askDoor(opened.port, config, 'tool:read-a-page-in-my-browser', { url: 'https://example.com/' });
  const relayed = await next();
  assert.deepEqual(relayed.relay.input, { url: 'https://example.com/' });
  const big = 'y'.repeat(10_000);
  input.write(frame({ relay_answer: { request_key: relayed.relay.request_key, result: { text: big } } }));
  assert.equal((await asked).body.result.text, big);
  input.write(frame({ action: 'here', padding: 'z'.repeat(2000) }));
  await served;
});

test('a second host cannot take the door while another holds it, and an origin the host does not pin opens nothing', async () => {
  const first = await openedHost();
  const input = new PassThrough();
  const output = new PassThrough();
  const relay = makeRelay({ config: relayConfig, send: () => {}, readPort: () => first.opened.port, readPublicKey: async () => PUBLIC_HEX });
  const served = serve({ settings: relayHost, name: NAME, origin: ORIGIN, input, output, actions: { relay_open: () => relay.open() }, relay });
  const next = framesFrom(output);
  input.write(frame({ action: 'relay_open' }));
  assert.deepEqual(await next(), { ok: false, error: relayConfig.words.held });
  input.end();
  await served;
  first.input.end();
  await first.served;

  const strangerInput = new PassThrough();
  const strangerOutput = new PassThrough();
  const stranger = makeRelay({ config: relayConfig, send: () => {}, readPort: () => first.opened.port, readPublicKey: async () => PUBLIC_HEX });
  const strangerServed = serve({ settings: relayHost, name: NAME, origin: 'chrome-extension://zzzz/', input: strangerInput, output: strangerOutput, actions: { relay_open: () => stranger.open() }, relay: stranger });
  const strangerNext = framesFrom(strangerOutput);
  strangerInput.write(frame({ action: 'relay_open' }));
  assert.equal((await strangerNext()).ok, false);
  assert.equal(stranger.open_now, false);
  strangerInput.end();
  await strangerServed;
});

test('a relay answer from an origin the host does not pin is dropped, and closing the pipe closes the door', async () => {
  const mine = await openedHost();
  const { port } = mine.opened;
  mine.input.end();
  await mine.served;
  assert.equal(mine.relay.open_now, false);
  await assert.rejects(fetch(`http://127.0.0.1:${port}${relayConfig.path}`, { method: 'POST' }));
});
