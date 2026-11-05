// test/egress-relay.test.mjs
// This Mac relays a cloud AI's streams over one authenticated link: private targets refused after resolution, one owner
// per link, streams relayed both ways (F-0236, F-0906).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { WebSocketServer } from 'ws';
import { blockedRange, decideOpen, decodeFrame, egressRelaySettings, encodeFrame, makeEgressRelay } from '../egress-relay.mjs';

const settings = egressRelaySettings();
const F = settings.frames;
const waitFor = async (done, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await done()) return true; await new Promise(r => setTimeout(r, 10)); } return false; };

test('private and reserved addresses are blocked, public ones pass, the named range is said', () => {
  for (const address of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '100.64.0.9', '::1', 'fe80::1', '::ffff:10.0.0.1', '192.168.1.5']) assert.ok(blockedRange(address), address);
  assert.equal(blockedRange('93.184.216.34'), null);
  assert.equal(blockedRange('2606:4700::1111'), null);
  assert.equal(blockedRange('169.254.169.254').why, 'link-local and cloud metadata');
});

test('a name is resolved first and refused if any answer is private; the allowed list and unresolved names refuse in words', async () => {
  const resolve = name => ({ rebinding: [{ address: '93.184.216.34' }, { address: '10.0.0.7' }], fine: [{ address: '93.184.216.34' }], gone: [] }[name]);
  assert.equal((await decideOpen({ host: 'fine', port: 443 }, settings, resolve)).address, '93.184.216.34');
  assert.match((await decideOpen({ host: 'rebinding', port: 443 }, settings, resolve)).why, /private or reserved address \(private\)/);
  assert.match((await decideOpen({ host: 'gone', port: 443 }, settings, resolve)).why, /could not be found/);
  assert.match((await decideOpen({ host: 'fine', port: 443 }, { ...settings, allowed_hosts: ['intranet.example'] }, resolve)).why, /not on the list/);
});

test('frames round-trip', () => {
  assert.deepEqual(decodeFrame(encodeFrame(F.open, 7, { host: 'example.com', port: 443 })), { kind: F.open, stream: 7, port: 443, host: 'example.com' });
  assert.equal(decodeFrame(encodeFrame(F.data, 7, Buffer.from('hi'))).bytes.toString(), 'hi');
  assert.deepEqual(decodeFrame(encodeFrame(F.close, 9)), { kind: F.close, stream: 9 });
});

async function withBox(run, policy) {
  const echo = createServer(socket => socket.on('data', chunk => socket.write(Buffer.concat([Buffer.from('echo:'), chunk]))));
  await new Promise(done => echo.listen(0, '127.0.0.1', done));
  const box = new WebSocketServer({ port: 0 });
  const received = [];
  const headers = [];
  box.on('connection', (ws, request) => { headers.push(request.headers); ws.on('message', bytes => received.push(decodeFrame(bytes))); });
  await new Promise(done => box.on('listening', done));
  const url = `ws://127.0.0.1:${box.address().port}`;
  const relay = makeEgressRelay({ settings: { ...settings, ...policy }, connect: extra => new WebSocket(url, { headers: { authorization: 'Bearer test-key', ...extra } }) });
  relay.start();
  try { await run({ box, echo, received, headers, relay, port: echo.address().port }); } finally { relay.stop(); box.close(); echo.close(); }
}

test('a stream to a private target is refused with a close frame by default; the link stays up', async () => {
  await withBox(async ({ box, received, relay, port }) => {
    assert.ok(await waitFor(() => box.clients.size === 1));
    [...box.clients][0].send(encodeFrame(F.open, 1, { host: '127.0.0.1', port }));
    assert.ok(await waitFor(() => received.some(frame => frame?.kind === F.close && frame.stream === 1)));
    assert.equal(relay.state.refused, 1);
    assert.equal(relay.state.link, 'up');
    console.log('readback refused', JSON.stringify({ refused: relay.state.refused, link: relay.state.link }));
  }, {});
});

test('with private targets allowed (an explicit setting) a stream is relayed both ways, and the bearer key arrives as a header only', async () => {
  await withBox(async ({ box, received, headers, port }) => {
    assert.ok(await waitFor(() => box.clients.size === 1));
    const ws = [...box.clients][0];
    ws.send(encodeFrame(F.open, 2, { host: '127.0.0.1', port }));
    await new Promise(r => setTimeout(r, 50));
    ws.send(encodeFrame(F.data, 2, Buffer.from('ping')));
    assert.ok(await waitFor(() => received.some(frame => frame?.kind === F.data && frame.bytes.toString() === 'echo:ping')));
    assert.equal(headers[0].authorization, 'Bearer test-key');
    assert.equal(headers[0]['x-egress-attach'], 'claim');
    console.log('readback relayed', received.filter(Boolean).map(frame => frame.bytes?.toString()).filter(Boolean).join(','));
  }, { allow_private_targets: true });
});

test('a link another computer holds is stood by on and retried as if-free', async () => {
  const sockets = [];
  const modes = [];
  const connect = headers => {
    modes.push(headers['x-egress-attach']);
    const target = new EventTarget();
    target.send = () => {}; target.close = () => {};
    sockets.push(target);
    return target;
  };
  const timers = { setTimeout: (fn) => { queueMicrotask(fn); return 1; }, clearTimeout: () => {} };
  const relay = makeEgressRelay({ connect, attach: 'if-free', settings, timers });
  relay.start();
  const closed = code => { const event = new Event('close'); event.code = code; sockets.at(-1).dispatchEvent(event); };
  closed(4002);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(relay.state.link, 'connecting');
  assert.deepEqual(modes, ['if-free', 'if-free']);
  sockets.at(-1).dispatchEvent(new Event('open'));
  assert.equal(relay.state.link, 'up');
  relay.stop();
});
