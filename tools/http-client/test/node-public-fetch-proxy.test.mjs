// tools/http-client/test/node-public-fetch-proxy.test.mjs
// Through the run's proxy: a public name is reached with CONNECT to the proxy, and a private name is refused before any CONNECT.
// The live case reads a real public page and runs only with PUBLIC_FETCH_LIVE=1 (it needs the network).
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { nodePublicFetch } from '../do-work/node-public-fetch.mjs';

// A CONNECT proxy that counts each CONNECT and tunnels it to its target.
function startProxy() {
  const seen = [];
  const server = net.createServer(client => {
    let head = Buffer.alloc(0);
    client.on('data', function onHead(chunk) {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.off('data', onHead);
      const [method, target] = head.subarray(0, end).toString().split('\r\n')[0].split(' ');
      seen.push({ method, target });
      if (method !== 'CONNECT') { client.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n'); return; }
      const [host, port] = target.split(':');
      const upstream = net.connect(Number(port), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const rest = head.subarray(end + 4);
        if (rest.length) upstream.write(rest);
        upstream.pipe(client); client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close(),
  })));
}

test('a private or local name is refused before any CONNECT reaches the proxy', async () => {
  const proxy = await startProxy();
  try {
    const fetch = nodePublicFetch({ proxy: proxy.url });
    for (const address of ['https://127.0.0.1/', 'https://10.0.0.5/', 'https://printer.local/', 'https://localhost/', 'https://169.254.169.254/']) {
      await assert.rejects(fetch(address));
    }
    assert.deepEqual(proxy.seen, []);
  } finally { proxy.close(); }
});

test('a public name is asked through CONNECT to the proxy, on the name and port 443', { skip: process.env.PUBLIC_FETCH_LIVE !== '1' }, async () => {
  const proxy = await startProxy();
  try {
    const response = await nodePublicFetch({ proxy: proxy.url })('https://example.com/');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Example Domain/);
    assert.deepEqual(proxy.seen, [{ method: 'CONNECT', target: 'example.com:443' }]);
  } finally { proxy.close(); }
});
