// The check reports what the host DECIDED: a 101 is an open lane, any other
// status is a refusal carrying that status, a socket closed with no answer is a
// refusal too, and only a host that cannot be reached at all is unreachable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { checkLiveUpdateLane } from '../tools/serve-and-publish-a-package-sets-public-app/processes/check-the-live-update-lane-answers.mjs';

async function hostThat(behave) {
  const server = http.createServer((_request, response) => response.writeHead(404, 'Not Found').end('page'));
  server.on('upgrade', behave);
  const sockets = new Set();
  server.on('connection', (socket) => sockets.add(socket));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { address: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => { server.close(done); for (const socket of sockets) socket.destroy(); }) };
}

test('an accepted upgrade is an open lane', async () => {
  const host = await hostThat((request, socket) => {
    assert.equal(request.headers.upgrade, 'websocket');
    assert.equal(request.headers['sec-websocket-version'], '13');
    assert.equal(request.url, '/ws');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  const result = await checkLiveUpdateLane(host.address);
  assert.deepEqual(result, { lane: 'open', reached: true, status: 101, first_line: 'HTTP/1.1 101 Switching Protocols' });
  await host.close();
});

test('a plain answer is a refusal with its status and first line', async () => {
  const host = await hostThat((_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'));
  const result = await checkLiveUpdateLane(host.address, { path: '/ws' });
  assert.deepEqual(result, { lane: 'refused', reached: true, status: 403, first_line: 'HTTP/1.1 403 Forbidden' });
  await host.close();
});

test('a socket closed with no answer is a refusal', async () => {
  const host = await hostThat((_request, socket) => socket.destroy());
  const result = await checkLiveUpdateLane(host.address);
  assert.deepEqual(result, { lane: 'refused', reached: true, detail: 'closed without answering' });
  await host.close();
});

test('a host nobody answers for is unreachable', async () => {
  const probe = net.createServer();
  await new Promise((done) => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address();
  await new Promise((done) => probe.close(done));
  const result = await checkLiveUpdateLane(`http://127.0.0.1:${port}`);
  assert.equal(result.lane, 'unreachable');
  assert.equal(result.reached, false);
});

test('a host that never answers is no answer after the timeout', async () => {
  const host = await hostThat(() => {});
  const result = await checkLiveUpdateLane(host.address, { timeoutMs: 200 });
  assert.deepEqual(result, { lane: 'no answer', reached: false, detail: 'no answer within 200ms' });
  await host.close();
});

test('an address that is not http or https is refused', async () => {
  await assert.rejects(checkLiveUpdateLane('ftp://example.com'), /http or https/);
});
