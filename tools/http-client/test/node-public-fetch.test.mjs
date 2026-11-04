import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { nodePublicFetch } from '../do-work/node-public-fetch.mjs';

const publicAnswers = async () => [{ address: '93.184.216.34', family: 4 }];
function transport(answer, calls) {
  return (url, options, receive) => {
    const req = new EventEmitter();
    req.destroy = error => { if (error) queueMicrotask(() => req.emit('error', error)); };
    req.end = () => options.lookup(url.hostname, { all: true }, (error, addresses) => {
      if (error) { req.destroy(error); return; }
      calls.push({ url, options, addresses });
      const result = answer(url, options);
      const stream = Readable.from([Buffer.from(result.body ?? '{}')]);
      stream.statusCode = result.status ?? 200;
      stream.headers = result.headers ?? { 'content-type': 'application/json' };
      stream.rawHeaders = Object.entries(stream.headers).flat();
      receive(stream);
    });
    return req;
  };
}

test('Node public fetch uses the checked DNS answers on its actual connection and preserves TLS verification', async () => {
  const calls = [];
  const fetch = nodePublicFetch({ resolve: publicAnswers, request: transport(() => ({ body: '{"public":true}' }), calls) });
  const response = await fetch('https://metadata.example/client.json', { headers: { host: '127.0.0.1' } });
  assert.deepEqual(await response.json(), { public: true });
  assert.deepEqual(calls[0].addresses, await publicAnswers());
  assert.equal(calls[0].options.agent, false);
  assert.equal(calls[0].options.rejectUnauthorized, true);
  assert.equal(calls[0].options.headers.host, undefined);
});

test('literal, resolved, mixed and redirect private addresses are refused before a private connection', async () => {
  for (const address of ['https://127.0.0.1/client', 'https://2130706433/client', 'https://169.254.169.254/client', 'https://[::ffff:127.0.0.1]/client']) {
    const calls = []; const fetch = nodePublicFetch({ resolve: publicAnswers, request: transport(() => ({}), calls) });
    await assert.rejects(fetch(address)); assert.equal(calls.length, 0);
  }
  for (const answers of [[{ address: '127.0.0.1', family: 4 }], [{ address: '93.184.216.34', family: 4 }, { address: '10.1.1.1', family: 4 }]]) {
    const calls = []; const fetch = nodePublicFetch({ resolve: async () => answers, request: transport(() => ({}), calls) });
    await assert.rejects(fetch('https://metadata.example/client.json')); assert.equal(calls.length, 0);
  }
  const calls = []; const fetch = nodePublicFetch({ resolve: publicAnswers, request: transport(() => ({ status: 302, headers: { location: 'https://127.0.0.1/private' } }), calls) });
  await assert.rejects(fetch('https://metadata.example/client.json')); assert.equal(calls.length, 1);
});

test('redirects drop credentials across origins, and decoded bodies and time are bounded', async () => {
  const calls = []; const fetch = nodePublicFetch({ resolve: publicAnswers, request: transport(url => url.hostname === 'metadata.example'
    ? { status: 302, headers: { location: 'https://public.example/client.json' } } : {}, calls) });
  await fetch('https://metadata.example/client.json', { headers: { authorization: 'Bearer synthetic-only', cookie: 'synthetic=only' } });
  assert.equal(calls[1].options.headers.authorization, undefined); assert.equal(calls[1].options.headers.cookie, undefined);
  const compressed = nodePublicFetch({ resolve: publicAnswers, maxBytes: 1024,
    request: transport(() => ({ body: gzipSync(Buffer.alloc(2048)), headers: { 'content-encoding': 'gzip' } }), []) });
  await assert.rejects(compressed('https://metadata.example/client.json'), /too large/);
  const stalled = nodePublicFetch({ timeoutMs: 10, request: () => {
    const req = new EventEmitter(); req.end = () => {}; req.destroy = error => req.emit('error', error); return req;
  } });
  await assert.rejects(stalled('https://metadata.example/client.json'), /timed out/);
});
