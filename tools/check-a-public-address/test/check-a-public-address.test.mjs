// tools/check-a-public-address/test/check-a-public-address.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAddress, readPath, judge } from '../do-work/check-a-public-address.mjs';
import { nodePublicFetch } from '../../http-client/do-work/node-public-fetch.mjs';

// A fetch stand-in that answers with the given status, content type and body; no network.
const answering = (status, body, contentType = 'text/html; charset=utf-8') => async () =>
  new Response(body, { status, headers: { 'content-type': contentType } });

test('a 200 with every marker passes', async () => {
  const page = '<html><script type="application/ld+json">{"@type":"WebSite"}</script><h1>Hello</h1></html>';
  const result = await checkAddress({
    input: { url: 'https://page.example/', expect: { status: 200, contains: ['application/ld+json', 'WebSite', '<h1>Hello</h1>'] } },
    fetchImpl: answering(200, page),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failed, []);
  assert.equal(result.status, 200);
  assert.equal(result.content_type, 'text/html; charset=utf-8');
  assert.equal(result.body_bytes, Buffer.byteLength(page));
  assert.equal(result.excerpt, page);
});

test('a missing marker fails and names the marker', async () => {
  const result = await checkAddress({
    input: { url: 'https://page.example/', expect: { status: 200, contains: ['WebSite', 'Course'] } },
    fetchImpl: answering(200, '<html>WebSite only</html>'),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ['contains:Course']);
});

test('a wrong status fails and names status', async () => {
  const result = await checkAddress({
    input: { url: 'https://page.example/', expect: { status: 200 } },
    fetchImpl: answering(404, 'not here'),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ['status']);
});

test('json_path equals passes on the matching value', async () => {
  const body = JSON.stringify({ clips: [{ kind: 'article' }, { kind: 'comparison' }] });
  const result = await checkAddress({
    input: { url: 'https://page.example/api', expect: { status: 200, json_path: '$.clips[1].kind', equals: 'comparison' } },
    fetchImpl: answering(200, body, 'application/json'),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.failed, []);
});

test('json_path equals fails on a different value', async () => {
  const body = JSON.stringify({ clips: [{ kind: 'article' }] });
  const result = await checkAddress({
    input: { url: 'https://page.example/api', expect: { json_path: '$.clips[0].kind', equals: 'comparison' } },
    fetchImpl: answering(200, body, 'application/json'),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ['equals']);
});

test('a json_path that is missing fails and names json_path', async () => {
  const body = JSON.stringify({ clips: [] });
  const result = await checkAddress({
    input: { url: 'https://page.example/api', expect: { json_path: '$.clips[13].kind', equals: 'comparison' } },
    fetchImpl: answering(200, body, 'application/json'),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ['json_path']);
});

test('a json_path on a body that is not JSON fails and names json_path', async () => {
  const result = await checkAddress({
    input: { url: 'https://page.example/api', expect: { json_path: '$.clips' } },
    fetchImpl: answering(200, '<html>not json</html>'),
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ['json_path']);
});

test('a private address is refused before any connection', async () => {
  let connected = false;
  const guarded = nodePublicFetch({ request: () => { connected = true; throw new Error('must not connect'); } });
  const result = await checkAddress({ input: { url: 'https://localhost/' }, fetchImpl: guarded });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ['request']);
  assert.equal(typeof result.error, 'string');
  assert.equal(connected, false);
});

test('readPath reads dotted and indexed steps and reports a missing step', () => {
  const value = { a: [{ b: 'x' }] };
  assert.deepEqual(readPath(value, '$.a[0].b'), { found: true, value: 'x' });
  assert.deepEqual(readPath(value, '$.a[1].b'), { found: false, value: undefined });
  assert.throws(() => readPath(value, 'a.b'), /start with \$/);
});

test('judge with no expectations passes any answer', () => {
  assert.deepEqual(judge({}, { status: 500, body: '' }), []);
});
