import { tempFolder } from '../../../test-helpers/temp-folder.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { proxyRuntimeHttp, proxyRuntimeUpgradeTo } from '../processes/runtime-upstream-transport.mjs';

async function listen(server, target) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(target, resolve);
  });
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

test('one front door can proxy two customer sockets without mixing their answers', async () => {
  const root = tempFolder(join(tmpdir(), 'bitfield-customer-sockets-'));
  const adaSocket = join(root, 'ada.sock');
  const boSocket = join(root, 'bo.sock');
  const ada = http.createServer((req, res) => res.end(`ada:${req.url}`));
  const bo = http.createServer((req, res) => res.end(`bo:${req.url}`));
  const front = http.createServer((req, res) => {
    const socketPath = req.headers['x-fixture-principal'] === 'ada' ? adaSocket : boSocket;
    void proxyRuntimeHttp(req, res, { socketPath }, 'http://127.0.0.1:1');
  });
  try {
    await Promise.all([listen(ada, adaSocket), listen(bo, boSocket)]);
    await listen(front, 0);
    const base = `http://127.0.0.1:${front.address().port}`;
    const answer = async (principal) => {
      const response = await fetch(`${base}/conversation?current=1`, {
        headers: { 'x-fixture-principal': principal },
      });
      assert.equal(response.status, 200);
      return response.text();
    };
    assert.equal(await answer('ada'), 'ada:/conversation?current=1');
    assert.equal(await answer('bo'), 'bo:/conversation?current=1');
  } finally {
    await Promise.all([close(front), close(ada), close(bo)]);
    rmSync(root, { recursive: true, force: true });
  }
});

test('a live-feed upgrade reaches the selected customer socket', async () => {
  const root = tempFolder(join(tmpdir(), 'bitfield-customer-upgrade-'));
  const socketPath = join(root, 'customer.sock');
  const backend = net.createServer((socket) => {
    socket.once('data', (request) => {
      assert.match(request.toString(), /^GET \/ws HTTP\/1\.1\r\n/);
      socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    });
  });
  const front = http.createServer();
  front.on('upgrade', (req, socket, head) => {
    proxyRuntimeUpgradeTo(null, req, socket, head, socketPath);
  });
  try {
    await listen(backend, socketPath);
    await listen(front, 0);
    const answer = await new Promise((resolve, reject) => {
      const client = net.connect(front.address().port, '127.0.0.1', () => {
        client.write('GET /ws HTTP/1.1\r\nHost: app.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      });
      let text = '';
      client.on('data', (chunk) => { text += chunk.toString(); });
      client.on('end', () => resolve(text));
      client.on('error', reject);
    });
    assert.match(answer, /^HTTP\/1\.1 101 Switching Protocols/);
  } finally {
    await Promise.all([close(front), close(backend)]);
    rmSync(root, { recursive: true, force: true });
  }
});
