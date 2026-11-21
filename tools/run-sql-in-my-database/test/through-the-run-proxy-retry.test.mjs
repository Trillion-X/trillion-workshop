// The tunnel to a database is asked for again only while it has not opened: a 502 from the run's proxy, then a 200, opens it; five
// 502s fail with the proxy's own words; a tunnel that opened is never asked for twice.
import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { OPEN_WAITS_MS, throughProxy } from '../do-work/through-the-run-proxy.mjs';

const QUICK = { waits: [5, 5, 5, 5] };

// A stand-in proxy answering each CONNECT with the next of `statuses` (the last repeats); on a 200 it echoes what the client sends.
async function proxyAnswering(statuses) {
  const asked = [];
  const server = net.createServer(client => {
    client.once('data', head => {
      asked.push(head.toString('latin1').split(' ')[1]);
      const status = statuses[Math.min(asked.length - 1, statuses.length - 1)];
      if (status !== 200) return client.end(`HTTP/1.1 ${status} Nope\r\n\r\n`);
      client.write('HTTP/1.1 200 Connection established\r\n\r\n');
      client.on('data', data => client.write(data));
    });
    client.on('error', () => {});
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { asked, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const opened = (stream, port = 5432, host = 'db.example.test') => new Promise((done, failed) => {
  stream.once('connect', () => done(stream));
  stream.once('error', failed);
  stream.connect(port, host);
});

test('a 502 and then a 200 opens the tunnel, and the bytes go through it', async () => {
  const proxy = await proxyAnswering([502, 200]);
  try {
    const stream = await opened(throughProxy(proxy.url, QUICK)());
    const echoed = new Promise(done => stream.once('data', done));
    stream.write('hello');
    assert.equal((await echoed).toString(), 'hello');
    assert.deepEqual(proxy.asked, ['db.example.test:5432', 'db.example.test:5432']);
    stream.destroy();
  } finally { proxy.close(); }
});

test('five 502s fail with the same words as one', async () => {
  const proxy = await proxyAnswering([502]);
  try {
    await assert.rejects(opened(throughProxy(proxy.url, QUICK)()), /the run's proxy did not open db\.example\.test:5432 \(answered 502\)/);
    assert.equal(proxy.asked.length, 5);
  } finally { proxy.close(); }
});

test('a refusal is not asked again', async () => {
  const proxy = await proxyAnswering([403]);
  try {
    await assert.rejects(opened(throughProxy(proxy.url, QUICK)()), /\(answered 403\)/);
    assert.equal(proxy.asked.length, 1);
  } finally { proxy.close(); }
});

test('a proxy port that refuses the connection is asked again, then the proxy answers', async () => {
  const proxy = await proxyAnswering([200]);
  const port = Number(new URL(proxy.url).port);
  proxy.close();
  await new Promise(done => setTimeout(done, 20));
  const again = net.createServer(client => { client.once('data', () => client.write('HTTP/1.1 200 Connection established\r\n\r\n')); });
  const stream = throughProxy(`http://127.0.0.1:${port}`, { waits: [100, 100, 100, 100] })();
  const result = opened(stream);
  setTimeout(() => again.listen(port, '127.0.0.1'), 150);
  try { await result; stream.destroy(); } finally { again.close(); }
});

test('a tunnel that opened and then ended is never asked for again', async () => {
  const asked = [];
  const server = net.createServer(client => {
    client.once('data', head => { asked.push(head); client.write('HTTP/1.1 200 Connection established\r\n\r\n', () => client.end()); });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const stream = await opened(throughProxy(`http://127.0.0.1:${server.address().port}`, QUICK)());
    await new Promise(done => { stream.on('close', done); stream.resume(); });
    await new Promise(done => setTimeout(done, 50));
    assert.equal(asked.length, 1);
  } finally { server.close(); }
});

test('the default waits are five tries over about a minute', () => {
  assert.equal(OPEN_WAITS_MS.length + 1, 5);
  assert.ok(OPEN_WAITS_MS.reduce((sum, wait) => sum + wait, 0) >= 55000 && OPEN_WAITS_MS.reduce((sum, wait) => sum + wait, 0) <= 65000);
});
